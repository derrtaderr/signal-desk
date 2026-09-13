#!/usr/bin/env node
// Regenerates fixtures/approvals.json, the human decisions the demo corpus ships with.
// Run with `node scripts/record-approvals.mjs`.
//
// WHY THIS IS GENERATED, when M1's version was hand-written.
//
// M1 keyed approvals by LEAD ID, which made the file trivially authorable by hand and made the
// decisions worthless as authorisations. The M1 review demonstrated it: one recorded approval
// released a second draft the human had never seen, because the lead id had not changed.
//
// M2 binds every decision to a DRAFT-CONTENT HASH. That is the fix, and it also means the file
// can no longer be hand-written, because the hash moves whenever the draft moves. So the
// authored part — who decided what, when, and why — lives in the DECISIONS table below, and
// the binding is computed. Exactly the same arrangement as fixtures/rubric.json.
//
// A decision left in this table whose draft no longer exists simply does not bind to anything,
// which is the correct outcome and the one the queue stage reports as AWAITING_APPROVAL.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES_DIR } from '../src/runner.mjs';
import { composeDrafts, serializeFixture } from './draft-corpus.mjs';

// The authored half: decisions humans made, keyed by the contact the draft is written to.
// A lead absent from this table has no decision on record and parks, which is what the demo
// needs in order to show a lead waiting for a person.
const DECISIONS = {
  'dana@acme.test': {
    decision: 'approve',
    by: 'dana.reviewer',
    at: '2026-03-01T08:56:00.000Z',
  },
  'robin@globex.test': {
    decision: 'reject',
    by: 'dana.reviewer',
    at: '2026-03-01T08:56:30.000Z',
    note: 'already in an open opportunity, do not touch',
  },
  // sam@northwind.test is deliberately absent, so the demo always shows one lead parked.
};

export async function recordApprovals() {
  const drafts = await composeDrafts();
  const records = [];

  for (const draft of drafts) {
    const decision = DECISIONS[draft.to];
    if (decision === undefined) continue;

    // draft_hash first, because it is what the decision BINDS to. lead_id is recorded beside
    // it so a hand-edited store cannot quietly move a decision to another person; the queue
    // stage checks both and refuses APPROVAL_LEAD_MISMATCH when they disagree.
    records.push({
      draft_hash: draft.draft_hash,
      lead_id: draft.lead_id,
      ...decision,
    });
  }

  return records.sort((a, b) => (a.draft_hash < b.draft_hash ? -1 : 1));
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const records = await recordApprovals();
  writeFileSync(join(FIXTURES_DIR, 'approvals.json'), serializeFixture(records));

  console.log('wrote fixtures/approvals.json');
  for (const record of records) {
    console.log(`  ${record.decision.padEnd(7)} ${record.draft_hash}  ${record.lead_id}`);
  }
}
