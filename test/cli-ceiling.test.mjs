// The lead ceiling at the CLI. docs/LEAD-CEILING-SPEC.md.
//
// The start-time refusal is the one an operator meets: a signals folder holding more leads than the
// ceiling refuses before a single URL is fetched or a model is called, and says the count and the
// ceiling. Driven in process with a transport that records every call, so "nothing was fetched" is
// the length of an array, and as a real subprocess where no transport is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, USAGE } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';
import { writeDeadLetter } from '../src/live/dlq.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');
const SECRET = 'ceiling-cli-secret';
const KEY = 'sk-ant-canary-ceiling-0000';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function writeSignals(dir, count) {
  for (let index = 1; index <= count; index += 1) {
    const domain = `co${index}.example.com`;
    const bytes = JSON.stringify({
      id: `sig-${index}`,
      source: 'rb2b',
      received_at: new Date().toISOString(),
      payload: {
        company: { name: `Company ${index}`, domain },
        contact: { name: 'Pat Example', email: `pat@${domain}`, title: 'VP Revenue Operations' },
        intent: { page: '/pricing', visits: 2 },
        sources: [`https://${domain}/about`],
      },
    });
    const name = String(index).padStart(4, '0');
    writeFileSync(join(dir, `${name}.json`), bytes);
    writeFileSync(join(dir, `${name}.json.sig`), `${signRaw(SECRET, bytes)}\n`);
  }
}

// Every source answers 404, so an admitted lead refuses at enrich and the model is never reached.
function recordingTransport() {
  const calls = [];
  return {
    calls,
    transport: async (url, options) => {
      calls.push({ url, method: options?.method });
      return { status: 404, headers: { get: () => null }, text: async () => '{}' };
    },
  };
}

async function cli(argv, { runs, env = {}, transport } = {}) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: {
      SIGNAL_DESK_RUNS_DIR: runs,
      SIGNAL_DESK_ANTHROPIC_KEY: KEY,
      SIGNAL_DESK_SIGNAL_SECRET: SECRET,
      ...env,
    },
    cwd: ROOT,
    httpTransport: transport,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// --- the start-time refusal ---------------------------------------------------------------------

test('run --live over its ceiling refuses to START, names the count and the ceiling, and fetches nothing', async () => {
  const runs = tmp('ceil-over');
  const signals = tmp('ceil-over-signals');
  writeSignals(signals, 3);
  const fake = recordingTransport();

  const { code, stderr } = await cli(['run', '--live', '--signals', signals, '--max-leads', '2'], {
    runs,
    transport: fake.transport,
  });

  assert.equal(code, 2);
  assert.match(stderr, /LEAD_CEILING_EXCEEDED/);
  assert.match(stderr, /3 signal\(s\)/, 'it names the count');
  assert.match(stderr, /ceiling of 2/, 'and the ceiling');
  assert.match(stderr, /--max-leads/, 'and how to raise it');
  assert.equal(fake.calls.length, 0, 'not one request was made');
  assert.deepEqual(readdirSync(runs), [], 'no run, no ledger, no dead letter was written');
});

test('with no flag, the default ceiling of 10 applies', async () => {
  const runs = tmp('ceil-default');
  const signals = tmp('ceil-default-signals');
  writeSignals(signals, 11);
  const fake = recordingTransport();

  const { code, stderr } = await cli(['run', '--live', '--signals', signals], { runs, transport: fake.transport });

  assert.equal(code, 2);
  assert.match(stderr, /11 signal\(s\)/);
  assert.match(stderr, /ceiling of 10/);
  assert.equal(fake.calls.length, 0);
});

test('a run AT its ceiling runs, and the capture records the ceiling it ran under', async () => {
  const runs = tmp('ceil-at');
  const signals = tmp('ceil-at-signals');
  writeSignals(signals, 2);
  const fake = recordingTransport();

  const { code, stdout } = await cli(['run', '--live', '--signals', signals, '--max-leads', '2'], {
    runs,
    transport: fake.transport,
  });

  assert.equal(code, 0);
  assert.match(stdout, /2 signals in total/);
  assert.ok(fake.calls.length > 0, 'the admitted leads reached their sources');
  const runId = readFileSync(join(runs, 'latest'), 'utf8').trim();
  const inputs = JSON.parse(readFileSync(join(runs, runId, 'inputs.json'), 'utf8'));
  assert.deepEqual(inputs.config.limits, { maxLeads: 2, countedFrom: 'enrich' });
});

// --- values that bound nothing, refused ---------------------------------------------------------

test('a ceiling of zero, a negative one, a non-number or no value at all refuses before anything runs', async () => {
  const signals = tmp('ceil-bad-signals');
  writeSignals(signals, 1);
  for (const value of [['0'], ['-1'], ['abc'], ['2.5'], []]) {
    const runs = tmp('ceil-bad');
    const fake = recordingTransport();
    const { code, stderr } = await cli(['run', '--live', '--signals', signals, '--max-leads', ...value], {
      runs,
      transport: fake.transport,
    });
    assert.equal(code, 2, `--max-leads ${value.join(' ')} should refuse`);
    assert.match(stderr, /LEAD_CEILING_INVALID/);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(readdirSync(runs), []);
  }
});

test('an invalid ceiling is refused before the credentials are even read', () => {
  const runs = tmp('ceil-bad-nokey');
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BIN, 'run', '--live', '--max-leads', '0'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr;
  }
  assert.equal(status, 2);
  assert.match(stderr, /LEAD_CEILING_INVALID/);
  assert.doesNotMatch(stderr, /LIVE_KEY_MISSING/);
});

test('--max-leads on a FIXTURE run refuses rather than being silently ignored', () => {
  const runs = tmp('ceil-fixture');
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BIN, 'run', '--max-leads', '5'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr;
  }
  assert.equal(status, 2);
  // Not the generic unknown-flag refusal: the flag is known, and the CLI says why it does not apply.
  assert.doesNotMatch(stderr, /unknown flag/);
  assert.match(stderr, /--max-leads bounds a live run/);
  assert.match(stderr, /run --live/);
  assert.deepEqual(readdirSync(runs), [], 'the fixture run did not run');
});

// --- dlq --replay is a live run too ------------------------------------------------------------

function deadLetters(runs, count) {
  for (let index = 1; index <= count; index += 1) {
    writeDeadLetter(runs, {
      reason: 'SIGNATURE_INVALID',
      source: `${index}.json`,
      signal_id: `sig-${index}`,
      signature: 'bad',
      raw: JSON.stringify({ id: `sig-${index}` }),
    });
  }
}

test('dlq --replay is held to the same ceiling, because a re-fed lead bills like a fresh one', async () => {
  const runs = tmp('ceil-dlq');
  deadLetters(runs, 3);
  const fake = recordingTransport();

  const { code, stderr } = await cli(['dlq', '--replay', '--max-leads', '2'], { runs, transport: fake.transport });

  assert.equal(code, 2);
  assert.match(stderr, /LEAD_CEILING_EXCEEDED/);
  assert.match(stderr, /3 signal\(s\)/);
  assert.equal(fake.calls.length, 0);
});

test('dlq --max-leads without --replay refuses, since listing bills nothing', async () => {
  const runs = tmp('ceil-dlq-list');
  const { code, stderr } = await cli(['dlq', '--max-leads', '2'], { runs });
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /unknown flag/);
  assert.match(stderr, /--max-leads bounds a replay/);
  assert.match(stderr, /dlq --replay --max-leads/);
});

// --- freshness ---------------------------------------------------------------------------------

test('the usage text documents the ceiling, its default and both verbs that take it', () => {
  assert.match(USAGE, /run\s+--live, --signals <dir>, --max-leads <n>/);
  assert.match(USAGE, /dlq\s+--replay, --max-leads <n>/);
  assert.match(USAGE, /ceiling/);
  assert.match(USAGE, /10/);
});
