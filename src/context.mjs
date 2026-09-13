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

export function createContext({ ledger, clock, fetch, config, run_id }) {
  return Object.freeze({
    run_id,
    clock,
    fetch,
    config: Object.freeze({ ...config }),
    ledger: Object.freeze({
      append: (entry) => ledger.append(entry),
      entries: () => ledger.entries(),
      entriesFor: (leadId) => ledger.entriesFor(leadId),
      head: () => ledger.head(),
    }),
  });
}
