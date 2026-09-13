import test from 'node:test';
import assert from 'node:assert/strict';

import { handoff } from '../src/stages/handoff.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { computeDraftHash } from '../src/draft-hash.mjs';

// The approval is BOUND to the draft it authorises. That binding is what handoff re-checks,
// so building a lead means computing the hash rather than asserting a decision floats free.
function lead(overrides = {}) {
  const draft = {
    to: 'dana@acme.test',
    subject: 'Your team and Acme Robotics',
    body: 'Hi Dana,\n\nOpen to a short call?',
    template: 'executive-intro',
    claim_refs: [{ field: 'employee_count', citation: 'https://directory.test/company/acme.test' }],
    ...(overrides.draft ?? {}),
  };
  const draft_hash = computeDraftHash(draft);

  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test' },
    claims: [],
    citations: ['https://directory.test/company/acme.test'],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae-round-robin', play: 'executive-intro', reason: 'x' },
    draft,
    draft_hash,
    gate: { violations: [], rules_run: [] },
    queue: { autonomy_enabled: false, owner: 'ae-round-robin', draft_hash },
    approval: {
      draft_hash,
      lead_id: 'lead-abc123456789',
      decision: 'approve',
      by: 'dana.reviewer',
      at: '2026-03-01T08:55:00.000Z',
    },
    ...overrides,
    ...(overrides.draft ? { draft, draft_hash } : {}),
  };
}

function makeCtx(handoffConfig = { adapter: 'dry-run-json' }) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture', handoff: handoffConfig },
    run_id: 'run-test',
  });
}

test('an approved lead hands off through the reference adapter', async () => {
  const result = await handoff.run(lead(), makeCtx());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.handoff.adapter, 'dry-run-json');
});

test('the handoff artifact carries the message and the lead it belongs to', async () => {
  const { output } = await handoff.run(lead(), makeCtx());
  assert.equal(output.handoff.artifact.to, 'dana@acme.test');
  assert.equal(output.handoff.artifact.subject, 'Your team and Acme Robotics');
  assert.match(output.handoff.artifact.body, /Open to a short call\?/);
  assert.equal(output.handoff.artifact.lead_id, 'lead-abc123456789');
  assert.equal(output.handoff.artifact.run_id, 'run-test');
});

test('the artifact records who approved it, so the export is attributable', async () => {
  const { output } = await handoff.run(lead(), makeCtx());
  assert.equal(output.handoff.artifact.approved_by, 'dana.reviewer');
});

test('the artifact carries the citations behind the claims it makes', async () => {
  const { output } = await handoff.run(lead(), makeCtx());
  assert.deepEqual(output.handoff.artifact.citations, ['https://directory.test/company/acme.test']);
});

test('the artifact is marked dry run and not sent, because this tool never sends', async () => {
  const { output } = await handoff.run(lead(), makeCtx());
  assert.equal(output.handoff.artifact.dry_run, true);
  assert.equal(output.handoff.sent, false);
});

test('handoff returns the artifact rather than writing it, so the stage does no I/O', async () => {
  const result = await handoff.run(lead(), makeCtx());
  assert.equal(typeof result.output.handoff.artifact, 'object');
  assert.equal(result.output.handoff.written_to, undefined);
});

test('an unapproved lead reaching handoff REFUSES rather than exporting', async () => {
  const result = await handoff.run(lead({ approval: undefined }), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['NOT_APPROVED']);
});

test('an unknown adapter REFUSES with UNKNOWN_ADAPTER rather than falling back to a default', async () => {
  const result = await handoff.run(lead(), makeCtx({ adapter: 'smtp' }));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNKNOWN_ADAPTER']);
  assert.match(result.detail, /smtp/);
});

test('the adapter registry carries the two M2 adapters and no transport', async () => {
  const { adapters } = await import('../src/stages/handoff.mjs');
  assert.deepEqual(Object.keys(adapters).sort(), ['dry-run-json', 'eml']);
});

test('the eml adapter is selectable through config, like any other', async () => {
  const result = await handoff.run(lead(), makeCtx({ adapter: 'eml' }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.handoff.adapter, 'eml');
  assert.ok(result.output.handoff.filename.endsWith('.eml'));
});

// --- only approved draft hashes are exportable ----------------------------------------
//
// The teeth on the M1 review's finding. handoff re-checks the binding rather than trusting
// that the queue let this through legitimately, because handoff is the stage that would act.

test('a draft edited after approval REFUSES with APPROVAL_HASH_MISMATCH', async () => {
  const tampered = lead();
  tampered.draft = { ...tampered.draft, body: 'Hi Dana,\n\nSomething nobody approved.' };
  // The approval still names the ORIGINAL draft, which is exactly the real-world shape.

  const result = await handoff.run(tampered, makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['APPROVAL_HASH_MISMATCH']);
  assert.match(result.detail, /only an approved draft is exportable/);
});

test('the mismatch names both hashes, so a reader can see which draft was authorised', async () => {
  const tampered = lead();
  const authorised = tampered.approval.draft_hash;
  tampered.draft = { ...tampered.draft, subject: 'Rewritten' };

  const result = await handoff.run(tampered, makeCtx());
  assert.match(result.detail, new RegExp(authorised));
  assert.match(result.detail, new RegExp(computeDraftHash(tampered.draft)));
});

test('an approval carrying no draft hash at all REFUSES, rather than being taken on trust', async () => {
  const unbound = lead();
  delete unbound.approval.draft_hash;
  const result = await handoff.run(unbound, makeCtx());
  assert.deepEqual(result.reason_codes, ['APPROVAL_HASH_MISMATCH']);
});

test('the artifact is named per lead AND per draft, so a prior export cannot be clobbered', async () => {
  const { output } = await handoff.run(lead(), makeCtx());
  assert.equal(
    output.handoff.filename,
    `lead-abc123456789-${output.handoff.artifact.draft_hash}.json`,
  );
});

test('handoff is deterministic: the same lead exports the same artifact twice', async () => {
  const a = await handoff.run(lead(), makeCtx());
  const b = await handoff.run(lead(), makeCtx());
  assert.deepEqual(a.output.handoff, b.output.handoff);
});
