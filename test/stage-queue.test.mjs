import test from 'node:test';
import assert from 'node:assert/strict';

import { queue } from '../src/stages/queue.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

function lead(overrides = {}) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test' },
    claims: [],
    citations: [],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae', play: 'problem-first', reason: 'x' },
    draft: { to: 'dana@acme.test', subject: 's', body: 'b', template: 'problem-first', claim_refs: [] },
    gate: { violations: [], rules_run: [] },
    ...overrides,
  };
}

function makeCtx(queueConfig = {}) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture', queue: queueConfig },
    run_id: 'run-test',
  });
}

test('with no recorded decision the lead parks for a human', async () => {
  const result = await queue.run(lead(), makeCtx());
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

test('parking is the default even when the gate passed cleanly', async () => {
  const result = await queue.run(lead({ gate: { violations: [], rules_run: ['all'] } }), makeCtx());
  assert.equal(result.status, 'NEEDS_HUMAN');
});

test('a recorded approval lets the lead through to handoff', async () => {
  const ctx = makeCtx({
    approvals: { 'lead-abc123456789': { decision: 'approve', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z' } },
  });
  const result = await queue.run(lead(), ctx);
  assert.equal(result.status, 'PASS');
});

test('an approved lead carries the approval onto its output', async () => {
  const ctx = makeCtx({
    approvals: { 'lead-abc123456789': { decision: 'approve', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z' } },
  });
  const { output } = await queue.run(lead(), ctx);
  assert.equal(output.approval.decision, 'approve');
  assert.equal(output.approval.by, 'dana.reviewer');
});

test('a human approval is recorded with actor human, not system', async () => {
  const ctx = makeCtx({
    approvals: { 'lead-abc123456789': { decision: 'approve', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z' } },
  });
  const result = await queue.run(lead(), ctx);
  const humanEntry = result.entries.find((e) => e.actor === 'human');
  assert.ok(humanEntry, 'the human decision leaves its own ledger entry');
  assert.match(humanEntry.detail, /dana\.reviewer/);
});

test('a recorded rejection REFUSES with REJECTED_BY_HUMAN', async () => {
  const ctx = makeCtx({
    approvals: { 'lead-abc123456789': { decision: 'reject', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z', note: 'wrong persona' } },
  });
  const result = await queue.run(lead(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['REJECTED_BY_HUMAN']);
  assert.match(result.detail, /wrong persona/);
});

test('an unrecognised decision parks rather than guessing what the human meant', async () => {
  const ctx = makeCtx({ approvals: { 'lead-abc123456789': { decision: 'maybe', by: 'x', at: 'y' } } });
  const result = await queue.run(lead(), ctx);
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

test('an approval for a different lead does not release this one', async () => {
  const ctx = makeCtx({ approvals: { 'lead-someone-else': { decision: 'approve', by: 'x', at: 'y' } } });
  const result = await queue.run(lead(), ctx);
  assert.equal(result.status, 'NEEDS_HUMAN');
});

// --- the earned-autonomy hook --------------------------------------------------------

test('the earned-autonomy hook is disabled by default', async () => {
  const result = await queue.run(lead(), makeCtx());
  assert.equal(result.output.queue.autonomy_enabled, false);
});

test('an absent autonomy config does not enable autonomy', async () => {
  const result = await queue.run(lead(), makeCtx({ autonomy: undefined }));
  assert.equal(result.status, 'NEEDS_HUMAN');
});

test('an autonomy config present but not explicitly enabled still parks the lead', async () => {
  const result = await queue.run(lead(), makeCtx({ autonomy: { minScore: 10 } }));
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.output.queue.autonomy_enabled, false);
});

test('the shipped default config in the repo does not enable autonomy', async () => {
  const { defaultConfig } = await import('../src/config.mjs');
  assert.notEqual(defaultConfig.queue?.autonomy?.enabled, true);
});
