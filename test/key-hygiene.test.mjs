// The key-hygiene gate. M4 spec §10.
//
// A REPO-HYGIENE-CLASS TEST, like test/repo-hygiene.test.mjs and test/no-network.test.mjs. It does
// not test a feature. It tests a property the whole repo has to keep, and it exists because the
// property is one nobody can verify by reading: a credential leaks through whichever path somebody
// forgot about, and the paths somebody forgets about are the error paths.
//
// THE METHOD. Run a live-shaped flow end to end with a canary key value through fake transports,
// then read EVERY FILE THE RUN WROTE and every line it printed, and assert the canary is in none of
// them. Not "the ledger does not carry the key" — every artifact, including the dashboard, the
// dead-letter queue, and the capture that exists specifically to be handed to other people.
//
// THE ADVERSARIAL HALF is the part that matters. A provider's own 401 body can quote the offending
// credential back, and a transport that passes an upstream message through verbatim puts the key
// into a refusal detail, from there into the ledger, and from there into every copy of the run
// anybody shares. So the hostile cases here are transports that DELIBERATELY echo the key in their
// error bodies and network messages, which is the realistic shape of this failure rather than a
// contrived one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A value no real key could be, so a hit is unambiguous and a miss is not luck.
const CANARY = 'sk-ant-CANARY-3f9b2e71d4a8c605-DO-NOT-LOG';
const SECRET = 'canary-signal-secret';
const SOURCE = 'https://directory.example.com/company/acme.example.com';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function writeSignal(dir) {
  const signal = {
    id: 'sig-canary-1',
    source: 'rb2b',
    received_at: new Date().toISOString(),
    payload: {
      company: { name: 'Acme Robotics', domain: 'acme.example.com' },
      contact: { name: 'Dana Ruiz', email: 'dana@acme.example.com', title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 4 },
      sources: [SOURCE],
    },
  };
  const bytes = JSON.stringify(signal, null, 2);
  writeFileSync(join(dir, '0001.json'), bytes);
  writeFileSync(join(dir, '0001.json.sig'), `${signRaw(SECRET, bytes)}\n`);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

async function runWith(transport, { runs, extraVerbs = [] } = {}) {
  const signals = tmp('canary-signals');
  writeSignal(signals);
  const printed = [];

  const invoke = (argv) =>
    main({
      argv,
      out: (line) => printed.push(String(line)),
      err: (line) => printed.push(String(line)),
      env: {
        SIGNAL_DESK_RUNS_DIR: runs,
        SIGNAL_DESK_ANTHROPIC_KEY: CANARY,
        SIGNAL_DESK_SIGNAL_SECRET: SECRET,
      },
      cwd: ROOT,
      httpTransport: transport,
    });

  await invoke(['run', '--live', '--signals', signals]);
  // The dashboard renders ledger-derived strings into HTML, so it is the artifact most likely to
  // carry a leaked detail onward, and it is the one somebody opens in a browser and shares.
  for (const verb of ['dashboard', 'queue', 'dlq', ...extraVerbs]) await invoke([verb]);

  return { printed: printed.join('\n'), files: walk(runs) };
}

function assertNoCanary({ printed, files }, label) {
  assert.ok(!printed.includes(CANARY), `${label}: the key reached stdout or stderr`);
  for (const file of files) {
    assert.ok(!readFileSync(file, 'utf8').includes(CANARY), `${label}: the key reached ${file}`);
  }
  // A positive control on the method itself. A test that greps nothing passes trivially, and a
  // hygiene test that could pass while inspecting an empty directory is worse than no test.
  assert.ok(files.length > 0, `${label}: the run wrote nothing, so nothing was actually checked`);
}

function json(body, status = 200) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

const FRESH = () => new Date(Date.now() - 86400000).toISOString();
const CLAIMS = { as_of: FRESH(), claims: { employee_count: 240, industry: 'industrial robotics' } };

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

function completion(payload) {
  return json({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] });
}

test('a SUCCESSFUL live run leaves the key in no file it wrote and no line it printed', async () => {
  const runs = tmp('canary-ok');
  const result = await runWith(async (url, options) => {
    if (options.method === 'POST') {
      return completion(options.body.includes('release gate') ? VERDICT : DRAFT);
    }
    return url === SOURCE ? json(CLAIMS) : json({}, 404);
  }, { runs });

  assertNoCanary(result, 'successful run');
  assert.ok(result.files.some((file) => file.endsWith('inputs.json')), 'and the capture was written');
  assert.ok(result.files.some((file) => file.endsWith('dashboard.html')), 'and the dashboard was rendered');
});

test('a provider 401 that ECHOES the key back does not carry it into any artifact', async () => {
  // The realistic leak. A real 401 body can quote the offending credential, and a transport that
  // passes an upstream message through verbatim puts it into a refusal detail and from there into
  // the ledger, the dashboard, and every copy of the run anybody shares.
  const runs = tmp('canary-401');
  const result = await runWith(async (url, options) => {
    if (options.method === 'POST') {
      return json({ error: { type: 'authentication_error', message: `invalid x-api-key: ${CANARY}` } }, 401);
    }
    return url === SOURCE ? json(CLAIMS) : json({}, 404);
  }, { runs });

  assertNoCanary(result, 'provider 401 echoing the key');
  assert.match(result.printed, /MODEL_UNAVAILABLE/, 'the refusal still happened and is still reported');
  // The placeholder belongs in the refusal DETAIL, which lives in the ledger rather than in the run
  // summary. Checked where it actually is, so the assertion means what it says.
  const ledger = result.files.find((file) => file.endsWith('ledger.jsonl'));
  assert.match(readFileSync(ledger, 'utf8'), /\[redacted:key\]/, 'and the record says the value was withheld');
});

test('a NETWORK error whose message contains the key does not carry it into any artifact', async () => {
  const runs = tmp('canary-net');
  const result = await runWith(async (url, options) => {
    if (options.method === 'POST') throw new Error(`connect ECONNREFUSED while sending ${CANARY}`);
    return url === SOURCE ? json(CLAIMS) : json({}, 404);
  }, { runs });

  assertNoCanary(result, 'network error quoting the key');
  assert.match(result.printed, /MODEL_UNAVAILABLE/);
});

test('a SOURCE error whose message contains the key does not carry it into any artifact', async () => {
  // The evidence transport never holds the key, so this is a test that it stays that way. A source
  // is a stranger's server, and a stranger's error body is the last thing that should be trusted to
  // be free of whatever it managed to observe.
  const runs = tmp('canary-source');
  const result = await runWith(async (url, options) => {
    if (options.method === 'POST') return completion(DRAFT);
    throw new Error(`TLS handshake failed, sent header x-api-key: ${CANARY}`);
  }, { runs });

  assertNoCanary(result, 'source error quoting the key');
});

test('a run whose every lead is DEAD-LETTERED leaves the key out of the dead letters too', async () => {
  // The DLQ retains raw payloads, which makes it the artifact with the least filtering applied. It
  // is checked explicitly rather than incidentally.
  const runs = tmp('canary-dlq');
  const signals = tmp('canary-dlq-signals');
  writeFileSync(join(signals, 'broken.json'), '{ not json');
  writeFileSync(join(signals, 'broken.json.sig'), 'x\n');

  const printed = [];
  await main({
    argv: ['run', '--live', '--signals', signals],
    out: (line) => printed.push(String(line)),
    err: (line) => printed.push(String(line)),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: CANARY, SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
    httpTransport: async () => json({}, 500),
  });

  const files = walk(runs);
  assert.ok(files.some((file) => file.includes('dlq')), 'a dead letter was written');
  assertNoCanary({ printed: printed.join('\n'), files }, 'dead-lettered run');
});

test('the canary method itself works, proven by planting the value and finding it', () => {
  // The control this whole file rests on. If the grep could not find a key that IS there, every
  // passing assertion above would be meaningless.
  const runs = tmp('canary-control');
  writeFileSync(join(runs, 'planted.txt'), `a file containing ${CANARY} on purpose\n`);
  assert.throws(
    () => assertNoCanary({ printed: '', files: walk(runs) }, 'control'),
    /the key reached/,
  );
});
