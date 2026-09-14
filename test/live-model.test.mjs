// The live model transport and the key rule. M4 spec §4, §5 and §11.
//
// Keyless, like everything else here. The HTTP transport is injected and the "key" is a canary
// string this file invents, so nothing authenticates and nothing is spent.
//
// The assertions that matter most in this file are the negative ones. A model transport is the
// one component in this repo that holds a secret, and the property worth pinning is not that it
// works — it is that the secret cannot come back out through an error message, a thrown stack,
// or the object the transport hands to a stage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelKey, MissingKeyError, KEY_VARIABLES } from '../src/live/keys.mjs';
import { createLiveModel, DEFAULT_MODEL, MESSAGES_ENDPOINT } from '../src/live/anthropic.mjs';

const CANARY = 'sk-ant-canary-DO-NOT-LOG-8f3a9c2b1e7d';

// --- the key rule --------------------------------------------------------------------------

test('the prefixed variable wins, so this tool can use a different key from the ambient one', () => {
  const resolved = resolveModelKey({
    SIGNAL_DESK_ANTHROPIC_KEY: 'prefixed-key',
    ANTHROPIC_API_KEY: 'ambient-key',
  });
  assert.equal(resolved, 'prefixed-key');
});

test('the ambient variable is used when the prefixed one is absent', () => {
  assert.equal(resolveModelKey({ ANTHROPIC_API_KEY: 'ambient-key' }), 'ambient-key');
});

test('an empty variable is not a key, so a blank export does not read as having one', () => {
  assert.equal(resolveModelKey({ SIGNAL_DESK_ANTHROPIC_KEY: '   ', ANTHROPIC_API_KEY: 'ambient' }), 'ambient');
});

test('no key at all raises a NAMED error that tells the operator which variables to set', () => {
  assert.throws(
    () => resolveModelKey({}),
    (error) => {
      assert.ok(error instanceof MissingKeyError);
      assert.equal(error.code, 'LIVE_KEY_MISSING');
      for (const name of KEY_VARIABLES) {
        assert.match(error.message, new RegExp(name), `the message names ${name}`);
      }
      return true;
    },
  );
});

// --- the transport -------------------------------------------------------------------------

function completion(text, overrides = {}) {
  return {
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        id: 'msg_1',
        model: DEFAULT_MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        ...overrides,
      }),
  };
}

function harness(responses, overrides = {}) {
  const calls = [];
  const queue = [...responses];
  const model = createLiveModel({
    key: CANARY,
    transport: async (url, options) => {
      calls.push({ url, options });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async () => {},
    jitter: () => 0.5,
    ...overrides,
  });
  return { model, calls };
}

const REQUEST = { system: 'You are a careful drafter.', prompt: 'Write to Dana.' };

test('a completion comes back as plain text with the model that produced it', async () => {
  const { model } = harness([completion('{"subject":"Hi","body":"Hello"}')]);
  const result = await model(REQUEST);
  assert.equal(result.text, '{"subject":"Hi","body":"Hello"}');
  assert.equal(result.model, DEFAULT_MODEL);
});

test('the request goes to the Messages API with the version header the API requires', async () => {
  const { model, calls } = harness([completion('ok')]);
  await model(REQUEST);
  assert.equal(calls[0].url, MESSAGES_ENDPOINT);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.system, REQUEST.system);
  assert.deepEqual(body.messages, [{ role: 'user', content: REQUEST.prompt }]);
});

test('the request carries no temperature, because the live API rejects it for this model family', async () => {
  // Found by the first real run of the keyed smoke test (2026-09-14): the Messages API answered
  // 400 "`temperature` is deprecated for this model" for claude-sonnet-5. Determinism was never
  // this knob's to give on a live call; the gates and the recorded replay carry that promise.
  const { model, calls } = harness([completion('ok')]);
  await model(REQUEST);
  const body = JSON.parse(calls[0].options.body);
  assert.equal('temperature' in body, false);
});

test('the model id is configurable, so a default does not become a lock-in', async () => {
  const { model, calls } = harness([completion('ok')], { model: 'claude-opus-5' });
  await model(REQUEST);
  assert.equal(JSON.parse(calls[0].options.body).model, 'claude-opus-5');
});

test('the transport and the key are both REQUIRED, so nothing defaults into a real call', () => {
  assert.throws(() => createLiveModel({ key: CANARY }), TypeError);
  assert.throws(() => createLiveModel({ transport: async () => {} }), TypeError);
});

// --- the failure directions, each fail-closed ------------------------------------------------

test('a provider error REFUSES with MODEL_UNAVAILABLE rather than returning empty text', async () => {
  const { model } = harness([
    { status: 500, headers: { get: () => null }, text: async () => '{"error":{"message":"overloaded"}}' },
  ]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_UNAVAILABLE');
    return true;
  });
});

test('a 429 is retried, and an exhausted budget REFUSES', async () => {
  const rateLimited = { status: 429, headers: { get: () => null }, text: async () => '{}' };
  const { model, calls } = harness([rateLimited, completion('ok')]);
  assert.equal((await model(REQUEST)).text, 'ok');
  assert.equal(calls.length, 2);

  const exhausted = harness([rateLimited]);
  await assert.rejects(() => exhausted.model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_UNAVAILABLE');
    return true;
  });
  assert.equal(exhausted.calls.length, 3);
});

test('a 400 is NOT retried, because a malformed request stays malformed', async () => {
  const { model, calls } = harness([
    { status: 400, headers: { get: () => null }, text: async () => '{"error":{"message":"bad request"}}' },
  ]);
  await assert.rejects(() => model(REQUEST));
  assert.equal(calls.length, 1);
});

test('a timeout REFUSES with MODEL_UNAVAILABLE, because silence is not a draft', async () => {
  const timeout = new Error('aborted');
  timeout.name = 'TimeoutError';
  const { model } = harness([timeout]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_UNAVAILABLE');
    assert.match(error.message, /timed out|did not answer/i);
    return true;
  });
});

test('a refusal stop reason REFUSES with MODEL_REFUSED, distinct from an outage', async () => {
  // Two different things a reader needs to tell apart. An outage is infrastructure. A refusal is
  // the model declining to write this particular message, which is information about the input.
  const { model } = harness([completion('', { stop_reason: 'refusal' })]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_REFUSED');
    return true;
  });
});

test('an empty completion REFUSES, because no text is not a draft anybody wrote', async () => {
  const { model } = harness([completion('', { content: [] })]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_REFUSED');
    return true;
  });
});

test('a response body that is not the Messages shape REFUSES with MODEL_UNPARSEABLE', async () => {
  const { model } = harness([{ status: 200, headers: { get: () => null }, text: async () => 'not json' }]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_UNPARSEABLE');
    return true;
  });
});

test('a response whose content carries no text block REFUSES rather than stringifying the shape', async () => {
  const { model } = harness([completion('', { content: [{ type: 'thinking', thinking: 'hmm' }] })]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.equal(error.stageCode, 'MODEL_REFUSED');
    return true;
  });
});

// --- the key never comes back out ------------------------------------------------------------

test('the key is sent as a header and appears nowhere in the result handed to a stage', async () => {
  const { model, calls } = harness([completion('ok')]);
  const result = await model(REQUEST);
  assert.equal(calls[0].options.headers['x-api-key'], CANARY, 'it does reach the provider');
  assert.ok(!JSON.stringify(result).includes(CANARY), 'and it does not come back');
});

test('NO failure path puts the key into an error message', async () => {
  // The likeliest accidental carrier is an error that helpfully includes the request it failed
  // on. Every failure direction is walked, and every message is checked.
  const failures = [
    { status: 401, headers: { get: () => null }, text: async () => `{"error":{"message":"invalid x-api-key: ${CANARY}"}}` },
    { status: 500, headers: { get: () => null }, text: async () => '{}' },
    { status: 200, headers: { get: () => null }, text: async () => 'not json' },
    completion('', { stop_reason: 'refusal' }),
    completion('', { content: [] }),
    Object.assign(new Error(`connect ECONNREFUSED using ${CANARY}`), { name: 'Error' }),
  ];

  for (const failure of failures) {
    const { model } = harness([failure]);
    let thrown = null;
    try {
      await model(REQUEST);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'every one of these is a refusal');
    assert.ok(!thrown.message.includes(CANARY), `the key leaked into: ${thrown.message}`);
    assert.ok(!String(thrown.stack).includes(CANARY), 'and it is not in the stack either');
  }
});

test('an error raised by the PROVIDER that quotes the key back is scrubbed before it is reported', async () => {
  // A real 401 from a provider can echo the offending credential. Passing that message through
  // verbatim would put the key in the ledger by way of a refusal detail.
  const { model } = harness([
    { status: 401, headers: { get: () => null }, text: async () => `{"error":{"message":"invalid key ${CANARY}"}}` },
  ]);
  await assert.rejects(() => model(REQUEST), (error) => {
    assert.ok(!error.message.includes(CANARY));
    assert.match(error.message, /\[redacted:key\]/);
    return true;
  });
});
