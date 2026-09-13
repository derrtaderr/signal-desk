import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/kernel.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { pass, refuse, needsHuman } from '../src/contract.mjs';

function harness({ stages, signals }) {
  const ledger = new Ledger();
  const ctx = createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture' },
    run_id: 'run-test',
  });
  return { ledger, ctx, run: () => runPipeline({ stages, signals, ctx, ledger }) };
}

const alwaysPass = (name) => ({
  name,
  run: (input) => pass({ output: { ...input, [`${name}_ran`]: true } }),
});

test('the kernel runs stages in order and threads each output into the next input', async () => {
  const seen = [];
  const stages = [
    { name: 'one', run: (input) => { seen.push(input.from); return pass({ output: { from: 'one' } }); } },
    { name: 'two', run: (input) => { seen.push(input.from); return pass({ output: { from: 'two' } }); } },
  ];
  const { run } = harness({ stages, signals: [{ id: 'a', from: 'signal' }] });
  const report = await run();
  assert.deepEqual(seen, ['signal', 'one']);
  assert.equal(report.leads[0].final_status, 'PASS');
  assert.equal(report.leads[0].final_stage, 'two');
});

test('the kernel writes one verdict entry per stage it executes', async () => {
  const stages = [alwaysPass('one'), alwaysPass('two')];
  const { ledger, run } = harness({ stages, signals: [{ id: 'a' }] });
  await run();
  assert.deepEqual(ledger.entries().map((e) => e.stage), ['one', 'two']);
  assert.deepEqual(ledger.entries().map((e) => e.verdict), ['PASS', 'PASS']);
});

test('the kernel stamps ts, run_id and lead_id onto every entry', async () => {
  const stages = [alwaysPass('one')];
  const { ledger, run } = harness({ stages, signals: [{ id: 'a' }] });
  await run();
  const [entry] = ledger.entries();
  assert.equal(entry.run_id, 'run-test');
  assert.equal(entry.lead_id, 'a');
  assert.equal(entry.ts, '2026-03-01T09:00:00.000Z');
  assert.equal(entry.actor, 'system');
});

test('a REFUSE halts that lead and no later stage runs for it', async () => {
  let reached = false;
  const stages = [
    { name: 'one', run: () => refuse({ reason: 'NOPE' }) },
    { name: 'two', run: () => { reached = true; return pass({}); } },
  ];
  const { ledger, run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(reached, false);
  assert.equal(report.leads[0].final_status, 'REFUSE');
  assert.deepEqual(report.leads[0].reason_codes, ['NOPE']);
  assert.deepEqual(ledger.entries().map((e) => e.stage), ['one']);
});

test('a refused lead does not stop the run; later leads still flow', async () => {
  const stages = [
    { name: 'one', run: (input) => (input.id === 'a' ? refuse({ reason: 'NOPE' }) : pass({ output: input })) },
    alwaysPass('two'),
  ];
  const { run } = harness({ stages, signals: [{ id: 'a' }, { id: 'b' }] });
  const report = await run();
  assert.equal(report.leads.length, 2);
  assert.equal(report.leads[0].final_status, 'REFUSE');
  assert.equal(report.leads[1].final_status, 'PASS');
  assert.equal(report.leads[1].final_stage, 'two');
});

test('a NEEDS_HUMAN parks the lead at that stage and no later stage runs for it', async () => {
  let reached = false;
  const stages = [
    { name: 'one', run: () => needsHuman({ reason: 'AWAITING_APPROVAL' }) },
    { name: 'two', run: () => { reached = true; return pass({}); } },
  ];
  const { run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(reached, false);
  assert.equal(report.leads[0].final_status, 'NEEDS_HUMAN');
});

test('a stage that throws becomes a REFUSE carrying STAGE_ERROR, never a pass', async () => {
  const stages = [
    { name: 'boom', run: () => { throw new Error('kaboom'); } },
    alwaysPass('after'),
  ];
  const { ledger, run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(report.leads[0].final_status, 'REFUSE');
  assert.deepEqual(report.leads[0].reason_codes, ['STAGE_ERROR']);
  assert.deepEqual(ledger.entries().map((e) => e.stage), ['boom']);
});

test('a stage returning a malformed result becomes a REFUSE carrying CONTRACT_VIOLATION', async () => {
  const stages = [{ name: 'bad', run: () => ({ status: 'FINE' }) }];
  const { run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(report.leads[0].final_status, 'REFUSE');
  assert.deepEqual(report.leads[0].reason_codes, ['CONTRACT_VIOLATION']);
});

test('a stage returning nothing at all is a CONTRACT_VIOLATION, not an undefined pass', async () => {
  const stages = [{ name: 'silent', run: () => undefined }];
  const { run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(report.leads[0].final_status, 'REFUSE');
  assert.deepEqual(report.leads[0].reason_codes, ['CONTRACT_VIOLATION']);
});

test('a stage throwing its own TypeError is STAGE_ERROR, not a contract violation', async () => {
  const stages = [{ name: 'boom', run: () => { throw new TypeError('undefined is not a function'); } }];
  const { run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.deepEqual(report.leads[0].reason_codes, ['STAGE_ERROR']);
});

test('supplementary entries returned by a stage are stamped and land before its verdict', async () => {
  const stages = [
    {
      name: 'one',
      run: () => pass({
        output: {},
        entries: [{ note: 'evidence', evidence_refs: ['https://example.test/a'] }],
      }),
    },
  ];
  const { ledger, run } = harness({ stages, signals: [{ id: 'a' }] });
  await run();
  const entries = ledger.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].note, 'evidence');
  assert.deepEqual(entries[0].evidence_refs, ['https://example.test/a']);
  assert.equal(entries[0].run_id, 'run-test');
  assert.equal(entries[1].stage, 'one');
  assert.equal(entries[1].verdict, 'PASS');
});

test('the kernel adopts an assigned lead_id before stamping, so one trail covers the lead', async () => {
  // Adopting after stamping would file the assigning stage's own entry under the raw signal
  // id, and `explain <lead>` would return a trail that starts at the second stage.
  const stages = [
    { name: 'ingest', run: (input) => pass({ output: { ...input, lead_id: 'canonical-1' } }) },
    alwaysPass('after'),
  ];
  const { ledger, run } = harness({ stages, signals: [{ id: 'raw-1' }] });
  await run();
  const entries = ledger.entries();
  assert.deepEqual(entries.map((e) => e.lead_id), ['canonical-1', 'canonical-1']);
});

test('a lead refused before any id is assigned keeps the id we knew at the time', async () => {
  const stages = [{ name: 'ingest', run: () => refuse({ reason: 'MALFORMED' }) }];
  const { ledger, run } = harness({ stages, signals: [{ id: 'raw-1' }] });
  await run();
  assert.equal(ledger.entries()[0].lead_id, 'raw-1');
});

test('a signal with no identifier still gets a stable positional lead_id', async () => {
  const stages = [alwaysPass('one')];
  const { ledger, run } = harness({ stages, signals: [{ payload: 'garbage' }] });
  await run();
  assert.equal(ledger.entries()[0].lead_id, 'unidentified-0');
});

test('leads are processed in a stable sorted order regardless of input order', async () => {
  const order = [];
  const stages = [{ name: 'one', run: (input) => { order.push(input.id); return pass({ output: input }); } }];
  const { run } = harness({ stages, signals: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
  await run();
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('the kernel reports a summary counting each terminal verdict', async () => {
  const stages = [
    {
      name: 'one',
      run: (input) => {
        if (input.id === 'a') return refuse({ reason: 'NOPE' });
        if (input.id === 'b') return needsHuman({ reason: 'WAIT' });
        return pass({ output: input });
      },
    },
  ];
  const { run } = harness({ stages, signals: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const report = await run();
  assert.deepEqual(report.summary, { PASS: 1, REFUSE: 1, NEEDS_HUMAN: 1, total: 3 });
});

test('an async stage is awaited, so a stage may use the injected fetcher', async () => {
  const stages = [{ name: 'one', run: async (input) => pass({ output: { ...input, async: true } }) }];
  const { run } = harness({ stages, signals: [{ id: 'a' }] });
  const report = await run();
  assert.equal(report.leads[0].output.async, true);
});
