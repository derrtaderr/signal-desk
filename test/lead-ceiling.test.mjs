// The per-run lead ceiling, at the kernel. docs/LEAD-CEILING-SPEC.md.
//
// The kernel is where the ceiling is an invariant rather than a courtesy. The CLI refuses to START
// a run whose signals folder is over the ceiling; this file proves that a run handed more leads than
// its ceiling anyway, by any caller, stops AT the ceiling with a ledger line per lead it refused,
// and never runs a billing stage for them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/kernel.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock } from '../src/context.mjs';
import { pass } from '../src/contract.mjs';

// Stages that count how often they ran, so "the billing stage was not run" is asserted, not assumed.
function countingStages() {
  const calls = { ingest: 0, enrich: 0, draft: 0 };
  const stage = (name) => ({
    name,
    run: async (input) => {
      calls[name] += 1;
      return pass({ output: { ...input, lead_id: input.lead_id ?? `lead-${input.id}` } });
    },
  });
  return { calls, stages: [stage('ingest'), stage('enrich'), stage('draft')] };
}

function signals(n) {
  return Array.from({ length: n }, (_, index) => ({ id: `s${String(index + 1).padStart(2, '0')}` }));
}

async function run({ count, limits }) {
  const { calls, stages } = countingStages();
  const ledger = new Ledger();
  const config = limits === undefined ? {} : { limits };
  const ctx = createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async () => {
      throw new Error('no fetch in this test');
    },
    config,
    run_id: 'run-ceiling-test',
  });
  const report = await runPipeline({ stages, signals: signals(count), ctx, ledger });
  return { calls, report, entries: ledger.entries() };
}

const LIMITS = { maxLeads: 2, countedFrom: 'enrich' };

test('a run with more leads than its ceiling runs the billing stage exactly ceiling times', async () => {
  const { calls } = await run({ count: 5, limits: LIMITS });
  assert.equal(calls.enrich, 2, 'enrich ran for the first two leads only');
  assert.equal(calls.draft, 2, 'and nothing past it ran for the others');
  assert.equal(calls.ingest, 5, 'ingest still ran for every signal, because ingest bills nothing');
});

test('every lead over the ceiling gets its own REFUSE line, at the stage it was refused entry to', async () => {
  const { report, entries } = await run({ count: 5, limits: LIMITS });

  const refused = report.leads.filter((lead) => lead.reason_codes.includes('LEAD_CEILING_REACHED'));
  assert.deepEqual(
    refused.map((lead) => lead.lead_id),
    ['lead-s03', 'lead-s04', 'lead-s05'],
    'never a silent truncation: each lead over the ceiling is in the report',
  );
  for (const lead of refused) {
    assert.equal(lead.final_status, 'REFUSE');
    assert.equal(lead.final_stage, 'enrich');
  }

  const lines = entries.filter((entry) => entry.reason_codes.includes('LEAD_CEILING_REACHED'));
  assert.equal(lines.length, 3, 'one ledger entry per refused lead');
  for (const line of lines) {
    assert.equal(line.stage, 'enrich');
    assert.equal(line.verdict, 'REFUSE');
    assert.match(line.detail, /ceiling of 2/);
    assert.match(line.detail, /not run/);
  }
});

test('a run over its ceiling still seals, and the seal summary counts the refusals', async () => {
  const { report, entries } = await run({ count: 5, limits: LIMITS });
  const seal = entries[entries.length - 1];
  assert.equal(seal.stage, 'seal');
  assert.deepEqual(seal.summary, { PASS: 2, REFUSE: 3, NEEDS_HUMAN: 0, total: 5 });
  assert.deepEqual(report.summary, seal.summary);
});

test('a run AT its ceiling refuses nothing', async () => {
  const { calls, report } = await run({ count: 2, limits: LIMITS });
  assert.equal(calls.enrich, 2);
  assert.equal(report.summary.REFUSE, 0);
});

test('a config with no limits has no ceiling, which is fixture mode', async () => {
  const { calls, report } = await run({ count: 5 });
  assert.equal(calls.enrich, 5);
  assert.equal(report.summary.PASS, 5);
});
