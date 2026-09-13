// Test family 2 of 4 — golden-ledger regression.
//
// The fixture run's ledger is a committed golden file. Any behaviour drift fails here, and
// the diff on the golden file is the review surface for what the change actually did to the
// decisions. Regenerate with `npm run golden:update`, in the SAME commit as the change.
//
// A golden file is only worth having if it is specific. Byte equality is the primary
// assertion, and the tests below it pin the things a careless regeneration would paper over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeFixtureRun } from '../src/runner.mjs';
import { parseLedger, verifyChain } from '../src/ledger.mjs';
import { pipeline } from '../src/config.mjs';

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fixture-run.jsonl');
const golden = readFileSync(GOLDEN_PATH, 'utf8');
const goldenEntries = parseLedger(golden);
const run = await executeFixtureRun();

test('the fixture run reproduces the golden ledger byte for byte', () => {
  assert.equal(
    run.ledger.toJSONL(),
    golden,
    'behaviour drifted. If the change was intended, run `npm run golden:update` in the same commit.',
  );
});

test('the golden ledger is not empty and covers the whole corpus', () => {
  assert.ok(goldenEntries.length >= 25, 'the golden file carries a full run');
  assert.ok(golden.endsWith('\n'));
});

test('the golden ledger verifies as an unbroken hash chain', () => {
  assert.deepEqual(verifyChain(goldenEntries), { ok: true });
});

test('the golden ledger and the live run share a final hash', () => {
  assert.equal(run.ledger.head(), goldenEntries[goldenEntries.length - 1].hash);
});

test('the golden ledger records a single run id, matching the live run', () => {
  const runIds = new Set(goldenEntries.map((e) => e.run_id));
  assert.equal(runIds.size, 1);
  assert.equal([...runIds][0], run.run_id);
});

test('every stage in the pipeline appears in the golden ledger', () => {
  const stages = new Set(goldenEntries.map((e) => e.stage));
  for (const stage of pipeline) {
    assert.ok(stages.has(stage.name), `stage ${stage.name} appears in the golden run`);
  }
});

test('the golden ledger records all three verdicts', () => {
  const verdicts = new Set(goldenEntries.map((e) => e.verdict));
  assert.deepEqual([...verdicts].sort(), ['NEEDS_HUMAN', 'PASS', 'REFUSE']);
});

test('the golden ledger pins the exact refusals, so a silently relaxed rule is caught', () => {
  const refusals = goldenEntries
    .filter((e) => e.verdict === 'REFUSE')
    .map((e) => `${e.stage}:${e.reason_codes.join(',')}`)
    .sort();
  assert.deepEqual(refusals, [
    'enrich:EVIDENCE_DECAYED',
    'enrich:IDENTITY_CONTRADICTED',
    'enrich:NO_CITED_CLAIMS',
    'gate:PII_IN_BODY',
    'gate:PROMPT_INJECTION',
    'gate:RUBRIC_FAILED',
    'gate:UNGROUNDED_PROSE_CLAIM',
    'ingest:DUPLICATE_LEAD',
    'ingest:DUPLICATE_SIGNAL',
    'ingest:MALFORMED_PAYLOAD',
    'queue:REJECTED_BY_HUMAN',
    'queue:REJECTED_BY_HUMAN',
    'route:BELOW_ROUTING_FLOOR',
  ]);
});

test('the golden run exercises every part of the gate, each with its own refusal', () => {
  // The demo has to SHOW the gate working, not just contain a gate. One hostile fixture per
  // part, each refused for its own named reason. M3 adds the fourth part, prompt injection.
  const gateRefusals = goldenEntries
    .filter((e) => e.stage === 'gate' && e.verdict === 'REFUSE')
    .map((e) => e.reason_codes[0])
    .sort();
  assert.deepEqual(gateRefusals, [
    'PII_IN_BODY',
    'PROMPT_INJECTION',
    'RUBRIC_FAILED',
    'UNGROUNDED_PROSE_CLAIM',
  ]);
});

test('the golden run distinguishes a replayed signal from a second signal for one lead', () => {
  const ingestRefusals = goldenEntries
    .filter((e) => e.stage === 'ingest' && e.verdict === 'REFUSE')
    .map((e) => e.reason_codes[0])
    .sort();
  assert.deepEqual(ingestRefusals, ['DUPLICATE_LEAD', 'DUPLICATE_SIGNAL', 'MALFORMED_PAYLOAD']);
});

test('the golden ledger pins which leads park for a human', () => {
  const parked = goldenEntries.filter((e) => e.verdict === 'NEEDS_HUMAN');
  assert.equal(parked.length, 1);
  assert.equal(parked[0].stage, 'queue');
  assert.deepEqual(parked[0].reason_codes, ['AWAITING_APPROVAL']);
});

test('the golden ledger records exactly one human actor decision per recorded approval', () => {
  const humanEntries = goldenEntries.filter((e) => e.actor === 'human');
  assert.equal(humanEntries.length, 2, 'one approval and one rejection');
  assert.deepEqual(
    humanEntries.map((e) => e.reason_codes[0]).sort(),
    ['APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN'],
  );
});

test('exactly one lead reaches handoff in the golden run', () => {
  const handoffs = goldenEntries.filter((e) => e.stage === 'handoff' && e.verdict === 'PASS');
  assert.equal(handoffs.length, 1);
});

test('the golden ledger carries no absolute path and no wall-clock timestamp', () => {
  assert.doesNotMatch(golden, /\/Users\/|\/home\/|C:\\\\/);
  for (const entry of goldenEntries) {
    assert.match(entry.ts, /^2026-03-01T09:/, 'timestamps come from the pinned fixture clock');
  }
});

test('the golden ledger is in canonical form, line by line', async () => {
  const { canonical } = await import('../src/canonical.mjs');
  for (const line of golden.trimEnd().split('\n')) {
    assert.equal(line, canonical(JSON.parse(line)));
  }
});
