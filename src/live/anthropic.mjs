// The live model transport. Direct Anthropic Messages API calls, no SDK, no package. M4 spec §5.
//
// One request, one response, one parse. No streaming, no tool use, no multi-turn. Those are all
// reasonable things to want and all of them add a state machine between a prompt and a verdict,
// which is the last place this repo wants one.
//
// THE ONE RULE, inherited from src/rubric.mjs and it is the same rule: SILENCE IS NOT AN ANSWER.
// An outage, a timeout, a rate limit, a refusal and an unreadable shape are each a distinct
// refusal with its own code. Not one of them returns empty text for a caller to interpret
// charitably, because a stage that receives empty text and carries on has converted an outage
// into an authorisation.
//
// WHY THE CODES ARE SPLIT THE WAY THEY ARE. MODEL_UNAVAILABLE is infrastructure: the provider
// could not be reached or would not serve us. MODEL_REFUSED is the model declining to write this
// particular message, which is information about the INPUT and belongs in a different mental bin —
// an operator reading it should look at the lead, not at the status page. MODEL_UNPARSEABLE is a
// contract break: something answered, in a shape this code cannot read, which is the case most
// likely to be a version drift rather than a fault.
//
// KEY HANDLING, which is the reason this module exists as its own file. The key enters through one
// argument, lives in one closure, and is attached to one header. It is never returned, never
// logged, and never placed on an object a stage can see. The one carrier that guarantee does not
// cover is a provider error body quoting the credential back at us, so every upstream message is
// scrubbed before it is reported. See src/live/keys.mjs.

import { scrubKey } from './keys.mjs';

export const MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = 500;

export class ModelTransportError extends Error {
  constructor(stageCode, message) {
    super(message);
    this.name = 'ModelTransportError';
    this.stageCode = stageCode;
    this.code = stageCode;
  }
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

// The longest useful thing a provider error body says, trimmed so a huge HTML error page cannot
// flood a refusal detail, and scrubbed so it cannot carry the credential.
function upstreamDetail(text, key, scrub = (value) => value) {
  const scrubbed = scrub(scrubKey(String(text ?? ''), key)).trim();
  const compact = scrubbed.replace(/\s+/g, ' ');
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`;
}

function textFrom(body) {
  if (!Array.isArray(body?.content)) return null;
  const blocks = body.content.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  if (blocks.length === 0) return null;
  const joined = blocks.map((block) => block.text).join('');
  return joined.trim() === '' ? null : joined;
}

/**
 * The live model seam: `({ system, prompt }) -> { text, model, stop_reason }`.
 *
 * Both `key` and `transport` are required. There is deliberately no default transport, so nothing
 * in this repo reaches the network by omission; the only real one is built in
 * src/live/node-transport.mjs, which src/cli.mjs imports and nothing else does.
 */
export function createLiveModel({
  key,
  transport,
  model = DEFAULT_MODEL,
  endpoint = MESSAGES_ENDPOINT,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  sleep = async () => {},
  jitter = Math.random,
  // Layered over this module's own key scrub. Its own covers the key it holds; this one covers
  // every other secret the process holds, which this module deliberately does not know about.
  scrub = (text) => text,
} = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('createLiveModel requires the model key; see src/live/keys.mjs for the precedence rule');
  }
  if (typeof transport !== 'function') {
    throw new TypeError(
      'createLiveModel requires a transport. There is deliberately no default, so nothing reaches ' +
        'the network by omission',
    );
  }

  return async function callModel({ system, prompt, maxTokens: perCallMaxTokens } = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new TypeError('the model seam requires a prompt');
    }

    const payload = JSON.stringify({
      model,
      max_tokens: perCallMaxTokens ?? maxTokens,
      // Zero, because this pipeline's whole claim is that the same inputs produce the same
      // decisions. A live run cannot be byte-reproducible, and there is no reason to add variance
      // it did not need on top of the variance it cannot avoid.
      temperature: 0,
      ...(typeof system === 'string' && system !== '' ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    let lastFailure = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const base = backoffMs * 2 ** (attempt - 1);
        await sleep(Math.round(base * (0.5 + jitter() * 0.5)));
      }

      let response;
      try {
        response = await transport(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'x-api-key': key,
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Scrubbed even here. A network error message can echo a URL or a header this run built.
        lastFailure = new ModelTransportError(
          'MODEL_UNAVAILABLE',
          isTimeout(error)
            ? `the model did not answer within ${timeoutMs}ms, and silence is not a draft`
            : `the model could not be reached: ${scrub(scrubKey(error.message, key))}`,
        );
        continue;
      }

      const raw = await response.text().catch(() => '');

      if (response.status === 429 || response.status >= 500) {
        lastFailure = new ModelTransportError(
          'MODEL_UNAVAILABLE',
          `the model provider answered ${response.status}: ${upstreamDetail(raw, key, scrub)}`,
        );
        continue;
      }

      // Any other non-200 is the provider telling us this request is wrong, and asking again does
      // not make it right. A 401 lands here, which is also the case most likely to quote the
      // credential back, hence the scrub.
      if (response.status !== 200) {
        throw new ModelTransportError(
          'MODEL_UNAVAILABLE',
          `the model provider answered ${response.status} and will answer the same again: ${upstreamDetail(raw, key, scrub)}`,
        );
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch (error) {
        throw new ModelTransportError(
          'MODEL_UNPARSEABLE',
          `the model provider answered 200 with a body that is not JSON: ${scrub(scrubKey(error.message, key))}`,
        );
      }

      if (body?.stop_reason === 'refusal') {
        throw new ModelTransportError(
          'MODEL_REFUSED',
          'the model declined to write this message. That is a fact about the input rather than an ' +
            'outage, and it is reported separately so nobody checks a status page over it',
        );
      }

      const text = textFrom(body);
      if (text === null) {
        throw new ModelTransportError(
          'MODEL_REFUSED',
          `the model returned no text (stop_reason ${JSON.stringify(body?.stop_reason ?? null)}), and ` +
            'no text is not a draft anybody wrote',
        );
      }

      return { text, model: typeof body.model === 'string' ? body.model : model, stop_reason: body.stop_reason ?? null };
    }

    throw lastFailure;
  };
}
