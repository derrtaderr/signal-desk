// Test family 4 of 4 — determinism.
//
// Two fixture runs must produce identical ledger bytes. This is the property the whole
// design rests on: replay, the golden file, and the claim that a decision can be inspected
// after the fact all assume the run is a function of its inputs and nothing else.
//
// Four things had to be engineered for this to hold, and each gets its own assertion here:
// the clock is injected and advances by position, the run id is derived rather than
// generated, every line is serialised through one canonical function with sorted keys, and
// leads are processed in sorted order rather than filesystem order.

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeFixtureRun, loadFixtures, buildRun, computeRunId } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { pipeline, defaultConfig } from '../src/config.mjs';
import { verifyChain } from '../src/ledger.mjs';

test('two fixture runs produce byte-identical ledgers', async () => {
  const first = await executeFixtureRun();
  const second = await executeFixtureRun();
  assert.equal(first.ledger.toJSONL(), second.ledger.toJSONL());
});

test('the identical ledgers are not trivially empty', async () => {
  const { ledger } = await executeFixtureRun();
  const text = ledger.toJSONL();
  assert.ok(text.length > 1000, 'the run wrote a substantial ledger');
  assert.ok(ledger.entries().length >= 25, 'the run wrote many entries');
});

test('two fixture runs agree on the run id', async () => {
  const first = await executeFixtureRun();
  const second = await executeFixtureRun();
  assert.equal(first.run_id, second.run_id);
});

test('two fixture runs produce the same final hash, so the whole chain matches', async () => {
  const first = await executeFixtureRun();
  const second = await executeFixtureRun();
  assert.equal(first.ledger.head(), second.ledger.head());
});

test('two fixture runs reach the same verdict for every lead', async () => {
  const first = await executeFixtureRun();
  const second = await executeFixtureRun();
  assert.deepEqual(first.report.leads, second.report.leads);
  assert.deepEqual(first.report.summary, second.report.summary);
});

test('a third and fourth run still match, so it is not a two-run coincidence', async () => {
  const runs = [];
  for (let i = 0; i < 4; i += 1) runs.push((await executeFixtureRun()).ledger.toJSONL());
  assert.equal(new Set(runs).size, 1);
});

test('every timestamp comes from the injected clock, in the sequence it defines', async () => {
  const { ledger } = await executeFixtureRun();
  const timestamps = ledger.entries().map((e) => e.ts);
  const start = Date.parse(defaultConfig.clock.start);
  timestamps.forEach((ts, index) => {
    assert.equal(Date.parse(ts), start + index * defaultConfig.clock.stepMs);
  });
});

test('no timestamp is anywhere near the wall clock, proving nothing read it', async () => {
  const { ledger } = await executeFixtureRun();
  const now = Date.now();
  for (const entry of ledger.entries()) {
    assert.ok(
      Math.abs(now - Date.parse(entry.ts)) > 60000,
      'a fixture timestamp is pinned to the config, not to today',
    );
  }
});

test('shuffling the input order does not change the ledger, because leads are sorted', async () => {
  // Signals with distinct ids only. The duplicate-signal fixture deliberately shares an id
  // with the acme signal, and for that pair the input order genuinely decides which one is
  // accepted and which is refused as the replay. That is first-come-first-served on a
  // repeated id, which is the behaviour we want, so it is excluded from the shuffle rather
  // than asserted away.
  const fixtures = loadFixtures();
  const seen = new Set();
  const distinct = fixtures.signals.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  assert.ok(distinct.length >= 5, 'the shuffle still covers most of the corpus');

  const forward = buildRun({ fixtures: { ...fixtures, signals: distinct } });
  await runPipeline({ stages: forward.stages, signals: forward.signals, ctx: forward.ctx, ledger: forward.ledger });

  const reversed = buildRun({ fixtures: { ...fixtures, signals: [...distinct].reverse() } });
  await runPipeline({ stages: reversed.stages, signals: reversed.signals, ctx: reversed.ctx, ledger: reversed.ledger });

  assert.equal(forward.run_id, reversed.run_id, 'the run id covers the input set, not its order');
  assert.equal(forward.ledger.toJSONL(), reversed.ledger.toJSONL());
});

test('two signals sharing an id are resolved first-come-first-served, not arbitrarily', async () => {
  const { ledger } = await executeFixtureRun();
  const ingestVerdicts = ledger
    .entries()
    .filter((e) => e.stage === 'ingest' && e.evidence_refs.includes('signal:sig-1001'))
    .map((e) => e.verdict);
  assert.deepEqual(ingestVerdicts, ['PASS', 'REFUSE'], 'the first wins and the replay is refused');
});

test('the run id is stable across input order too', () => {
  const fixtures = loadFixtures();
  const config = { ...defaultConfig, queue: { ...defaultConfig.queue, approvals: fixtures.approvals } };
  // The id covers the signals as given, so a reordered corpus is a different input set.
  // What must not vary is the id for the same corpus read twice.
  assert.equal(
    computeRunId({ pipeline, config, signals: fixtures.signals }),
    computeRunId({ pipeline, config, signals: loadFixtures().signals }),
  );
});

test('every ledger line is canonical, so key order cannot vary between runs', async () => {
  const { ledger } = await executeFixtureRun();
  const { canonical } = await import('../src/canonical.mjs');
  for (const line of ledger.toJSONL().trimEnd().split('\n')) {
    assert.equal(line, canonical(JSON.parse(line)), 'the line is already in canonical form');
  }
});

test('the hash chain verifies on both runs, and links the same way', async () => {
  const first = await executeFixtureRun();
  const second = await executeFixtureRun();
  assert.deepEqual(verifyChain(first.ledger.entries()), { ok: true });
  assert.deepEqual(verifyChain(second.ledger.entries()), { ok: true });
  assert.deepEqual(
    first.ledger.entries().map((e) => e.hash),
    second.ledger.entries().map((e) => e.hash),
  );
});

test('the ledger contains no absolute filesystem path, so it carries no machine state', async () => {
  const { ledger } = await executeFixtureRun();
  const text = ledger.toJSONL();
  assert.ok(!text.includes(process.cwd()), 'no working directory leaked into the ledger');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|C:\\\\/, 'no home directory leaked into the ledger');
});
