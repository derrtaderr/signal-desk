// Live ingest, CLI-shaped. M4 spec §8 and §9.
//
// NO HTTP SERVER, and the reason is short enough to state here in full. A server is a listening
// socket, a deployment story, a TLS story and an authentication surface, and every one of those is
// a hosted-tool concern in a repo whose distribution model is distribute-don't-host and whose
// non-scope list already says no hosted version. None of it is needed to exercise the ingest
// discipline the design actually names: HMAC over raw bytes, a replay window, idempotency and a DLQ
// are properties of VERIFYING a payload, not of RECEIVING one over a socket, and consuming files
// exercises all four against bytes a real sender produced. Somebody who wants a webhook endpoint
// already has one — their own — and the honest interface between it and this tool is a file or a
// pipe. The server is absent because it would add a surface this tool does not want and would test
// nothing new.
//
// THE FILE LAYOUT is the whole interface:
//
//   signals/0001.json       the exact bytes the sender transmitted
//   signals/0001.json.sig   the hex HMAC of those bytes
//
// The signature sits beside the payload rather than inside it, because a signature inside the thing
// it signs has to be excised before verification and excising is exactly where byte-exactness dies.
// Out of band, the bytes on disk ARE the signed message, with nothing to reconstruct.
//
// A file that cannot be read or parsed never reaches the pipeline, and is reported here rather than
// thrown. The caller dead-letters it: a payload nobody could parse is the case with the clearest fix
// at the sender, so losing it would be losing the only actionable thing about it.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MISSING_SIGNATURE = '';

function readSignature(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : MISSING_SIGNATURE;
}

/**
 * Every signal in a directory, plus the ones that could not be read at all.
 *
 * Returns `{ signals, dead }`. A signal carries `raw` (the exact bytes) and `signature` beside its
 * parse, which is what src/stages/ingest.mjs verifies in raw mode.
 *
 * Sorted by filename, because filesystem order is not a specification — the same rule the fixture
 * loader has followed since M1.
 */
export function loadLiveSignals(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { signals: [], dead: [], missingDir: true };
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const signals = [];
  const dead = [];

  for (const name of files) {
    const path = join(dir, name);
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      dead.push({ source: name, raw: '', reason: 'UNREADABLE_PAYLOAD', detail: error.message });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      dead.push({ source: name, raw, reason: 'UNREADABLE_PAYLOAD', detail: `not parseable JSON: ${error.message}` });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      dead.push({ source: name, raw, reason: 'UNREADABLE_PAYLOAD', detail: 'the payload is not a JSON object' });
      continue;
    }

    signals.push({ ...parsed, raw, signature: readSignature(`${path}.sig`), source_file: name });
  }

  return { signals, dead, missingDir: false };
}

/**
 * One signal from raw bytes and a signature, for stdin and for DLQ replay.
 */
export function liveSignalFromBytes(raw, signature, source = 'stdin') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { dead: { source, raw, reason: 'UNREADABLE_PAYLOAD', detail: `not parseable JSON: ${error.message}` } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dead: { source, raw, reason: 'UNREADABLE_PAYLOAD', detail: 'the payload is not a JSON object' } };
  }
  return { signal: { ...parsed, raw, signature: String(signature ?? '').trim(), source_file: source } };
}
