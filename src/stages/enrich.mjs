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

// --- identity verification -------------------------------------------------------------
//
// Whether the human this signal names is the human the evidence describes.
//
// Vendor-side identity resolution is probabilistic. A shared office IP, a stale record, or
// somebody who changed jobs last quarter all produce a signal correctly attributed to a
// company and wrongly attributed to a person, and until M3 nothing here looked.
//
// It runs FIRST, before any claim source. A person the evidence contradicts should not consume
// the claim fetches, and the trail then reads the way a human reasons about it: who is this,
// and only then what do we know about them.
//
// Three outcomes, and the third is the one worth arguing about. Confirmed proceeds and says so.
// CONTRADICTED refuses. Anything else — no source configured, no recording, a non-200, a body
// with no identity block — proceeds and is reported as UNVERIFIED.
//
// That third outcome is not a fail-open, and the distinction is checkable rather than a matter
// of trust. Fail-closed is a rule about GATES THAT CANNOT FORM AN OPINION; enrich is not a gate,
// and a source that does not answer has degraded the evidence rather than refused since M1.
// "We have no identity evidence" is the state every lead in every prior milestone was in.
// Refusing it would be a new product policy, mandatory person-level enrichment on every lead,
// with a cost this milestone has not argued. What fail-closed genuinely requires here is that
// ABSENCE NEVER READS AS CONFIRMATION, and it does not: the ledger says IDENTITY_UNVERIFIED out
// loud, which is the difference between a known gap and an invisible one. The boundary is named
// in the README rather than left to be discovered.

function normaliseName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// What the record and the signal must agree about, and what each disagreement means.
// Named as a table because this table IS the rule.
const IDENTITY_FIELDS = [
  {
    name: 'company_domain',
    claimed: (lead) => lead.company.domain,
    describe: (recorded, claimed) =>
      `the signal places ${claimed} behind this visit and the person record puts them at ${recorded}`,
  },
  {
    name: 'name',
    claimed: (lead) => lead.contact.name,
    describe: (recorded, claimed) =>
      `the signal names ${claimed} and the person record at that address is ${recorded}`,
  },
  {
    name: 'email',
    claimed: (lead) => lead.contact.email,
    // The URL was keyed on the contact's own address, so a record naming a different one is the
    // source answering a question nobody asked.
    describe: (recorded, claimed) =>
      `the person record was fetched for ${claimed} and describes ${recorded}`,
  },
];

async function verifyIdentity(lead, ctx) {
  const template = ctx.config.enrich?.identitySource;
  if (typeof template !== 'string' || template === '') return { entries: [] };

  const url = expand(template, lead);
  const unverified = (why) => ({
    entries: [
      {
        verdict: 'PASS',
        reason_codes: ['IDENTITY_UNVERIFIED'],
        evidence_refs: [url],
        detail:
          `${why}, so nothing confirms this is the right person. Proceeding on the signal's own ` +
          'account of who they are, which is not the same as having checked',
      },
    ],
  });

  let response;
  try {
    response = await ctx.fetch(url);
  } catch (error) {
    return unverified(`${url} had no recording: ${error.message}`);
  }

  if (response.status !== 200) return unverified(`${url} answered ${response.status}`);

  const identity = response.body?.identity;
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    return unverified(`${url} answered 200 and carried no identity record`);
  }

  for (const field of IDENTITY_FIELDS) {
    const recorded = identity[field.name];
    if (recorded === undefined) continue;
    const claimed = field.claimed(lead);
    if (normaliseName(recorded) === normaliseName(claimed)) continue;

    return {
      entries: [],
      refusal: {
        reason: 'IDENTITY_CONTRADICTED',
        evidence_refs: [url],
        detail:
          `${field.describe(recorded, claimed)}. Writing to the wrong human is not a smaller ` +
          'mistake than writing the wrong thing',
      },
    };
  }

  return {
    entries: [
      {
        verdict: 'PASS',
        reason_codes: ['IDENTITY_CONFIRMED'],
        evidence_refs: [url],
        detail: `${url} confirms ${lead.contact.name} at ${lead.company.domain}`,
      },
    ],
  };
}

export const enrich = {
  name: 'enrich',

  async run(lead, ctx) {
    const sources = ctx.config.enrich?.sources ?? [];
    const claims = [];
    const citations = [];
    const entries = [];

    // Identity first. See the block comment above for why the order is part of the rule.
    const identity = await verifyIdentity(lead, ctx);
    entries.push(...identity.entries);
    if (identity.refusal !== undefined) return refuse({ ...identity.refusal, entries });

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
