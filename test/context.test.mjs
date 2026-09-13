import test from 'node:test';
import assert from 'node:assert/strict';

import { fixtureClock, recordedFetcher, createContext, NoRecordingError } from '../src/context.mjs';
import { Ledger } from '../src/ledger.mjs';

test('the fixture clock starts at the instant it was given', () => {
  const clock = fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 });
  assert.equal(clock.now(), '2026-03-01T09:00:00.000Z');
});

test('the fixture clock advances a fixed step per call, so time is a function of position', () => {
  const clock = fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 });
  assert.equal(clock.now(), '2026-03-01T09:00:00.000Z');
  assert.equal(clock.now(), '2026-03-01T09:00:01.000Z');
  assert.equal(clock.now(), '2026-03-01T09:00:02.000Z');
});

test('two fixture clocks built the same way emit the same sequence', () => {
  const build = () => {
    const clock = fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 500 });
    return [clock.now(), clock.now(), clock.now()];
  };
  assert.deepEqual(build(), build());
});

test('the fixture clock rejects an unparseable start instant', () => {
  assert.throws(() => fixtureClock({ start: 'not-a-date', stepMs: 1 }), /start/);
});

test('the recorded fetcher returns the recording for a known url', async () => {
  const fetcher = recordedFetcher({
    'https://example.test/a': { status: 200, body: { name: 'Acme' } },
  });
  const response = await fetcher('https://example.test/a');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { name: 'Acme' });
});

test('the recorded fetcher throws NoRecordingError for an unknown url, never a live call', async () => {
  const fetcher = recordedFetcher({});
  await assert.rejects(() => fetcher('https://example.test/missing'), NoRecordingError);
});

test('the NoRecordingError names the url it was asked for', async () => {
  const fetcher = recordedFetcher({});
  await assert.rejects(
    () => fetcher('https://example.test/missing'),
    /https:\/\/example\.test\/missing/,
  );
});

test('the recorded fetcher hands back a deep copy, so a caller cannot poison the recording', async () => {
  const fetcher = recordedFetcher({
    'https://example.test/a': { status: 200, body: { name: 'Acme' } },
  });
  const first = await fetcher('https://example.test/a');
  first.body.name = 'Tampered';
  const second = await fetcher('https://example.test/a');
  assert.equal(second.body.name, 'Acme');
});

test('createContext exposes the clock, the fetcher, the config and the ledger appender', () => {
  const ledger = new Ledger();
  const ctx = createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture' },
    run_id: 'run-1',
  });
  assert.equal(typeof ctx.clock.now, 'function');
  assert.equal(typeof ctx.fetch, 'function');
  assert.deepEqual(ctx.config, { mode: 'fixture' });
  assert.equal(ctx.run_id, 'run-1');
  assert.equal(typeof ctx.ledger.append, 'function');
  assert.equal(typeof ctx.ledger.entriesFor, 'function');
});

test('the context config is frozen, so a stage cannot reconfigure the run mid-flight', () => {
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture' },
    run_id: 'run-1',
  });
  assert.throws(() => {
    'use strict';
    ctx.config.mode = 'live';
  });
});
