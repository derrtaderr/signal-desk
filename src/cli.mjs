// The CLI. Three verbs in M1: run, explain, replay.
//
// This is where bytes reach disk. Stages do no I/O and the kernel writes only to an
// in-memory ledger, so putting every write in one place keeps the rest of the system
// testable with plain objects.
//
// The M2 verbs (queue, approve, reject) and the M3 verb (dashboard) are deliberately absent
// rather than stubbed, because a verb that exists and does nothing is worse than one that
// does not exist.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeFixtureRun, buildRun, loadFixtures } from './runner.mjs';
import { runPipeline } from './kernel.mjs';
import { parseLedger, verifyChain } from './ledger.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `signal-desk — a signal-to-outreach pipeline where every decision can be
inspected, replayed, or refused.

Usage:
  signal-desk run              Run the keyless fixture pipeline and write a decision ledger
  signal-desk explain <lead>   Print the full decision trail for one lead
  signal-desk replay <run>     Re-execute a recorded run and verify its ledger still matches

Runs are written to ./runs/<run-id>/. The fixture demo needs no API key and no network.
This tool never sends mail; handoffs are written as dry-run JSON.
`;

function runsDir(env, cwd) {
  return env.SIGNAL_DESK_RUNS_DIR ?? join(cwd, 'runs');
}

function pad(value, width) {
  return String(value).padEnd(width);
}

// --- run -------------------------------------------------------------------------------

async function verbRun({ out, env, cwd }) {
  const { run_id, ledger, report } = await executeFixtureRun();
  const dir = join(runsDir(env, cwd), run_id);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.jsonl'), ledger.toJSONL());

  const handoffDir = join(dir, 'handoffs');
  mkdirSync(handoffDir, { recursive: true });
  const handed = report.leads.filter((lead) => lead.output?.handoff !== undefined);
  for (const lead of handed) {
    writeFileSync(
      join(handoffDir, `${lead.lead_id}.json`),
      `${JSON.stringify(lead.output.handoff.artifact, null, 2)}\n`,
    );
  }

  out(`run ${run_id}`);
  out('');
  out(`  ${report.summary.PASS} passed to handoff`);
  out(`  ${report.summary.NEEDS_HUMAN} awaiting a human`);
  out(`  ${report.summary.REFUSE} refused`);
  out(`  ${report.summary.total} signals in total`);
  out('');

  for (const lead of report.leads) {
    const reason = lead.reason_codes.length > 0 ? lead.reason_codes.join(',') : '';
    out(`  ${pad(lead.lead_id, 22)} ${pad(lead.final_stage, 9)} ${pad(lead.final_status, 12)} ${reason}`);
  }

  // Relative to the working directory. An absolute path would make this output
  // machine-specific, which breaks both the README example and the promise that a run
  // carries no local state.
  const show = (path) => relative(cwd, path) || path;

  out('');
  out(`  ledger    ${show(join(dir, 'ledger.jsonl'))}`);
  out(`  handoffs  ${handed.length} dry run artifact(s) in ${show(handoffDir)}`);
  out('');
  out('  Nothing was sent. This tool never sends mail.');
  out(`  Inspect a decision with: signal-desk explain <lead>`);

  return 0;
}

// --- explain ---------------------------------------------------------------------------

async function verbExplain({ args, out, err, env, cwd }) {
  const leadId = args[0];
  if (leadId === undefined) {
    err('explain needs a lead id. Try: signal-desk explain <lead>');
    return 2;
  }

  const entries = await loadLatestLedger({ env, cwd, err });
  if (entries === null) return 2;

  const forLead = entries.filter((entry) => entry.lead_id === leadId);
  if (forLead.length === 0) {
    err(`lead ${leadId} not found in the latest ledger`);
    return 2;
  }

  out(`lead ${leadId}`);
  out(`run  ${forLead[0].run_id}`);
  out('');

  for (const entry of forLead) {
    out(`  ${entry.ts}  ${pad(entry.stage, 9)} ${pad(entry.verdict, 12)} ${entry.actor}`);
    if (entry.reason_codes.length > 0) out(`      reasons   ${entry.reason_codes.join(', ')}`);
    if (entry.detail) out(`      detail    ${entry.detail}`);
    if (entry.evidence_refs.length > 0) out(`      evidence  ${entry.evidence_refs.join('\n                ')}`);
  }

  const last = forLead[forLead.length - 1];
  out('');
  out(`  outcome: ${last.verdict} at ${last.stage}`);
  return 0;
}

async function loadLatestLedger({ env, cwd, err }) {
  const base = runsDir(env, cwd);
  if (!existsSync(base)) {
    err('no runs found. Run `signal-desk run` first.');
    return null;
  }
  const { readdirSync } = await import('node:fs');
  const runIds = readdirSync(base).filter((name) => name.startsWith('run-')).sort();
  if (runIds.length === 0) {
    err('no runs found. Run `signal-desk run` first.');
    return null;
  }
  const path = join(base, runIds[runIds.length - 1], 'ledger.jsonl');
  return parseLedger(readFileSync(path, 'utf8'));
}

// --- replay ----------------------------------------------------------------------------

async function verbReplay({ args, out, err, env, cwd }) {
  const runId = args[0];
  if (runId === undefined) {
    err('replay needs a run id. Try: signal-desk replay <run>');
    return 2;
  }

  const path = join(runsDir(env, cwd), runId, 'ledger.jsonl');
  if (!existsSync(path)) {
    err(`run ${runId} not found at ${path}`);
    return 2;
  }

  const recorded = readFileSync(path, 'utf8');
  const recordedEntries = parseLedger(recorded);

  // Two independent checks. The chain proves the file was not edited after it was written.
  // The re-execution proves the code still makes the same decisions from the same inputs.
  // A file can pass one and fail the other, and the difference matters.
  const chain = verifyChain(recordedEntries);
  if (!chain.ok) {
    err(`hash chain broken: ${chain.reason}`);
    err('the ledger was tampered with after it was written');
    return 1;
  }
  out(`hash chain verified across ${recordedEntries.length} entries`);

  const { ledger, ctx, stages, signals, run_id } = buildRun({ fixtures: loadFixtures() });
  await runPipeline({ stages, signals, ctx, ledger });

  if (run_id !== runId) {
    err(`replay produced ${run_id}, which does not match ${runId}`);
    err('the inputs or the wiring have changed since that run');
    return 1;
  }

  if (ledger.toJSONL() !== recorded) {
    err(`replay of ${runId} differs from the recorded ledger`);
    return 1;
  }

  out(`replay of ${runId} is an exact match`);
  out(`${recordedEntries.length} entries, identical bytes, chain intact`);
  return 0;
}

// --- dispatch --------------------------------------------------------------------------

export async function main({
  argv = [],
  out = console.log,
  err = console.error,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const [verb, ...args] = argv;
  const context = { args, out, err, env, cwd };

  switch (verb) {
    case 'run':
      return verbRun(context);
    case 'explain':
      return verbExplain(context);
    case 'replay':
      return verbReplay(context);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      out(USAGE);
      return verb === undefined ? 2 : 0;
    default:
      err(`unknown verb: ${verb}`);
      err(USAGE);
      return 2;
  }
}

export { PACKAGE_ROOT };
