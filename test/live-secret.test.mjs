// The signing secret and the shareable capture. M4 ship-check BLOCKER 2.
//
// THE FINDING. Every live run wrote `config.ingest.secret` verbatim into `inputs.json` — the one
// artifact the README tells you to hand to other people. The key-hygiene test set a canary secret
// and only ever grepped for the model KEY, which is why 830 tests passed over a plaintext
// credential in a file whose whole purpose is being shared.
//
// THE TENSION IS REAL, and it is why this is a decision rather than a deletion. Replay re-executes
// ingest, and in raw mode ingest verifies an HMAC, which needs the secret. Removing it from the
// capture removes something replay was using.
//
// THE DECISION, argued in docs/M4-SPEC.md and in src/live/keys.mjs:
//
//   The capture stores a SALTED, TRUNCATED, NON-REVERSIBLE FINGERPRINT and never the secret.
//   Replay resolves the secret from the environment, exactly as the live run did.
//
//     with the matching secret   full re-execution, byte comparison, signatures re-verified
//     with a DIFFERENT secret    refused, named, rather than a confusing byte divergence
//     with no secret             chain and seal verified, and it SAYS the signatures were not
//                                re-verified and names the variable that would allow it
//
// The third row is the honest part. A replay that silently skipped a check the original run
// performed would claim more than it verified, and "it matched" would quietly stop meaning what a
// reader thinks it means. The fingerprint is what makes the second row possible at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw, ingest } from '../src/stages/ingest.mjs';
import { secretFingerprint } from '../src/live/keys.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');

// A secret distinctive enough that finding it anywhere is unambiguous.
const SECRET = 'SIGNING-SECRET-CANARY-7c2f91a4-DO-NOT-PERSIST';
const KEY = 'sk-ant-canary-0b1d';
const SOURCE = 'https://directory.example.com/company/acme.example.com';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function json(body, status = 200) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

const DRAFT = {
  subject: 'A question about Acme Robotics',
  body: 'Hi Dana,\n\nAt around 240 people, who decides which inbound signals get a human reply?\n\nWorth a short conversation?',
  claim_refs: [{ field: 'employee_count', citation: SOURCE }],
};
const VERDICT = {
  verdict: 'PASS',
  criteria: [
    { name: 'claim_grounding', verdict: 'PASS' },
    { name: 'audience_fit', verdict: 'PASS' },
    { name: 'tone', verdict: 'PASS' },
  ],
};

const transport = async (url, options) => {
  if (options.method === 'POST') {
    const payload = options.body.includes('release gate') ? VERDICT : DRAFT;
    return json({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] });
  }
  if (url === SOURCE) {
    return json({ as_of: new Date(Date.now() - 86400000).toISOString(), claims: { employee_count: 240 } });
  }
  return json({}, 404);
};

async function liveRun(runs) {
  const signals = tmp('secret-signals');
  const body = {
    id: 'sig-secret-1',
    source: 'probe',
    received_at: new Date().toISOString(),
    payload: {
      company: { name: 'Acme Robotics', domain: 'acme.example.com' },
      contact: { name: 'Dana Ruiz', email: 'dana@acme.example.com', title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 4 },
      sources: [SOURCE],
    },
  };
  const bytes = JSON.stringify(body, null, 2);
  writeFileSync(join(signals, '0001.json'), bytes);
  writeFileSync(join(signals, '0001.json.sig'), `${signRaw(SECRET, bytes)}\n`);

  const lines = [];
  await main({
    argv: ['run', '--live', '--signals', signals],
    out: (line) => lines.push(String(line)),
    err: (line) => lines.push(String(line)),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: KEY, SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
    httpTransport: transport,
  });
  return readFileSync(join(runs, 'latest'), 'utf8').trim();
}

function replay(runs, runId, env = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [BIN, 'replay', runId], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs, ...env },
      }),
      stderr: '',
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// --- the capture holds no secret -------------------------------------------------------------

test('the capture carries NO signing secret, in any form', async () => {
  const runs = tmp('secret-capture');
  const runId = await liveRun(runs);
  const inputs = readFileSync(join(runs, runId, 'inputs.json'), 'utf8');

  assert.ok(!inputs.includes(SECRET), 'the artifact the README says you can share carries no credential');
  assert.equal(JSON.parse(inputs).config.ingest.secret, undefined, 'and not under its own key either');
});

test('the capture carries a fingerprint instead, so a replayer can be told they have the wrong secret', async () => {
  const runs = tmp('secret-fp');
  const runId = await liveRun(runs);
  const inputs = JSON.parse(readFileSync(join(runs, runId, 'inputs.json'), 'utf8'));

  assert.equal(inputs.config.ingest.secret_fingerprint, secretFingerprint(SECRET));
  assert.notEqual(inputs.config.ingest.secret_fingerprint, SECRET);
});

test('the fingerprint is a function of the secret and nothing else', () => {
  assert.equal(secretFingerprint('a-secret'), secretFingerprint('a-secret'));
  assert.notEqual(secretFingerprint('a-secret'), secretFingerprint('a-secret '));
  assert.match(secretFingerprint('a-secret'), /^[0-9a-f]{16}$/);
  assert.ok(!secretFingerprint('a-secret').includes('a-secret'));
});

// --- what replay can and cannot prove --------------------------------------------------------

test('replay WITH the secret re-executes fully and says the signatures were re-verified', async () => {
  const runs = tmp('secret-replay-ok');
  const runId = await liveRun(runs);
  const result = replay(runs, runId, { SIGNAL_DESK_SIGNAL_SECRET: SECRET });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /is an exact match/);
  assert.match(result.stdout, /signature/i);
  assert.match(result.stdout, /re-verified/i);
});

test('replay WITHOUT the secret verifies the chain and seal and SAYS what it could not check', async () => {
  // The honest degradation. It does not re-execute, because re-executing with no secret would skip
  // a check the original run performed and then report "exact match", which claims more than it
  // verified. What a reader needs is the difference spelled out, plus the variable that closes it.
  const runs = tmp('secret-replay-bare');
  const runId = await liveRun(runs);
  const result = replay(runs, runId);

  assert.equal(result.status, 0, 'the chain and the seal did verify, so this is not a failure');
  assert.match(result.stdout, /hash chain verified/);
  assert.match(result.stdout, /seal verified/);
  assert.match(result.stdout, /not re-verified|were NOT/i);
  assert.match(result.stdout, /SIGNAL_DESK_SIGNAL_SECRET/, 'it names the variable that allows full re-execution');
  assert.ok(!result.stdout.includes('is an exact match'), 'and it does not claim a byte match it did not make');
});

test('replay with the WRONG secret is REFUSED, rather than diverging confusingly', async () => {
  // Without the fingerprint this case produces a byte mismatch and the message "the inputs or the
  // wiring have changed", which sends the reader to look for a code change that does not exist.
  const runs = tmp('secret-replay-wrong');
  const runId = await liveRun(runs);
  const result = replay(runs, runId, { SIGNAL_DESK_SIGNAL_SECRET: 'a-different-secret' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECRET_MISMATCH/);
  assert.ok(!result.stderr.includes(SECRET), 'and the refusal does not quote the real secret');
});

test('a FIXTURE run still replays with no environment at all', async () => {
  // The keyless promise for the demo path is untouched: its secret is a committed constant, not a
  // credential, and nothing about this decision changes what a stranger can verify.
  const runs = tmp('secret-fixture');
  execFileSync(process.execPath, [BIN, 'run'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  const runId = readFileSync(join(runs, 'latest'), 'utf8').trim();
  const result = replay(runs, runId);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /is an exact match/);
});

// --- ingest must never read "no secret" as permission to skip --------------------------------

test('raw mode with NO secret REFUSES, because raw mode is a declaration that signatures matter', async () => {
  // Defence in depth for the decision above. ingest skips verification when no secret is
  // configured, which is right for a pipeline nobody gave one. In RAW mode that is never right: raw
  // mode is an explicit statement that signatures are verified over bytes, so a missing secret is a
  // misconfiguration and not a permission.
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'live', ingest: { signatureOver: 'raw', replayWindowMs: 300000 } },
    run_id: 'run-test',
  });
  const raw = JSON.stringify({
    id: 'sig-1',
    source: 'probe',
    received_at: '2026-03-01T08:59:00.000Z',
    payload: {
      company: { name: 'Acme', domain: 'acme.example.com' },
      contact: { name: 'Dana', email: 'dana@acme.example.com' },
    },
  });

  const result = await ingest.run({ ...JSON.parse(raw), raw, signature: 'whatever' }, ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_MISSING']);
  assert.match(result.detail, /secret/i);
});
