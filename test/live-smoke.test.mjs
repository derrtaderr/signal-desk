// THE ONE OPTIONAL KEYED TEST IN THIS REPO. M4 spec §10.
//
// It is skipped unless BOTH of these are set:
//
//   SIGNAL_DESK_LIVE_SMOKE=1     an explicit choice to spend money and open a socket
//   SIGNAL_DESK_ANTHROPIC_KEY    or ANTHROPIC_API_KEY
//
// TWO GATES RATHER THAN ONE, ON PURPOSE. A developer machine very often exports
// ANTHROPIC_API_KEY for unrelated work. A suite that silently started spending that key and opening
// sockets because of an ambient variable would have broken its own keyless promise without anybody
// choosing to, and the person it happened to would find out from their bill. The explicit variable
// IS the choice, and nothing else can make it on their behalf.
//
// What it proves, and it is deliberately narrow: that the Messages API request this repo builds by
// hand is one a real provider accepts, and that a real completion parses. Everything ABOUT the
// pipeline — the gates, the grounding, the refusals, the replayability — is proven keylessly by the
// rest of the suite against injected transports, because those are properties of this code and not
// of the provider.
//
// It is also the only test in the repo exempt from test/no-network.test.mjs, which names this file
// explicitly rather than pattern-matching its way around it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveModel } from '../src/live/anthropic.mjs';
import { nodeTransport } from '../src/live/node-transport.mjs';
import { resolveModelKey } from '../src/live/keys.mjs';

const OPTED_IN = process.env.SIGNAL_DESK_LIVE_SMOKE === '1';
const HAS_KEY = ['SIGNAL_DESK_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'].some(
  (name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '',
);

const skip = !OPTED_IN || !HAS_KEY
  ? `keyed smoke test skipped: set SIGNAL_DESK_LIVE_SMOKE=1 and a key to run it${OPTED_IN && !HAS_KEY ? ' (opted in, no key found)' : ''}`
  : false;

test('a real Messages API call returns a completion this repo can parse', { skip }, async () => {
  const model = createLiveModel({
    key: resolveModelKey(process.env),
    transport: nodeTransport(),
    maxTokens: 64,
  });

  const result = await model({
    system: 'Answer with one JSON object and nothing else.',
    prompt: 'Return {"ok": true} exactly.',
  });

  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.trim() !== '', 'a completion with no text would be a refusal, not a pass');
  assert.equal(typeof result.model, 'string');
});
