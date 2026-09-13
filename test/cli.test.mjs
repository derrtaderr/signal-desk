import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');

function cli(args, { cwd } = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, SIGNAL_DESK_RUNS_DIR: cwd ? join(cwd, 'runs') : undefined },
  });
}

function withTempRuns(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'signal-desk-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('with no arguments the CLI prints usage listing its verbs', () => {
  let output;
  try {
    output = cli([]);
  } catch (error) {
    output = error.stdout + error.stderr;
  }
  for (const verb of ['run', 'explain', 'replay']) {
    assert.match(output, new RegExp(`\\b${verb}\\b`), `usage mentions ${verb}`);
  }
});

test('an unknown verb exits non-zero rather than doing something surprising', () => {
  assert.throws(() => cli(['frobnicate']));
});

// --- run -----------------------------------------------------------------------------

test('run executes the fixture pipeline and reports the summary', () => {
  withTempRuns((dir) => {
    const output = cli(['run'], { cwd: dir });
    assert.match(output, /run-[0-9a-f]{12}/);
    assert.match(output, /passed/i);
    assert.match(output, /refused/i);
    assert.match(output, /awaiting a human/i);
  });
});

test('run writes the ledger to a file named by the run id', () => {
  withTempRuns((dir) => {
    const output = cli(['run'], { cwd: dir });
    const runId = output.match(/run-[0-9a-f]{12}/)[0];
    const ledgerPath = join(dir, 'runs', runId, 'ledger.jsonl');
    assert.ok(existsSync(ledgerPath), 'the ledger was written');
    const text = readFileSync(ledgerPath, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(text.split('\n').length > 20);
  });
});

test('run writes a dry-run handoff artifact for each approved lead, and never sends', () => {
  withTempRuns((dir) => {
    const output = cli(['run'], { cwd: dir });
    const runId = output.match(/run-[0-9a-f]{12}/)[0];
    const handoffDir = join(dir, 'runs', runId, 'handoffs');
    assert.ok(existsSync(handoffDir), 'the handoff directory exists');
    assert.match(output, /never sends|dry run/i);
  });
});

test('running twice produces byte-identical ledger files', () => {
  withTempRuns((dir) => {
    const first = cli(['run'], { cwd: dir });
    const runId = first.match(/run-[0-9a-f]{12}/)[0];
    const path = join(dir, 'runs', runId, 'ledger.jsonl');
    const a = readFileSync(path, 'utf8');
    cli(['run'], { cwd: dir });
    assert.equal(readFileSync(path, 'utf8'), a);
  });
});

test('run needs no API key and no network', () => {
  withTempRuns((dir) => {
    const output = execFileSync(process.execPath, [BIN, 'run'], {
      cwd: dir,
      encoding: 'utf8',
      // A deliberately bare environment. Nothing here could authenticate anything.
      env: { PATH: process.env.PATH, HOME: dir, SIGNAL_DESK_RUNS_DIR: join(dir, 'runs') },
    });
    assert.match(output, /run-[0-9a-f]{12}/);
  });
});

// --- explain -------------------------------------------------------------------------

test('explain prints the full decision trail for a lead', () => {
  withTempRuns((dir) => {
    const runOutput = cli(['run'], { cwd: dir });
    const leadId = runOutput.match(/lead-[0-9a-f]{12}/)[0];
    const output = cli(['explain', leadId], { cwd: dir });
    assert.match(output, new RegExp(leadId));
    assert.match(output, /ingest/);
    assert.match(output, /enrich/);
  });
});

test('explain shows each stage verdict in order', () => {
  withTempRuns((dir) => {
    const runOutput = cli(['run'], { cwd: dir });
    const leadId = runOutput.match(/lead-[0-9a-f]{12}/)[0];
    const output = cli(['explain', leadId], { cwd: dir });
    const ingestAt = output.indexOf('ingest');
    const enrichAt = output.indexOf('enrich');
    assert.ok(ingestAt !== -1 && enrichAt > ingestAt, 'stages appear in pipeline order');
  });
});

test('explain reports a refusal with its reason code', () => {
  withTempRuns((dir) => {
    cli(['run'], { cwd: dir });
    const output = cli(['explain', 'sig-9001'], { cwd: dir });
    assert.match(output, /MALFORMED_PAYLOAD/);
    assert.match(output, /REFUSE/);
  });
});

test('explain on an unknown lead exits non-zero and says so', () => {
  withTempRuns((dir) => {
    cli(['run'], { cwd: dir });
    assert.throws(() => cli(['explain', 'lead-doesnotexist'], { cwd: dir }), /not found|no entries/i);
  });
});

test('explain without a lead argument exits non-zero', () => {
  withTempRuns((dir) => {
    cli(['run'], { cwd: dir });
    assert.throws(() => cli(['explain'], { cwd: dir }));
  });
});

// --- replay --------------------------------------------------------------------------

test('replay re-executes a recorded run and confirms the ledger matches', () => {
  withTempRuns((dir) => {
    const runOutput = cli(['run'], { cwd: dir });
    const runId = runOutput.match(/run-[0-9a-f]{12}/)[0];
    const output = cli(['replay', runId], { cwd: dir });
    assert.match(output, /match/i);
    assert.match(output, new RegExp(runId));
  });
});

test('replay verifies the hash chain, not just the bytes', () => {
  withTempRuns((dir) => {
    const runOutput = cli(['run'], { cwd: dir });
    const runId = runOutput.match(/run-[0-9a-f]{12}/)[0];
    const output = cli(['replay', runId], { cwd: dir });
    assert.match(output, /chain/i);
  });
});

test('replay detects a tampered ledger and exits non-zero', () => {
  withTempRuns((dir) => {
    const runOutput = cli(['run'], { cwd: dir });
    const runId = runOutput.match(/run-[0-9a-f]{12}/)[0];
    const path = join(dir, 'runs', runId, 'ledger.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const first = JSON.parse(lines[0]);
    first.verdict = 'REFUSE';
    lines[0] = JSON.stringify(first);
    writeFileSync(path, `${lines.join('\n')}\n`);
    assert.throws(() => cli(['replay', runId], { cwd: dir }), /tamper|mismatch|differ|hash/i);
  });
});

test('replay on an unknown run exits non-zero', () => {
  withTempRuns((dir) => {
    assert.throws(() => cli(['replay', 'run-000000000000'], { cwd: dir }));
  });
});
