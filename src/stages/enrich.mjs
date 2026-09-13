// Stage 2 — enrich.
//
// Discipline enforced: every claim binds to a citation fetched in the same run. Claims
// that arrived with the signal are kept, but marked uncited, and the draft stage is barred
// from using them. Pattern adapted from account-scout; no code vendored.
//
// A source that does not answer is skipped, never invented. Enrich is not a gate, so a
// missing source degrades the evidence rather than refusing outright; the refusal comes
// when there is no fetched evidence at all, because there is then nothing to ground a
// draft in.

import { pass, refuse } from '../contract.mjs';

function expand(template, lead) {
  return template
    .replaceAll('{domain}', lead.company.domain)
    .replaceAll('{email}', lead.contact.email);
}

export const enrich = {
  name: 'enrich',

  async run(lead, ctx) {
    const sources = ctx.config.enrich?.sources ?? [];
    const claims = [];
    const citations = [];
    const entries = [];

    for (const template of sources) {
      const url = expand(template, lead);
      let response;

      try {
        response = await ctx.fetch(url);
      } catch (error) {
        entries.push({
          verdict: 'PASS',
          reason_codes: ['SOURCE_UNAVAILABLE'],
          evidence_refs: [url],
          detail: `${url} had no recording: ${error.message}`,
        });
        continue;
      }

      if (response.status !== 200) {
        entries.push({
          verdict: 'PASS',
          reason_codes: ['SOURCE_UNAVAILABLE'],
          evidence_refs: [url],
          detail: `${url} answered ${response.status}`,
        });
        continue;
      }

      citations.push(url);
      for (const [field, value] of Object.entries(response.body?.claims ?? {})) {
        claims.push({ field, value, citation: url, cited: true });
      }
    }

    // Everything the signal asserted about itself. Real, usable for routing, and not
    // evidence, because nothing outside the signal corroborates it.
    for (const [field, value] of [
      ['company_name', lead.company.name],
      ['contact_title', lead.contact.title],
      ['intent_page', lead.intent?.page],
      ['intent_visits', lead.intent?.visits],
    ]) {
      if (value === undefined) continue;
      claims.push({ field, value, citation: null, cited: false });
    }

    if (citations.length === 0) {
      return refuse({
        reason: 'NO_CITED_CLAIMS',
        entries,
        detail: 'no configured source answered, so no claim can be grounded',
      });
    }

    // Sorted, so the ledger bytes never depend on the order the sources answered in.
    claims.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    citations.sort();

    return pass({
      output: { ...lead, claims, citations },
      entries,
      evidence_refs: citations,
    });
  },
};
