// The approval workflow, end to end through the real CLI.
//
// These run the binary as a SUBPROCESS rather than calling main() in-process. The workflow
// spans three invocations that communicate only through files on disk — run parks a draft,
// approve writes a decision, run reads it back — so the level where it assembles is the level
// where it has to be proven. An in-process test would share module state across all three and
// could pass while the real thing was broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');

function cli(args, cwd) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    // A bare environment. Nothing here could authenticate anything, so a green run is proof
    // the approval loop is as keyless as the pipeline.
    env: { PATH: process.env.PATH, HOME: cwd },
  });
}

function inWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'signal-desk-approve-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parkedHash(output) {
  const match = output.match(/draft-[0-9a-f]{16}/);
  assert.ok(match, 'the queue listing names a draft hash');
  return match[0];
}

// --- queue ------------------------------------------------------------------------------

test('queue before any run says so rather than showing an empty list', () => {
  inWorkspace((dir) => {
    assert.throws(() => cli(['queue'], dir), /no runs found/i);
  });
});

test('queue lists the parked draft with its content hash, recipient and subject', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const output = cli(['queue'], dir);
    assert.match(output, /1 draft\(s\) awaiting a human/);
    assert.match(output, /draft-[0-9a-f]{16}/);
    assert.match(output, /sam@northwind\.test/);
    assert.match(output, /AWAITING_APPROVAL/);
  });
});

test('queue tells the reader a decision binds to content, not to the lead', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    assert.match(cli(['queue'], dir), /binds to the draft hash/i);
  });
});

test('queue advertises only invocations that work in a fresh clone', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const output = cli(['queue'], dir);
    assert.match(output, /node bin\/signal-desk\.mjs approve/);
    assert.doesNotMatch(output, /^\s*signal-desk approve/m, 'not the un-installed bare command');
  });
});

// --- approve ----------------------------------------------------------------------------

test('approve records a decision and the next run carries that lead to handoff', () => {
  inWorkspace((dir) => {
    const first = cli(['run'], dir);
    assert.match(first, /1 awaiting a human/);

    const hash = parkedHash(cli(['queue'], dir));
    cli(['approve', hash, '--by', 'dana.reviewer'], dir);

    const second = cli(['run'], dir);
    assert.match(second, /2 passed to handoff/);
    assert.match(second, /0 awaiting a human/);
  });
});

test('an unambiguous prefix is enough, because nobody retypes a hash', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    const output = cli(['approve', hash.slice(0, 10)], dir);
    assert.match(output, new RegExp(`approved ${hash}`));
  });
});

test('a lead id resolves too, since that is what the run summary prints', () => {
  inWorkspace((dir) => {
    const first = cli(['run'], dir);
    const leadId = first.match(/lead-[0-9a-f]{12}\s+queue\s+NEEDS_HUMAN/)[0].split(/\s+/)[0];
    assert.match(cli(['approve', leadId], dir), /approved draft-/);
  });
});

test('an id matching nothing is an error, not a silent no-op', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    assert.throws(() => cli(['approve', 'draft-nothinglikethis'], dir), /nothing parked matches/i);
  });
});

test('approve with no id points the reader at queue', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    assert.throws(() => cli(['approve'], dir), /needs a draft hash|queue/i);
  });
});

test('the approval names the draft it covers, not just the lead', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    const output = cli(['approve', hash], dir);
    assert.match(output, new RegExp(hash));
    assert.match(output, /covers that exact draft/i);
  });
});

// --- reject -----------------------------------------------------------------------------

test('reject records a refusal and the next run stops that lead at the queue', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    cli(['reject', hash, '--note', 'wrong persona'], dir);

    const second = cli(['run'], dir);
    assert.match(second, /REJECTED_BY_HUMAN/);
    assert.match(second, /1 passed to handoff/, 'the rejected lead did not go out');
  });
});

test('after deciding on everything, queue reports nothing parked', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    cli(['approve', parkedHash(cli(['queue'], dir))], dir);
    cli(['run'], dir);
    assert.match(cli(['queue'], dir), /nothing is parked/i);
  });
});

// --- the decision store is itself a ledger ------------------------------------------------

test('decisions are written as hash-chained ledger entries with actor human', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    cli(['approve', parkedHash(cli(['queue'], dir)), '--by', 'dana.reviewer'], dir);

    const lines = readFileSync(join(dir, 'runs', 'approvals.jsonl'), 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.actor, 'human');
    assert.equal(entry.stage, 'approval');
    assert.equal(entry.decision, 'approve');
    assert.equal(entry.by, 'dana.reviewer');
    assert.match(entry.draft_hash, /^draft-[0-9a-f]{16}$/);
    assert.ok(entry.hash && entry.prev, 'it is chained like any other ledger entry');
  });
});

test('a tampered decision store is refused, so an authorisation cannot be rewritten', () => {
  // The reason the store is a chain rather than a plain list. Rewriting WHICH DRAFT a decision
  // covers is precisely the attack the content hash exists to stop, so the file holding the
  // binding gets the same tamper-evidence as the run ledger.
  inWorkspace((dir) => {
    cli(['run'], dir);
    cli(['approve', parkedHash(cli(['queue'], dir))], dir);

    const path = join(dir, 'runs', 'approvals.jsonl');
    const entry = JSON.parse(readFileSync(path, 'utf8').trim());
    entry.draft_hash = 'draft-ffffffffffffffff';
    writeFileSync(path, `${JSON.stringify(entry)}\n`);

    assert.throws(() => cli(['run'], dir), /broken hash chain|edited after it was written/i);
  });
});

test('a second decision on the same draft supersedes the first, and both stay on record', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    cli(['reject', hash, '--note', 'changed my mind later'], dir);
    cli(['approve', hash], dir);

    const lines = readFileSync(join(dir, 'runs', 'approvals.jsonl'), 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2, 'the superseded decision is still there');
    assert.match(cli(['run'], dir), /2 passed to handoff/, 'and the latest one binds');
  });
});

// --- the binding, visible in the artifacts the run produces --------------------------------

test('the approved draft hash appears in the ledger trail as a human decision', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    const leadId = cli(['queue'], dir).match(/lead-[0-9a-f]{12}/)[0];
    cli(['approve', hash, '--by', 'dana.reviewer'], dir);
    cli(['run'], dir);

    const trail = cli(['explain', leadId], dir);
    assert.match(trail, /APPROVED_BY_HUMAN/);
    assert.match(trail, new RegExp(hash), 'the trail names the draft that was authorised');
    assert.match(trail, /PASS at handoff/);
  });
});

test('the exported artifact is named for the draft hash that was approved', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    cli(['approve', hash], dir);
    const output = cli(['run'], dir);
    const runId = output.match(/run-[0-9a-f]{12}/)[0];

    const files = readdirSync(join(dir, 'runs', runId, 'handoffs'));
    assert.ok(
      files.some((name) => name.includes(hash)),
      'the export carries the hash of the draft a human actually approved',
    );
  });
});

test('a parked draft is written to disk so queue and approve have something to bind to', () => {
  inWorkspace((dir) => {
    const output = cli(['run'], dir);
    const runId = output.match(/run-[0-9a-f]{12}/)[0];
    const parkedDir = join(dir, 'runs', runId, 'parked');
    assert.ok(existsSync(parkedDir));
    const files = readdirSync(parkedDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^lead-[0-9a-f]{12}-draft-[0-9a-f]{16}\.json$/);

    const parked = JSON.parse(readFileSync(join(parkedDir, files[0]), 'utf8'));
    assert.equal(parked.owner, 'sdr-queue', 'the owner who would act on it');
    assert.equal(parked.reason, 'AWAITING_APPROVAL');
    assert.ok(parked.body.includes('Hi Sam'), 'and the message a human is deciding on');
  });
});

// --- the loop stays keyless ----------------------------------------------------------------

test('the whole approval loop runs with no key and no network', () => {
  // cli() already passes a bare environment carrying only PATH and HOME. Reaching this
  // assertion at all is the proof; it is stated so the guarantee is not incidental.
  inWorkspace((dir) => {
    cli(['run'], dir);
    cli(['approve', parkedHash(cli(['queue'], dir))], dir);
    assert.match(cli(['run'], dir), /2 passed to handoff/);
  });
});

// --- "latest run" means most recent, never lexicographically last -------------------------
//
// A real bug, found by this file failing intermittently rather than by inspection.
//
// A run id is a hash of the run's inputs, so its ordering is arbitrary. Approving a draft
// changes the inputs, so the next run's id sorts before the previous one roughly half the
// time. The old resolver sorted ids and took the last, which meant `queue` would sometimes
// show a STALE run's parked drafts and invite a human to approve a draft already decided.

test('queue reads the most recent run even when its id sorts below an older one', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    cli(['approve', hash], dir);
    const second = cli(['run'], dir);
    const secondId = second.match(/run-[0-9a-f]{12}/)[0];

    const ids = readdirSync(join(dir, 'runs')).filter((n) => n.startsWith('run-')).sort();
    assert.equal(ids.length, 2, 'two runs exist to choose between');

    // Whether or not this particular pair happens to sort the wrong way, the answer must come
    // from what ran last, so assert against that rather than against the sort.
    assert.match(cli(['queue'], dir), /nothing is parked/i);
    assert.equal(readFileSync(join(dir, 'runs', 'latest'), 'utf8').trim(), secondId);
  });
});

test('the run writes an explicit pointer to itself, rather than leaving it to be inferred', () => {
  inWorkspace((dir) => {
    const output = cli(['run'], dir);
    const runId = output.match(/run-[0-9a-f]{12}/)[0];
    assert.equal(readFileSync(join(dir, 'runs', 'latest'), 'utf8').trim(), runId);
  });
});

test('explain reads the most recent run too, since it had the same defect', () => {
  inWorkspace((dir) => {
    cli(['run'], dir);
    const hash = parkedHash(cli(['queue'], dir));
    const leadId = cli(['queue'], dir).match(/lead-[0-9a-f]{12}/)[0];
    cli(['approve', hash], dir);
    cli(['run'], dir);

    // In the stale run this lead ended NEEDS_HUMAN at queue. In the current one it reached
    // handoff. Reading the wrong run would report the wrong outcome to a human.
    assert.match(cli(['explain', leadId], dir), /PASS at handoff/);
  });
});
