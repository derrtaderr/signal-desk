import test from 'node:test';
import assert from 'node:assert/strict';

import { handoff } from '../src/stages/handoff.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

function lead(overrides = {}) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test' },
    claims: [],
    citations: ['https://directory.test/company/acme.test'],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae-round-robin', play: 'executive-intro', reason: 'x' },
    draft: {
      to: 'dana@acme.test',
      subject: 'Your team and Acme Robotics',
      body: 'Hi Dana,\n\nOpen to a short call?',
      template: 'executive-intro',
      claim_refs: [{ field: 'employee_count', citation: 'https://directory.test/company/acme.test' }],
    },
    gate: { violations: [], rules_run: [] },
    queue: { autonomy_enabled: false, owner: 'ae-round-robin' },
    approval: { decision: 'approve', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z' },
    ...overrides,
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

test('the adapter registry contains only the dry-run reference adapter in M1', async () => {
  const { adapters } = await import('../src/stages/handoff.mjs');
  assert.deepEqual(Object.keys(adapters), ['dry-run-json']);
});

test('handoff is deterministic: the same lead exports the same artifact twice', async () => {
  const a = await handoff.run(lead(), makeCtx());
  const b = await handoff.run(lead(), makeCtx());
  assert.deepEqual(a.output.handoff, b.output.handoff);
});
