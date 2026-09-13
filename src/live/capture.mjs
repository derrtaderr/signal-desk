// Capture, so a live run is replayable from its own record. M4 spec §6.
//
// TWO DIFFERENT PROMISES, and conflating them is how "replay" becomes a word that means nothing:
//
//   A FIXTURE run is REPRODUCIBLE. Re-execute it from the committed corpus and the bytes match, on
//   any machine, forever, because every input is in the repo.
//   A LIVE run is REPLAYABLE FROM ITS OWN CAPTURE. It read a real clock and real strangers' servers,
//   and neither will answer identically tomorrow. What it can do is write down everything it
//   observed, so somebody who was not there can re-execute it offline and keylessly and get the
//   same bytes. That is a weaker guarantee, and the README says which one it is rather than letting
//   one word carry both.
//
// THREE THINGS have to be captured, and missing any one turns a replay into a different run wearing
// the same id: the enrichment responses, the model completions, and the clock. The clock is the one
// that is easy to forget — every ledger entry is stamped with it, so a replay that re-reads the wall
// clock differs in every single line for a reason nobody can see in the diff. The clocks live in
// src/context.mjs beside the fixture one; the two transports are wrapped here.
//
// EVERYTHING CAPTURED IS SHAREABLE. The capture is written inside the run directory and the whole
// point is handing it to somebody. So it records what a source SAID and what the model SAID, and
// never how either request was addressed or authorised. No key, no headers, no endpoint. A test
// asserts that rather than a comment promising it.

import { createHash } from 'node:crypto';

import { canonical } from '../canonical.mjs';
import { NoRecordingError } from '../context.mjs';

/**
 * The capture key for one model request.
 *
 * Derived from the request, so a replay that rebuilds the identical prompt finds the completion
 * that prompt produced. This is why the untrusted fence in src/draft-prompt.mjs has to be
 * deterministic: a random delimiter would change the request on replay and orphan its own capture.
 */
export function modelKey(request) {
  const digest = createHash('sha256').update(canonical(request ?? {})).digest('hex');
  return `model:${digest.slice(0, 16)}`;
}

/**
 * Wraps a fetcher so every response it returns is written into `capture`.
 *
 * A FAILED fetch captures nothing. A capture is a record of what was observed, and storing a
 * failure as though it were a response would let a replay succeed where the live run did not —
 * the one direction a replay must never drift. A non-200 IS captured, because a 404 is an answer
 * the run acted on.
 */
export function capturingFetcher(fetch, capture) {
  return async function fetchAndCapture(url) {
    const response = await fetch(url);
    capture[url] = response;
    return response;
  };
}

/**
 * Wraps a model seam so every completion is written into `capture`, keyed by its request.
 *
 * Only the completion is stored. The request is represented by its digest in the key, which is
 * enough to address it on replay and carries none of the prompt's contents into a second copy.
 */
export function capturingModel(model, capture) {
  return async function callAndCapture(request) {
    const completion = await model(request);
    capture[modelKey(request)] = {
      text: completion?.text,
      model: completion?.model ?? null,
      ...(completion?.stop_reason === undefined ? {} : { stop_reason: completion.stop_reason }),
    };
    return completion;
  };
}

/**
 * A model seam backed by a capture rather than a provider.
 *
 * Throws on a request with no capture behind it, which is the recorded fetcher's rule since M1:
 * fixture mode never falls back to a live call, and a replay never falls back to inventing a
 * completion. A replay that quietly produced text nobody recorded would be a new run claiming to
 * be an old one.
 */
export function recordedModel(recordings) {
  return async function callRecorded(request) {
    const key = modelKey(request);
    if (!Object.prototype.hasOwnProperty.call(recordings, key)) {
      throw new NoRecordingError(key);
    }
    return JSON.parse(JSON.stringify(recordings[key]));
  };
}
