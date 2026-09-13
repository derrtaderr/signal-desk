// Test family 1 of 4 — stage-contract conformance.
//
// One harness, applied to every stage in the pipeline. The stage contract is the whole
// extensibility story, so "every stage satisfies it" has to be asserted mechanically rather
// than reviewed by eye. A ninth stage added later gets tested by this file for free, and a
// stage that quietly stops honouring the contract fails here rather than in production.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pipeline, defaultConfig } from '../src/config.mjs';
import { assertStageResult, VERDICTS, PASS } from '../src/contract.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { loadFixtures, buildRun } from '../src/runner.mjs';
import { canonical } from '../src/canonical.mjs';

// Capture the real input every stage receives during a genuine fixture run, so conformance
// is checked against what the pipeline actually produces rather than against hand-written
// doubles that may have drifted from it.
async function captureStageInputs() {
  const captured = new Map();
  const { ledger, ctx, stages, signals } = buildRun();
  const wrapped = stages.map((stage) => ({
    name: stage.name,
    run: (input, innerCtx) => {
      // Snapshot BEFORE the stage runs. Storing the live reference would let a stage that
      // mutates its input bake that mutation into the captured baseline, which is exactly
      // how such a stage slipped past this harness the first time it was probed.
      if (!captured.has(stage.name)) captured.set(stage.name, structuredClone(input));
      return stage.run(input, innerCtx);
    },
  }));
  const { runPipeline } = await import('../src/kernel.mjs');
  await runPipeline({ stages: wrapped, signals, ctx, ledger });
  return captured;
}

const stageInputs = await captureStageInputs();

// A pristine deep copy per test. Handing the same object to every test would let an earlier
// test's mutation be baked into the next test's baseline, which is exactly how a stage that
// mutates its input slipped past this harness the first time it was probed.
function inputFor(name) {
  return structuredClone(stageInputs.get(name));
}

function freshCtx(overrides = {}) {
  const ledger = new Ledger();
  const fixtures = loadFixtures();
  return createContext({
    ledger,
    clock: fixtureClock(defaultConfig.clock),
    fetch: recordedFetcher(fixtures.recordings),
    config: { ...defaultConfig, queue: { ...defaultConfig.queue, approvals: fixtures.approvals } },
    run_id: 'run-conformance',
    ...overrides,
  });
}

test('the harness captured a real input for every stage in the pipeline', () => {
  for (const stage of pipeline) {
    assert.ok(stageInputs.has(stage.name), `stage ${stage.name} was reached by the fixture run`);
  }
});

test('every stage name is unique, so the ledger trail is unambiguous', () => {
  const names = pipeline.map((s) => s.name);
  assert.deepEqual([...new Set(names)].length, names.length);
});

for (const stage of pipeline) {
  test(`${stage.name}: declares a name and a run function`, () => {
    assert.equal(typeof stage.name, 'string');
    assert.ok(stage.name.length > 0);
    assert.equal(typeof stage.run, 'function');
  });

  test(`${stage.name}: accepts (input, ctx) and nothing more`, () => {
    assert.ok(stage.run.length <= 2, `${stage.name} takes at most two arguments`);
  });

  test(`${stage.name}: returns a contract-valid result for its real input`, async () => {
    const result = await stage.run(inputFor(stage.name), freshCtx());
    assertStageResult(result, stage.name);
    assert.ok(VERDICTS.includes(result.status));
  });

  test(`${stage.name}: returns an object output and an array of entries`, async () => {
    const result = await stage.run(inputFor(stage.name), freshCtx());
    assert.equal(typeof result.output, 'object');
    assert.ok(Array.isArray(result.entries));
    for (const entry of result.entries) {
      assert.equal(typeof entry, 'object');
      assert.ok(entry !== null);
    }
  });

  test(`${stage.name}: a non-PASS verdict always carries a machine-readable reason code`, async () => {
    const result = await stage.run(inputFor(stage.name), freshCtx());
    if (result.status !== PASS) {
      assert.ok(Array.isArray(result.reason_codes));
      assert.ok(result.reason_codes.length > 0);
      for (const code of result.reason_codes) {
        assert.match(code, /^[A-Z][A-Z0-9_]*$/, 'reason codes are machine-readable constants');
      }
    }
  });

  test(`${stage.name}: is deterministic for the same input`, async () => {
    const a = await stage.run(inputFor(stage.name), freshCtx());
    const b = await stage.run(inputFor(stage.name), freshCtx());
    assert.equal(canonical(a), canonical(b));
  });

  test(`${stage.name}: does not mutate the input it was handed`, async () => {
    const input = inputFor(stage.name);
    const before = canonical(input);
    await stage.run(input, freshCtx());
    assert.equal(canonical(input), before);
  });

  test(`${stage.name}: does not mutate the shared config`, async () => {
    const ctx = freshCtx();
    const before = canonical(ctx.config);
    await stage.run(inputFor(stage.name), ctx);
    assert.equal(canonical(ctx.config), before);
  });

  test(`${stage.name}: never returns PASS for structurally hostile input`, async () => {
    // Either a contract-valid REFUSE, or a throw the kernel converts into one. What it must
    // never do is wave garbage through.
    for (const hostile of [null, undefined, {}, [], 'string', 42, { unexpected: true }]) {
      let result;
      try {
        result = await stage.run(hostile, freshCtx());
      } catch {
        continue; // the kernel turns this into REFUSE/STAGE_ERROR, which is tested there
      }
      assert.notEqual(
        result.status,
        PASS,
        `${stage.name} passed hostile input ${JSON.stringify(hostile)}`,
      );
      assertStageResult(result, stage.name);
    }
  });
}
