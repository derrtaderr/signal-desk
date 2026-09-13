// The CLI. Six verbs: run, queue, approve, reject, explain, replay.
//
// This is where bytes reach disk. Stages do no I/O and the kernel writes only to an
// in-memory ledger, so putting every write in one place keeps the rest of the system
// testable with plain objects.
//
// The M3 verb (dashboard) is deliberately absent rather than stubbed, because a verb that
// exists and does nothing is worse than one that does not exist.
//
// THE APPROVAL LOOP, which is the shape of the whole tool:
//
//   run      composes drafts, gates them, and parks the survivors
//   queue    lists what is parked, with the content hash of each draft
//   approve  records a human decision BOUND TO THAT HASH
//   run      again; the approved draft is the only thing that moves

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeFixtureRun, buildRun, loadFixtures } from './runner.mjs';
import {
  loadDecisions,
  loadDecisionEntries,
  appendDecision,
  decisionsPath,
  decisionFor,
} from './decisions.mjs';
import { runPipeline } from './kernel.mjs';
import { parseLedger, verifyChain, isSealed, sealOf } from './ledger.mjs';
import { adapters } from './adapters.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `signal-desk — a signal-to-outreach pipeline where every decision can be
inspected, replayed, or refused.

Usage:
  node bin/signal-desk.mjs run            Run the keyless fixture pipeline and write a ledger
  node bin/signal-desk.mjs queue          List drafts parked for a human, with their hashes
  node bin/signal-desk.mjs approve <id>   Approve a parked draft, binding to its content
  node bin/signal-desk.mjs reject <id>    Reject a parked draft, with an optional --note
  node bin/signal-desk.mjs explain <lead> Print the full decision trail for one lead
  node bin/signal-desk.mjs replay <run>   Re-execute a run and verify its ledger still matches

There is no install step, so the invocation is spelled out in full. A bare signal-desk is
not on PATH in a fresh clone.

<id> is a draft hash or a lead id, and any unambiguous prefix of either will do.

An approval binds to the draft's CONTENT, never to the lead. Edit the draft and the old
decision stops covering it, so the lead parks again rather than going out unread.

Runs are written to ./runs/<run-id>/. The fixture demo needs no API key and no network.
This tool never sends mail; handoffs are written as dry-run JSON.
`;

function runsDir(env, cwd) {
  return env.SIGNAL_DESK_RUNS_DIR ?? join(cwd, 'runs');
}

export const LATEST_POINTER = 'latest';

// The most recent run, by what actually happened rather than by how its id happens to sort.
//
// Run ids are hashes of the inputs. They carry no temporal ordering whatsoever, so sorting
// them and taking the last one picks an arbitrary run. `run` writes a pointer; this reads it,
// falling back to modification time for a runs directory produced before the pointer existed.
export function latestRunId(base) {
  if (!existsSync(base)) return null;

  const pointer = join(base, LATEST_POINTER);
  if (existsSync(pointer)) {
    const runId = readFileSync(pointer, 'utf8').trim();
    if (runId !== '' && existsSync(join(base, runId))) return runId;
  }

  const candidates = readdirSync(base)
    .filter((name) => name.startsWith('run-') && existsSync(join(base, name, 'ledger.jsonl')))
    .map((name) => ({ name, at: statSync(join(base, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));

  return candidates.length === 0 ? null : candidates[candidates.length - 1].name;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

// Writes an export, and refuses to destroy a different one.
//
// Run scoping already separates runs, and the filename carries the draft hash, so two different
// messages to one person land in different files. What remains is the case where a path exists
// and the bytes DISAGREE, which means something is about to be lost. That refuses loudly.
//
// Identical bytes are not a collision. They are an idempotent re-run, which is what keeps
// `signal-desk run` safe to invoke twice into the same directory.
export class ArtifactClobberError extends Error {
  constructor(path) {
    super(
      `refusing to overwrite ${path}: a different artifact already exists at that path. ` +
        'An export that silently replaced a prior one would lose a record of something that was approved.',
    );
    this.name = 'ArtifactClobberError';
  }
}

export function writeArtifact(path, contents) {
  if (existsSync(path) && readFileSync(path, 'utf8') !== contents) {
    throw new ArtifactClobberError(path);
  }
  writeFileSync(path, contents);
}

// --- run -------------------------------------------------------------------------------

async function verbRun({ out, env, cwd }) {
  const base = runsDir(env, cwd);
  // Decisions a human recorded with `approve` / `reject`, layered over the shipped corpus. A
  // fresh clone has none, which is what keeps the README's example output true for everyone.
  const { run_id, ledger, report } = await executeFixtureRun({ decisions: loadDecisions(base) });
  const dir = join(base, run_id);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.jsonl'), ledger.toJSONL());

  const handoffDir = join(dir, 'handoffs');
  mkdirSync(handoffDir, { recursive: true });
  const handed = report.leads.filter((lead) => lead.output?.handoff !== undefined);
  for (const lead of handed) {
    const { adapter, filename, artifact } = lead.output.handoff;
    writeArtifact(join(handoffDir, filename), adapters[adapter].serialize(artifact));
  }

  // Parked drafts, written so `queue` has something to show a human and `approve` has
  // something to bind to. Named per lead AND per draft for the same reason exports are: two
  // different messages to one person must not collide.
  const parked = report.leads.filter(
    (lead) => lead.final_status === 'NEEDS_HUMAN' && lead.output?.draft_hash !== undefined,
  );
  if (parked.length > 0) {
    const parkedDir = join(dir, 'parked');
    mkdirSync(parkedDir, { recursive: true });
    for (const lead of parked) {
      writeArtifact(
        join(parkedDir, `${lead.lead_id}-${lead.output.draft_hash}.json`),
        `${JSON.stringify(
          {
            lead_id: lead.lead_id,
            draft_hash: lead.output.draft_hash,
            run_id,
            // From route, not from queue. The kernel adopts a stage's output only on PASS,
            // so a lead parked BY the queue stage never carries that stage's own output.
            owner: lead.output.route.owner,
            reason: lead.reason_codes.join(','),
            to: lead.output.draft.to,
            subject: lead.output.draft.subject,
            body: lead.output.draft.body,
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  // An explicit pointer to the run just written.
  //
  // "Latest" USED to mean the lexicographically last run id, and that is wrong: a run id is a
  // hash of the inputs, so its ordering is arbitrary and has nothing to do with time. Approving
  // a draft changes the inputs, so the next run's id can sort BEFORE the previous one, and
  // `queue` would then show a stale run's parked drafts and invite a human to approve a draft
  // that had already been decided. Caught by an intermittently failing workflow test.
  writeFileSync(join(base, LATEST_POINTER), `${run_id}\n`);

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
  // The real invocation form. There is no install step, so `signal-desk` is not on PATH in a
  // fresh clone and telling a reader to type it sends them into a "command not found".
  out(`  Inspect a decision with: node bin/signal-desk.mjs explain <lead>`);
  if (report.summary.NEEDS_HUMAN > 0) {
    out(`  Act on what is parked with: node bin/signal-desk.mjs queue`);
  }

  return 0;
}


// --- queue / approve / reject -----------------------------------------------------------
//
// The approval workflow. `run` parks drafts, `queue` shows them, `approve` and `reject` record
// a human decision BOUND TO THE DRAFT'S CONTENT HASH, and the next `run` honours it.

function latestRunDir(env, cwd) {
  const base = runsDir(env, cwd);
  const runId = latestRunId(base);
  return runId === null ? null : join(base, runId);
}

function parkedDrafts(env, cwd) {
  const dir = latestRunDir(env, cwd);
  if (dir === null) return null;
  const parkedDir = join(dir, 'parked');
  if (!existsSync(parkedDir)) return [];
  return readdirSync(parkedDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(parkedDir, name), 'utf8')));
}

// Resolves what a human typed to exactly one parked draft.
//
// Accepts a draft hash, a lead id, or any unambiguous PREFIX of either, because these are
// hashes and nobody is going to retype one correctly. An ambiguous prefix is an error rather
// than a guess: approving the wrong draft is the failure this whole design exists to prevent.
function resolveParked(drafts, id) {
  const exact = drafts.filter((d) => d.draft_hash === id || d.lead_id === id);
  const matches = exact.length > 0
    ? exact
    : drafts.filter((d) => d.draft_hash.startsWith(id) || d.lead_id.startsWith(id));

  if (matches.length === 0) return { error: `nothing parked matches "${id}"` };
  if (matches.length > 1) {
    return {
      error:
        `"${id}" matches ${matches.length} parked drafts: ` +
        `${matches.map((d) => d.draft_hash).join(', ')}. Use more characters.`,
    };
  }
  return { draft: matches[0] };
}

async function verbQueue({ out, err, env, cwd }) {
  const drafts = parkedDrafts(env, cwd);
  if (drafts === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return 2;
  }

  if (drafts.length === 0) {
    out('nothing is parked for a human.');
    out('');
    out('  Every lead in the last run either reached handoff or was refused.');
    return 0;
  }

  out(`${drafts.length} draft(s) awaiting a human`);
  out('');
  for (const draft of drafts) {
    out(`  ${draft.draft_hash}`);
    out(`    lead     ${draft.lead_id}`);
    out(`    to       ${draft.to}`);
    out(`    subject  ${draft.subject}`);
    out(`    owner    ${draft.owner}`);
    out(`    status   ${draft.reason}`);
    out('');
  }
  out('  Approve with: node bin/signal-desk.mjs approve <draft-hash>');
  out('  Reject with:  node bin/signal-desk.mjs reject <draft-hash> --note "why"');
  out('');
  out('  A decision binds to the draft hash above. Change the draft and it stops applying.');
  return 0;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function verbDecide(decision, { args, out, err, env, cwd, now }) {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    err(`${decision} needs a draft hash or lead id. Try: node bin/signal-desk.mjs queue`);
    return 2;
  }

  const drafts = parkedDrafts(env, cwd);
  if (drafts === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return 2;
  }

  const resolved = resolveParked(drafts, id);
  if (resolved.error !== undefined) {
    err(resolved.error);
    return 2;
  }

  const { draft } = resolved;

  // Deciding the same way twice is not an error and not news. Say so, record nothing, and exit
  // zero. Appending a duplicate would grow the store with lines that change nothing and make
  // the history harder to read, which is the opposite of what the store is for.
  //
  // A DIFFERENT decision is a different thing to say, so it is recorded and the latest binds.
  const standing = decisionFor(loadDecisionEntries(runsDir(env, cwd)), draft.draft_hash);
  if (standing !== undefined && standing.decision === decision) {
    out(`${draft.draft_hash} was already ${decision === 'approve' ? 'approved' : 'rejected'}`);
    out('');
    out(`  by       ${standing.by}`);
    out(`  at       ${standing.at}`);
    out('');
    out('  Nothing recorded; that decision already stands for this exact draft.');
    return 0;
  }

  let written;
  try {
    written = appendDecision(runsDir(env, cwd), {
      draft_hash: draft.draft_hash,
      lead_id: draft.lead_id,
      decision,
      by: flagValue(args, '--by') ?? 'cli-operator',
      at: now(),
      note: flagValue(args, '--note'),
      run_id: draft.run_id,
    });
  } catch (error) {
    err(error.message);
    return 1;
  }

  out(`${decision === 'approve' ? 'approved' : 'rejected'} ${draft.draft_hash}`);
  out('');
  out(`  lead     ${draft.lead_id}`);
  out(`  to       ${draft.to}`);
  out(`  subject  ${draft.subject}`);
  out(`  by       ${written.by}`);
  out('');
  out(`  recorded in ${relative(cwd, decisionsPath(runsDir(env, cwd))) || decisionsPath(runsDir(env, cwd))}`);
  out('  This decision covers that exact draft. Edit the text and it stops applying.');
  out('');
  out('  Run again to act on it: node bin/signal-desk.mjs run');
  return 0;
}

// --- explain ---------------------------------------------------------------------------

async function verbExplain({ args, out, err, env, cwd }) {
  const leadId = args[0];
  if (leadId === undefined) {
    err('explain needs a lead id. Try: node bin/signal-desk.mjs explain <lead>');
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
  const runId = latestRunId(runsDir(env, cwd));
  if (runId === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return null;
  }
  return parseLedger(readFileSync(join(runsDir(env, cwd), runId, 'ledger.jsonl'), 'utf8'));
}

// --- replay ----------------------------------------------------------------------------

async function verbReplay({ args, out, err, env, cwd }) {
  const runId = args[0];
  if (runId === undefined) {
    err('replay needs a run id. Try: node bin/signal-desk.mjs replay <run>');
    return 2;
  }

  const path = join(runsDir(env, cwd), runId, 'ledger.jsonl');
  if (!existsSync(path)) {
    err(`run ${runId} not found at ${path}`);
    return 2;
  }

  const recorded = readFileSync(path, 'utf8');
  const recordedEntries = parseLedger(recorded);

  if (recordedEntries.length === 0) {
    err(`run ${runId} has an empty ledger, so there is nothing to replay`);
    return 1;
  }

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

  // Completeness, which the chain does not cover. Every entry links to the one before it, so
  // nothing can be edited or reordered undetected, and yet nothing in that says the last line
  // here is the last line that was written. Truncating a ledger leaves a chain that verifies
  // perfectly clean. The seal is the terminal entry a completed run appends, so its absence is
  // how a truncation becomes visible.
  if (!isSealed(recordedEntries)) {
    err(`run ${runId} has no terminal seal, so it is not a record of a completed run`);
    err('the chain verified, which means nothing was edited. Lines were removed from the end,');
    err('or the run never finished. A hash chain proves order, not completeness.');
    return 1;
  }

  const seal = sealOf(recordedEntries);
  out(
    `seal verified: ${seal.summary.PASS} passed, ${seal.summary.NEEDS_HUMAN} parked, ` +
      `${seal.summary.REFUSE} refused, ${seal.summary.total} in total`,
  );

  // The decisions have to be layered in exactly as `run` layers them, or this re-execution is
  // not a re-execution of the same run. Omitting them rebuilt the run from the fixture corpus
  // alone, which produced the fixture-only run id and reported "the inputs or the wiring have
  // changed" at the happy path's final step, blaming the user for a wiring bug.
  const { ledger, ctx, stages, signals, run_id } = buildRun({
    fixtures: loadFixtures(),
    decisions: loadDecisions(runsDir(env, cwd)),
  });
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
  // Injected, like the pipeline's clock. A human decision happens at a real instant rather
  // than a pipeline position, and a test that needs a fixed one should not have to freeze
  // the process clock to get it.
  now = () => new Date().toISOString(),
} = {}) {
  const [verb, ...args] = argv;
  const context = { args, out, err, env, cwd, now };

  switch (verb) {
    case 'run':
      return verbRun(context);
    case 'queue':
      return verbQueue(context);
    case 'approve':
      return verbDecide('approve', context);
    case 'reject':
      return verbDecide('reject', context);
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
