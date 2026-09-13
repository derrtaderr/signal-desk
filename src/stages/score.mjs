// Stage 3 — score.
//
// Discipline enforced: every score decomposes into named factors, each carrying its points,
// the reason it fired, and the evidence it rests on. There is no black-box number anywhere,
// and the total is exactly the sum of the parts, so a reader can always reconstruct it.
//
// A factor built on an uncited claim is still allowed to influence routing, but it says so.
// Routing on a self-asserted title is a defensible judgement; presenting it as evidence is not.

import { pass, refuse } from '../contract.mjs';

function claimOf(lead, field) {
  return lead.claims.find((c) => c.field === field);
}

function evidenceOf(claim) {
  return claim?.cited && claim.citation ? [claim.citation] : [];
}

export const score = {
  name: 'score',

  run(lead, ctx) {
    const config = ctx.config.score ?? {};
    const seniorTitles = config.seniorTitles ?? [];
    const highIntentPages = config.highIntentPages ?? [];
    const band = config.employeeBand ?? { min: 0, max: Infinity };

    const factors = [];

    const title = claimOf(lead, 'contact_title');
    if (title !== undefined) {
      const normalised = String(title.value).toLowerCase();
      const matched = seniorTitles.find((t) => normalised.includes(t));
      factors.push({
        name: 'title_seniority',
        points: matched ? 30 : 5,
        reason: matched
          ? `title "${title.value}" matches the senior marker "${matched}"`
          : `title "${title.value}" matches no senior marker`,
        evidence_refs: evidenceOf(title),
        cited: Boolean(title.cited),
      });
    }

    const employees = claimOf(lead, 'employee_count');
    if (employees !== undefined) {
      const count = Number(employees.value);
      const inBand = count >= band.min && count <= band.max;
      factors.push({
        name: 'employee_band',
        points: inBand ? 25 : 0,
        reason: inBand
          ? `${count} employees falls inside the ${band.min}-${band.max} band`
          : `${count} employees falls outside the ${band.min}-${band.max} band`,
        evidence_refs: evidenceOf(employees),
        cited: Boolean(employees.cited),
      });
    }

    const page = claimOf(lead, 'intent_page');
    if (page !== undefined) {
      const high = highIntentPages.includes(page.value);
      factors.push({
        name: 'intent_page',
        points: high ? 25 : 5,
        reason: high
          ? `${page.value} is a high-intent page`
          : `${page.value} is not on the high-intent list`,
        evidence_refs: evidenceOf(page),
        cited: Boolean(page.cited),
      });
    }

    const visits = claimOf(lead, 'intent_visits');
    if (visits !== undefined) {
      const count = Number(visits.value);
      const points = Math.min(count, 5) * 4;
      factors.push({
        name: 'intent_depth',
        points,
        reason: `${count} visits, counted up to a cap of 5`,
        evidence_refs: evidenceOf(visits),
        cited: Boolean(visits.cited),
      });
    }

    if (factors.length === 0) {
      return refuse({
        reason: 'UNSCOREABLE',
        detail: 'no claim on this lead feeds any configured factor, so a total would be a guess',
      });
    }

    factors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const total = factors.reduce((sum, f) => sum + f.points, 0);

    return pass({
      output: { ...lead, score: { total, factors } },
      evidence_refs: factors.flatMap((f) => f.evidence_refs),
    });
  },
};
