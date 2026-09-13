// Live mode at the composition level. M4 spec §8, §10, §11.
//
// TWO KINDS OF TEST HERE, and the split is deliberate rather than a compromise.
//
// The paths that need no network are driven as a REAL SUBPROCESS: the no-key refusal, the DLQ, and
// the replay of a captured live run. Every prior lane's blocker in this repo lived at the
// composition level rather than in a unit, so those get the real binary, real argv, real files and
// a real exit code.
//
// The live run itself is driven IN PROCESS with injected fake transports, because the alternative
// is opening a socket and this suite does not open sockets. The transport seam is what makes that
// possible, and test/no-network.test.mjs is what keeps it honest.
//
// The strongest assertion in the file is the pair: an in-process live run writes a capture, and
// then a REAL SUBPROCESS replays it offline, keylessly, to identical bytes. That is the whole
// replayability claim, proven end to end, by the same command a stranger would type.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');

const SECRET = 'live-signal-secret-for-tests';
const CANARY_KEY = 'sk-ant-canary-DO-NOT-LOG-8f3a9c2b1e7d';

const DIRECTORY = 'https://directory.example.com/company/acme.example.com';
const NEWSROOM = 'https://newsroom.example.com/acme.example.com';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

// A live payload as a sender would transmit it: exact bytes on disk, signature in a sibling file.
function writeSignal(dir, name, signal, { secret = SECRET, signature } = {}) {
  const bytes = JSON.stringify(signal, null, 2);
  writeFileSync(join(dir, `${name}.json`), bytes);
  writeFileSync(join(dir, `${name}.json.sig`), `${signature ?? signRaw(secret, bytes)}\n`);
  return bytes;
}

function signalBody(overrides = {}) {
  return {
    id: 'sig-live-1',
    source: 'rb2b',
    received_at: new Date().toISOString(),
    payload: {
      company: { name: 'Acme Robotics', domain: 'acme.example.com' },
      contact: { name: 'Dana Ruiz', email: 'dana@acme.example.com', title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 4 },
      sources: [DIRECTORY, NEWSROOM],
      ...overrides,
    },
  };
}

const FRESH = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

// A fake HTTP transport standing in for both the evidence sources and the model provider.
function fakeTransport({ draft, verdict } = {}) {
  const seen = [];
  return {
    seen,
    transport: async (url, options) => {
      seen.push({ url, options });
      const json = (body) => ({
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });

      if (options.method === 'POST') {
        // The judge and the drafter are the same endpoint; the system prompt says which is which.
        const isJudge = options.body.includes('release gate');
        return json({
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(isJudge ? verdict : draft) }],
        });
      }

      if (url === DIRECTORY) {
        return json({ as_of: FRESH(), claims: { employee_count: 240, industry: 'industrial robotics' } });
      }
      if (url === NEWSROOM) {
        return json({ as_of: FRESH(), claims: { funding_stage: 'series B' } });
      }
      return { status: 404, headers: { get: () => null }, text: async () => '{}' };
    },
  };
}

const GOOD_DRAFT = {
  subject: 'A question about Acme Robotics',
  body: 'Hi Dana,\n\nAt around 240 people, who decides which inbound signals are worth a human reply?\n\nMost teams answer that with a rule nobody has revisited.\n\nWorth a short conversation?',
  claim_refs: [{ field: 'employee_count', citation: DIRECTORY }],
};

const GOOD_VERDICT = {
  verdict: 'PASS',
  criteria: [
    { name: 'claim_grounding', verdict: 'PASS', note: 'every assertion traces to a citation' },
    { name: 'audience_fit', verdict: 'PASS', note: 'addressed to the right operator' },
    { name: 'tone', verdict: 'PASS', note: 'not a pitch' },
  ],
};

function collect() {
  const out = [];
  const err = [];
  return { out, err, write: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

async function liveRun({ signalsDir, runsDir, transport, env = {}, argv = ['run', '--live'] }) {
  const log = collect();
  const code = await main({
    argv: [...argv, '--signals', signalsDir],
    out: log.write.out,
    err: log.write.err,
    env: {
      SIGNAL_DESK_RUNS_DIR: runsDir,
      SIGNAL_DESK_ANTHROPIC_KEY: CANARY_KEY,
      SIGNAL_DESK_SIGNAL_SECRET: SECRET,
      ...env,
    },
    cwd: ROOT,
    httpTransport: transport,
  });
  return { code, stdout: log.out.join('\n'), stderr: log.err.join('\n') };
}

// --- the no-key refusal, driven as a real subprocess ------------------------------------------

test('run --live with NO key refuses immediately, names both variables, and writes nothing', () => {
  const runs = tmp('nokey');
  const signals = tmp('nokey-signals');
  writeSignal(signals, '0001', signalBody());

  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BIN, 'run', '--live', '--signals', signals], {
      encoding: 'utf8',
      // env -i in spirit: nothing ambient can satisfy the key check.
      env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr;
  }

  assert.notEqual(status, 0, 'a refusal exits non-zero');
  assert.match(stderr, /LIVE_KEY_MISSING/);
  assert.match(stderr, /SIGNAL_DESK_ANTHROPIC_KEY/);
  assert.match(stderr, /ANTHROPIC_API_KEY/);
  assert.deepEqual(readdirSync(runs), [], 'nothing was fetched and no run directory was created');
});

test('run --live with no signal secret refuses rather than accepting unsigned live payloads', () => {
  // The silent downgrade that must not exist. ingest skips signature verification when no secret is
  // configured, which is right for a pipeline that has not been given one and catastrophic for a
  // live mode that quietly accepted whatever arrived.
  const runs = tmp('nosecret');
  const signals = tmp('nosecret-signals');
  writeSignal(signals, '0001', signalBody());

  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BIN, 'run', '--live', '--signals', signals], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: CANARY_KEY },
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr;
  }

  assert.notEqual(status, 0);
  assert.match(stderr, /LIVE_SECRET_MISSING/);
  assert.match(stderr, /SIGNAL_DESK_SIGNAL_SECRET/);
});

test('the fixture run still needs no key, no secret and no network at all', () => {
  const runs = tmp('fixture-bare');
  const stdout = execFileSync(process.execPath, [BIN, 'run'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  assert.match(stdout, /14 signals in total/);
});

// --- a live run, in process, through injected transports ---------------------------------------

test('a live run drafts with the model, gates it, and seals a ledger', async () => {
  const runs = tmp('run');
  const signals = tmp('run-signals');
  writeSignal(signals, '0001', signalBody());

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  const { code, stdout } = await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  assert.equal(code, 0);
  assert.match(stdout, /1 awaiting a human/, 'the send boundary holds: a live draft still parks');
  assert.match(stdout, /Nothing was sent/);

  const runId = readFileSync(join(runs, 'latest'), 'utf8').trim();
  const ledger = readFileSync(join(runs, runId, 'ledger.jsonl'), 'utf8');
  // Ledger keys are serialised in canonical (sorted) order, so the assertion reads the entry
  // rather than guessing at a key sequence.
  const entries = ledger.trim().split('\n').map((line) => JSON.parse(line));
  const gate = entries.find((entry) => entry.stage === 'gate');
  assert.ok(gate, 'the live draft reached the gate');
  assert.equal(gate.verdict, 'PASS', 'and passed the same three-part gate a fixture draft faces');
  assert.ok(entries.some((entry) => entry.reason_codes.includes('AWAITING_APPROVAL')));
  assert.ok(entries.some((entry) => entry.reason_codes.includes('RUN_SEALED')));
});

test('the live run fetched the URLs the PAYLOAD named, not a configured vendor template', async () => {
  const runs = tmp('sources');
  const signals = tmp('sources-signals');
  writeSignal(signals, '0001', signalBody());

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  const fetched = fake.seen.filter((call) => call.options.method === 'GET').map((call) => call.url);
  assert.ok(fetched.includes(DIRECTORY));
  assert.ok(fetched.includes(NEWSROOM));
  assert.ok(!fetched.some((url) => url.includes('.test/')), 'no fixture domain was contacted');
});

test('the live run writes a capture, and a REAL SUBPROCESS replays it offline and keylessly', async () => {
  // The replayability claim, end to end, by the command a stranger would type. The subprocess is
  // given no key and no secret, which is the point: whoever you hand the run directory to can
  // verify every decision in it without your credentials.
  const runs = tmp('replay');
  const signals = tmp('replay-signals');
  writeSignal(signals, '0001', signalBody());

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });
  const runId = readFileSync(join(runs, 'latest'), 'utf8').trim();

  assert.ok(existsSync(join(runs, runId, 'inputs.json')), 'the run captured what it observed');

  const stdout = execFileSync(process.execPath, [BIN, 'replay', runId], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  assert.match(stdout, /hash chain verified/);
  assert.match(stdout, /is an exact match/);
  assert.match(stdout, /identical bytes/);
});

test('the capture holds no key, in any file the run wrote', async () => {
  const runs = tmp('nokey-capture');
  const signals = tmp('nokey-capture-signals');
  writeSignal(signals, '0001', signalBody());

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const file of walk(runs)) {
    assert.ok(!readFileSync(file, 'utf8').includes(CANARY_KEY), `${file} carries the key`);
  }
});

test('a model outage REFUSES the lead rather than falling back to a template', async () => {
  const runs = tmp('outage');
  const signals = tmp('outage-signals');
  writeSignal(signals, '0001', signalBody());

  const transport = async (url, options) => {
    if (options.method === 'POST') return { status: 503, headers: { get: () => null }, text: async () => '{}' };
    if (url === DIRECTORY) {
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ as_of: FRESH(), claims: { employee_count: 240 } }),
      };
    }
    return { status: 404, headers: { get: () => null }, text: async () => '{}' };
  };

  const { stdout } = await liveRun({ signalsDir: signals, runsDir: runs, transport });
  assert.match(stdout, /MODEL_UNAVAILABLE/);
  assert.match(stdout, /1 refused/);
  assert.ok(!stdout.includes('awaiting a human') || /0 awaiting a human/.test(stdout));
});

// --- the DLQ ----------------------------------------------------------------------------------

test('a signal ingest refuses is dead-lettered with its bytes and its reason', async () => {
  const runs = tmp('dlq');
  const signals = tmp('dlq-signals');
  writeSignal(signals, '0001', signalBody(), { signature: 'deadbeef'.repeat(8) });

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  const { stdout } = await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  assert.match(stdout, /SIGNATURE_INVALID/);
  const dead = readdirSync(join(runs, 'dlq')).filter((name) => name.endsWith('.json'));
  assert.equal(dead.length, 1);
  const entry = JSON.parse(readFileSync(join(runs, 'dlq', dead[0]), 'utf8'));
  assert.equal(entry.reason, 'SIGNATURE_INVALID');
  assert.match(entry.raw, /sig-live-1/, 'the payload is retained so the sender can be fixed and it replayed');
});

test('a file that is not parseable JSON is dead-lettered without reaching the pipeline', async () => {
  const runs = tmp('dlq-garbage');
  const signals = tmp('dlq-garbage-signals');
  writeFileSync(join(signals, 'broken.json'), '{ this is not json');
  writeFileSync(join(signals, 'broken.json.sig'), 'irrelevant\n');

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  const dead = readdirSync(join(runs, 'dlq')).filter((name) => name.endsWith('.json'));
  assert.equal(dead.length, 1);
  assert.equal(JSON.parse(readFileSync(join(runs, 'dlq', dead[0]), 'utf8')).reason, 'UNREADABLE_PAYLOAD');
});

test('a DUPLICATE is NOT dead-lettered, because a dead letter for a successful no-op invites redelivery', async () => {
  const runs = tmp('dlq-dupe');
  const signals = tmp('dlq-dupe-signals');
  const body = signalBody();
  writeSignal(signals, '0001', body);
  writeSignal(signals, '0002', { ...body, id: 'sig-live-2' });

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  const { stdout } = await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  assert.match(stdout, /DUPLICATE_LEAD/);
  assert.ok(
    !existsSync(join(runs, 'dlq')) || readdirSync(join(runs, 'dlq')).filter((n) => n.endsWith('.json')).length === 0,
  );
});

test('a lead refused DOWNSTREAM is not dead-lettered, because the ledger already holds that decision', async () => {
  // The DLQ boundary. "We could not accept this" has a fix at the sender. "We accepted it and said
  // no" is a decision, and retaining the payload invites somebody to replay it until it passes.
  const runs = tmp('dlq-downstream');
  const signals = tmp('dlq-downstream-signals');
  writeSignal(signals, '0001', signalBody({ sources: ['https://nothing.example.com/known'] }));

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  const { stdout } = await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  assert.match(stdout, /NO_CITED_CLAIMS/);
  assert.ok(
    !existsSync(join(runs, 'dlq')) || readdirSync(join(runs, 'dlq')).filter((n) => n.endsWith('.json')).length === 0,
  );
});

test('the dlq verb lists what is parked there, as a real subprocess', async () => {
  const runs = tmp('dlq-list');
  const signals = tmp('dlq-list-signals');
  writeSignal(signals, '0001', signalBody(), { signature: 'deadbeef'.repeat(8) });

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  const stdout = execFileSync(process.execPath, [BIN, 'dlq'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  assert.match(stdout, /1 dead letter/);
  assert.match(stdout, /SIGNATURE_INVALID/);
  assert.match(stdout, /--replay/, 'and it says how to act on them');
});

test('dlq --replay re-feeds the retained bytes, and a fixed signal then passes', async () => {
  const runs = tmp('dlq-replay');
  const signals = tmp('dlq-replay-signals');
  writeSignal(signals, '0001', signalBody(), { signature: 'deadbeef'.repeat(8) });

  const fake = fakeTransport({ draft: GOOD_DRAFT, verdict: GOOD_VERDICT });
  await liveRun({ signalsDir: signals, runsDir: runs, transport: fake.transport });

  // The sender fixed their signing. The retained bytes are re-signed, which is exactly the recovery
  // the DLQ exists to make possible.
  const dead = readdirSync(join(runs, 'dlq')).filter((name) => name.endsWith('.json'));
  const entry = JSON.parse(readFileSync(join(runs, 'dlq', dead[0]), 'utf8'));
  entry.signature = signRaw(SECRET, entry.raw);
  writeFileSync(join(runs, 'dlq', dead[0]), `${JSON.stringify(entry, null, 2)}\n`);

  const replayed = await liveRun({
    signalsDir: signals,
    runsDir: runs,
    transport: fake.transport,
    argv: ['dlq', '--replay'],
  });
  assert.equal(replayed.code, 0);
  assert.match(replayed.stdout, /1 awaiting a human/);
});

test('an empty dlq says so plainly rather than printing nothing', () => {
  const runs = tmp('dlq-empty');
  mkdirSync(runs, { recursive: true });
  const stdout = execFileSync(process.execPath, [BIN, 'dlq'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  assert.match(stdout, /nothing/i);
});
