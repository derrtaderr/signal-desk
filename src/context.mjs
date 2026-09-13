// The injected context. Stages reach the outside world only through this object, which
// is what makes a fixture run reproducible and a keyless run possible. Nothing in src/
// reads the wall clock or opens a socket.

export class NoRecordingError extends Error {
  constructor(url) {
    super(`no recording for ${url}; fixture mode never falls back to a live call`);
    this.name = 'NoRecordingError';
    this.url = url;
    this.code = 'NO_RECORDING';
  }
}

// Time advances by pipeline position, not by how long the machine took. Two runs over
// the same fixtures therefore stamp the same instants, which is a precondition for the
// ledger bytes matching.
export function fixtureClock({ start, stepMs = 1000 }) {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) {
    throw new TypeError(`fixture clock start ${JSON.stringify(start)} is not a parseable instant`);
  }
  let ticks = 0;
  return {
    now() {
      const at = new Date(startMs + ticks * stepMs).toISOString();
      ticks += 1;
      return at;
    },
    peek() {
      return new Date(startMs + ticks * stepMs).toISOString();
    },
  };
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function recordedFetcher(recordings) {
  return async function fetchRecorded(url) {
    if (!Object.prototype.hasOwnProperty.call(recordings, url)) {
      throw new NoRecordingError(url);
    }
    // A copy, so one stage mutating a response cannot change what a later stage sees.
    return deepCopy(recordings[url]);
  };
}

// THE SECOND SEAM, added in M4. See docs/M4-SPEC.md §4 for the argument.
//
// M2 said live mode would be "a fetcher swap and nothing else". The SHAPE of that claim carries
// over exactly — a stage reaches the outside world through one injected async function, does no
// I/O itself, and stays testable with plain objects. The assumption that one `fetch(url)` serves
// both jobs does not. Evidence retrieval is a GET addressed by URL. A completion is a POST with
// provider headers, a credential and a structured body.
//
// Forcing the second through the first would mean either putting the key on `ctx.config`, which is
// hashed into the run id and one careless stringify away from every artifact, or letting a stage
// read process.env, which test/repo-hygiene.test.mjs forbids and should keep forbidding. So there
// are two seams, and the key lives in neither of them: it is captured inside the live model
// transport's closure and a stage never sees it.
//
// `model` ABSENT is not a fallback. A stage configured to use a model and handed no model seam
// refuses with a named code. That is "silence is not a pass", one layer out.

export function createContext({ ledger, clock, fetch, model, config, run_id }) {
  return Object.freeze({
    run_id,
    clock,
    fetch,
    model,
    config: Object.freeze({ ...config }),
    ledger: Object.freeze({
      append: (entry) => ledger.append(entry),
      entries: () => ledger.entries(),
      entriesFor: (leadId) => ledger.entriesFor(leadId),
      head: () => ledger.head(),
    }),
  });
}
