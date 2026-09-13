// The live evidence transport. M4 spec §6.
//
// A plain HTTPS GET of a URL the signal cited, bounded four ways, returning the same
// `{ status, body }` shape the recorded fetcher returns so no stage can tell which one it is
// talking to. That interchangeability is the whole reason the seam exists.
//
// ONE RULE ABOVE THE OTHERS: this module bounds bytes and reports what happened. It does not
// form an opinion about content. An injection-bearing response comes back intact, because
// sanitising here would hide the payload from the enrich flag and the gate, which are the two
// places built to see it. A transport that quietly cleans its input is a transport that decides
// what the gates get to judge.
//
// THE FOUR BOUNDS, and what each one is actually protecting against:
//
//   timeout    A source that never answers must not hold the run open forever. Enforced with an
//              abort signal per attempt rather than a wrapper promise, so the socket is actually
//              cancelled instead of merely being ignored.
//   retries    A source that is briefly unwell should not cost a lead. Bounded, with backoff and
//              jitter, so a struggling source is not hammered by a retry loop that arrives in
//              lockstep with everyone else's.
//   size       A source that answers enormously must not exhaust this process. Cut WHILE READING
//              rather than after, because "buffer it all, then check the length" is not a cap.
//   shape      A body that will not parse as a JSON object has not answered the question, and
//              guessing at half-parsed evidence is worse than having none.
//
// WHAT IS RETRIED AND WHAT IS NOT, because the distinction is a claim about meaning rather than
// a tuning knob. A timeout, a 429 and a 5xx are the source failing to answer. A 404 is the source
// ANSWERING: it does not know that company, which enrich already records as SOURCE_UNAVAILABLE
// with a citation. Retrying an answer spends three times as long to learn the same thing and
// reports a fault where there is none. An oversized or unparseable body is not retried either,
// for the plainer reason that asking again produces the same enormous or the same broken answer.

export class LiveTransportError extends Error {
  constructor(stageCode, message) {
    super(message);
    this.name = 'LiveTransportError';
    // The reason code the ENRICH STAGE should report, chosen here because this module is the
    // only thing that knows which of these happened. The stage maps it straight through, so a
    // reader of the ledger sees "oversized" rather than a generic unavailability.
    this.stageCode = stageCode;
    this.code = stageCode;
  }
}

export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_BACKOFF_MS = 250;

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

function contentLengthOf(response) {
  const raw = response?.headers?.get?.('content-length');
  const declared = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(declared) ? declared : null;
}

// Reads at most maxBytes and refuses past it. Prefers the stream, because a cap applied after
// `await response.text()` has already let the whole body into memory and is therefore not a cap
// at all — it is a report on one that was never enforced.
async function readCapped(response, maxBytes) {
  const oversized = () =>
    new LiveTransportError(
      'SOURCE_OVERSIZED',
      `the response exceeded the ${maxBytes} byte cap and was cut off rather than buffered`,
    );

  const declared = contentLengthOf(response);
  if (declared !== null && declared > maxBytes) throw oversized();

  const stream = response.body;
  if (stream !== null && stream !== undefined && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength ?? value.length ?? 0;
        if (total > maxBytes) throw oversized();
        chunks.push(Buffer.from(value));
      }
    } finally {
      // Cancel regardless of how the loop ended. A reader left open on a refused response is a
      // socket this run never releases.
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw oversized();
  return text;
}

// The longest fragment of a source's own content that may appear in a refusal detail.
//
// A detail travels into the ledger, the golden file and the dashboard, so one hostile source must not
// be able to flood any of them. The same reasoning as the injection detector's MAX_SPAN, applied to
// the other place untrusted bytes reach the durable record.
const MAX_DETAIL = 200;

// EVERY PIECE OF SOURCE-CONTROLLED TEXT LEAVES THROUGH HERE, scrubbed and capped.
//
// The bug this closes, found by the M4 ship-check: both SOURCE_UNPARSEABLE details interpolated
// untrusted text through OUR OWN string building rather than relaying an upstream message, so neither
// passed the scrubber. `JSON.stringify(parsed)` of a 200 body, and `JSON.parse`'s error message —
// which embeds a snippet of the input — both reached the ledger and from there the dashboard verbatim
// and uncapped. A source answering 200 with a bare JSON string is the cleanest way to land arbitrary
// text in a refusal detail, and the reviewer landed a credential that way.
//
// THE GENERAL SHAPE IS THE LESSON. The scrubber was applied to messages that obviously came from
// outside, and missed the ones that came from outside by way of a template literal of ours. "Did this
// text originate with a stranger" is the question, not "did another system hand me this string".
function fragment(value, scrub) {
  const text = scrub(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_DETAIL ? compact : `${compact.slice(0, MAX_DETAIL - 1)}…`;
}

function parseJsonObject(text, url, scrub) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LiveTransportError(
      'SOURCE_UNPARSEABLE',
      `${url} answered 200 with a body that is not JSON, so it has not answered the question: ` +
        `${fragment(error.message, scrub)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LiveTransportError(
      'SOURCE_UNPARSEABLE',
      `${url} answered 200 with ${fragment(parsed, scrub)}, which is not a claim record`,
    );
  }
  return parsed;
}

// WHY THIS READS ITS OWN CLOCK RATHER THAN THE RUN CLOCK. A real bug, found by an intermittent
// replay failure rather than by review, and the root cause is worth stating because the fix looks
// like a detail and is not.
//
// The run clock is a RECORDED SEQUENCE: every instant it issues is captured so a replay can reissue
// them in order and stamp an identical ledger. This transport used to take `fetched_at` from it,
// which meant a live run consumed one reading per fetch that the RECORDED fetcher never consumes on
// replay. Every subsequent reading then shifted by one position, so the replayed ledger stamped its
// enrich entry with the instant the live run had used for something else.
//
// It was invisible whenever two consecutive wall-clock reads landed in the same millisecond, which
// is most of the time on an idle machine, and a byte-level mismatch under load. An intermittent
// failure in the one check that proves replayability.
//
// The distinction the fix rests on: the run clock stamps LEDGER ENTRIES, and `fetched_at` is
// TRANSPORT METADATA that travels inside the response and is captured with it. A replay gets it back
// from the capture, so it never needed to come from the recorded sequence at all. Conflating the two
// made a shared, ordered resource look like an ordinary clock.

/**
 * A live HTTPS GET, bounded, retried and shaped like the recorded fetcher.
 *
 * `transport` is REQUIRED and there is no default. The only place a real one is constructed is
 * src/live/node-transport.mjs, which src/cli.mjs imports and nothing else does, so a test cannot
 * open a socket by forgetting to pass a fake.
 */
export function createLiveFetcher({
  transport,
  // The transport's OWN wall clock, deliberately NOT the run clock. See the note below.
  readClock = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  backoffMs = DEFAULT_BACKOFF_MS,
  // Injected so the retry path runs at full speed in tests and its timings are asserted exactly.
  // A sleep this module implemented itself would make every retry test a real delay.
  sleep = async () => {},
  jitter = Math.random,
  // Removes any secret this process holds from a message that came from outside. This transport
  // never sees a key and must not; what it needs is the ABILITY TO REMOVE one, because a message it
  // relays from a stranger's server can carry whatever that server observed. See
  // secretScrubber in src/live/keys.mjs for the leak this closed and how it was found.
  scrub = (text) => text,
} = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError(
      'createLiveFetcher requires a transport. There is deliberately no default, so nothing ' +
        'reaches the network by omission',
    );
  }
  if (typeof readClock !== 'function') {
    throw new TypeError('createLiveFetcher requires a clock read, so a response can record when it was observed');
  }

  return async function fetchLive(url) {
    // Evidence fetched over a channel anybody on the path can rewrite is not evidence. Refused
    // before anything is sent, so a misconfigured source cannot quietly become an unauthenticated
    // one that still looks like a citation in the ledger.
    if (!/^https:\/\//i.test(String(url))) {
      throw new LiveTransportError(
        'SOURCE_INSECURE',
        `${url} is not an https URL, and a claim cited over plaintext is not a claim this run will stand behind`,
      );
    }

    let lastFailure = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        // Exponential, with jitter, so a fleet of these does not retry in lockstep against a
        // source that is already struggling.
        const base = backoffMs * 2 ** (attempt - 1);
        await sleep(Math.round(base * (0.5 + jitter() * 0.5)));
      }

      let response;
      try {
        response = await transport(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          // A redirect is the source sending this run somewhere it did not choose to cite, and
          // the whole discipline is that a claim binds to the URL the run actually asked for.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastFailure = isTimeout(error)
          ? new LiveTransportError('SOURCE_TIMEOUT', `${url} did not answer within ${timeoutMs}ms`)
          : new LiveTransportError('SOURCE_UNAVAILABLE', `${url} could not be reached: ${scrub(error.message)}`);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        lastFailure = new LiveTransportError(
          'SOURCE_UNAVAILABLE',
          `${url} answered ${response.status}, which is the source declining to answer rather than answering`,
        );
        continue;
      }

      const fetched_at = readClock();

      // Any other non-200 IS an answer. Handed back unretried, for the enrich stage to record as
      // a source that does not know this company.
      if (response.status !== 200) {
        return { status: response.status, body: {}, fetched_at };
      }

      // Past this point a failure is about the CONTENT, and asking again returns the same
      // content. These throw rather than setting lastFailure, so nothing is retried into a
      // guaranteed repeat.
      const text = await readCapped(response, maxBytes);
      return { status: 200, body: parseJsonObject(text, url, scrub), fetched_at };
    }

    throw lastFailure;
  };
}
