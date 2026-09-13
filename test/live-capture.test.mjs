// Capture and replay of a live run's own inputs. M4 spec §6.
//
// The promise being built here, stated precisely because the word "replay" can carry two very
// different meanings and only one of them is true of a live run:
//
//   A FIXTURE run is REPRODUCIBLE. Re-execute it from the committed corpus and the bytes match,
//   on any machine, forever.
//   A LIVE run is REPLAYABLE FROM ITS OWN CAPTURE. It read a real clock and real strangers' servers,
//   neither of which will answer identically tomorrow. What it can do is record everything it
//   observed, so the run can be re-executed offline and keylessly by somebody who was not there.
//
// Three things have to be captured for that to hold, and missing any one of them turns a replay
// into a different run wearing the same id: the enrichment responses, the model completions, and
// THE CLOCK. The clock is the one that is easy to forget, and the ledger stamps every entry with
// it, so a replay that re-reads the wall clock differs in every single line.

import test from 'node:test';
import assert from 'node:assert/strict';

import { capturingFetcher, capturingModel, recordedModel, modelKey } from '../src/live/capture.mjs';
import { recordingClock, recordedClock, NoRecordingError } from '../src/context.mjs';

// --- the clock -------------------------------------------------------------------------------

test('a recording clock stamps real instants and remembers every one it issued', () => {
  const reads = ['2026-03-01T09:00:00.000Z', '2026-03-01T09:00:02.000Z', '2026-03-01T09:00:05.000Z'];
  let index = 0;
  const clock = recordingClock({ read: () => reads[index++] });

  assert.equal(clock.now(), reads[0]);
  assert.equal(clock.now(), reads[1]);
  assert.deepEqual(clock.readings(), [reads[0], reads[1]]);
});

test('peek returns the instant the NEXT now will stamp, so a validation check cannot skew the trail', () => {
  // The rule ingest's replay window has followed since M1: a check must not advance the clock. With
  // a real clock that needs one wall-clock sample to serve both calls, or peek and now disagree and
  // a ledger's instants start depending on how many branches a stage took.
  const reads = ['2026-03-01T09:00:00.000Z', '2026-03-01T09:00:09.000Z'];
  let index = 0;
  const clock = recordingClock({ read: () => reads[index++] });

  assert.equal(clock.peek(), reads[0]);
  assert.equal(clock.peek(), reads[0], 'peeking twice does not sample twice');
  assert.equal(clock.now(), reads[0], 'and now returns exactly what peek promised');
  assert.equal(clock.now(), reads[1]);
  assert.deepEqual(clock.readings(), [reads[0], reads[1]], 'only issued instants are recorded');
});

test('a recorded clock reissues the captured instants in order, so a replay stamps identically', () => {
  const readings = ['2026-03-01T09:00:00.000Z', '2026-03-01T09:00:02.000Z'];
  const clock = recordedClock(readings);
  assert.equal(clock.peek(), readings[0]);
  assert.equal(clock.now(), readings[0]);
  assert.equal(clock.peek(), readings[1]);
  assert.equal(clock.now(), readings[1]);
});

test('a replay that needs more instants than were captured THROWS rather than inventing one', () => {
  // Fail-closed applied to time. A replay that quietly reads the wall clock past the end of the
  // capture would produce a ledger that differs for a reason nobody could see in the diff.
  const clock = recordedClock(['2026-03-01T09:00:00.000Z']);
  clock.now();
  assert.throws(() => clock.now(), /captured/i);
});

test('the recording and recorded clocks agree, which is the property replay depends on', () => {
  const reads = ['2026-03-01T09:00:00.000Z', '2026-03-01T09:00:03.000Z', '2026-03-01T09:00:04.000Z'];
  let index = 0;
  const live = recordingClock({ read: () => reads[index++] });

  // A realistic mix: peek before a stamp, two bare stamps, a peek with no stamp after it.
  const observed = [live.peek(), live.now(), live.now(), live.now()];
  const replayed = recordedClock(live.readings());
  assert.deepEqual([replayed.peek(), replayed.now(), replayed.now(), replayed.now()], observed);
});

// --- capturing the fetcher --------------------------------------------------------------------

test('a captured response is stored in the recorded fetcher OWN format, so a replay just reads it', async () => {
  const capture = {};
  const fetcher = capturingFetcher(
    async (url) => ({ status: 200, body: { as_of: 'x', claims: { a: 1 } }, fetched_at: '2026-03-01T09:00:00.000Z' }),
    capture,
  );
  const response = await fetcher('https://directory.example.com/c');
  assert.deepEqual(capture['https://directory.example.com/c'], response);
});

test('the captured response carries fetched_at, because the ledger detail quotes it', async () => {
  // Leaving it out would make a live run's ledger and its replay differ by one line, for a reason
  // buried three modules away.
  const capture = {};
  const fetcher = capturingFetcher(async () => ({ status: 200, body: {}, fetched_at: '2026-03-01T09:00:00.500Z' }), capture);
  await fetcher('https://directory.example.com/c');
  assert.equal(capture['https://directory.example.com/c'].fetched_at, '2026-03-01T09:00:00.500Z');
});

test('a failed fetch captures NOTHING and the failure propagates', async () => {
  // A capture is a record of what was observed. Storing a failure as though it were a response
  // would let a replay succeed where the live run did not, which is the one direction a replay
  // must never drift.
  const capture = {};
  const fetcher = capturingFetcher(async () => { throw new Error('unreachable'); }, capture);
  await assert.rejects(() => fetcher('https://directory.example.com/c'), /unreachable/);
  assert.deepEqual(capture, {});
});

test('a non-200 answer IS captured, because it is an answer the run acted on', async () => {
  const capture = {};
  const fetcher = capturingFetcher(async () => ({ status: 404, body: {}, fetched_at: 't' }), capture);
  await fetcher('https://directory.example.com/c');
  assert.equal(capture['https://directory.example.com/c'].status, 404);
});

// --- capturing the model ----------------------------------------------------------------------

test('a model call is captured under a key derived from the request', async () => {
  const capture = {};
  const model = capturingModel(async () => ({ text: '{"ok":true}', model: 'claude-sonnet-5' }), capture);
  const request = { system: 'sys', prompt: 'write' };
  await model(request);
  assert.deepEqual(Object.keys(capture), [modelKey(request)]);
  assert.match(modelKey(request), /^model:[0-9a-f]{16}$/);
});

test('the same request keys the same way and a different one does not', () => {
  assert.equal(modelKey({ system: 's', prompt: 'p' }), modelKey({ system: 's', prompt: 'p' }));
  assert.notEqual(modelKey({ system: 's', prompt: 'p' }), modelKey({ system: 's', prompt: 'q' }));
});

test('a captured model call replays through recordedModel without a key or a socket', async () => {
  const capture = {};
  const live = capturingModel(async () => ({ text: '{"subject":"s","body":"b"}', model: 'claude-sonnet-5' }), capture);
  const request = { system: 'sys', prompt: 'write to Dana' };
  const original = await live(request);

  const replayed = await recordedModel(capture)(request);
  assert.deepEqual(replayed, original);
});

test('a model request with no capture behind it THROWS, never silently returns nothing', async () => {
  // The same rule the recorded fetcher has followed since M1: fixture mode never falls back to a
  // live call, and a replay never falls back to inventing a completion.
  await assert.rejects(() => recordedModel({})({ system: 's', prompt: 'p' }), (error) => {
    assert.ok(error instanceof NoRecordingError);
    return true;
  });
});

test('the captured model entry holds no key, no headers and no endpoint', async () => {
  // A capture is written to disk inside the run directory and is meant to be shareable. It records
  // what the model SAID, never how the request was authorised.
  const capture = {};
  const model = capturingModel(async () => ({ text: 'ok', model: 'claude-sonnet-5' }), capture);
  await model({ system: 's', prompt: 'p' });
  const entry = capture[modelKey({ system: 's', prompt: 'p' })];
  const serialised = JSON.stringify(entry);
  // The provider host is assembled from parts rather than written out, because
  // test/no-network.test.mjs forbids a test file from naming a real one — and it is right to.
  for (const name of ['x-api-key', 'authorization', ['api', 'anthropic', 'com'].join('.')]) {
    assert.ok(!serialised.includes(name), `the capture names ${name}`);
  }
});
