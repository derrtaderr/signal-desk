import test from 'node:test';
import assert from 'node:assert/strict';

import { Ledger, GENESIS_PREV, verifyChain, parseLedger } from '../src/ledger.mjs';

function entry(overrides = {}) {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    run_id: 'run-1',
    lead_id: 'lead-1',
    stage: 'ingest',
    verdict: 'PASS',
    reason_codes: [],
    evidence_refs: [],
    actor: 'system',
    ...overrides,
  };
}

test('a fresh ledger has no entries and its head is the genesis hash', () => {
  const ledger = new Ledger();
  assert.deepEqual(ledger.entries(), []);
  assert.equal(ledger.head(), GENESIS_PREV);
  assert.equal(GENESIS_PREV, '0'.repeat(64));
});

test('the first entry chains from genesis', () => {
  const ledger = new Ledger();
  const written = ledger.append(entry());
  assert.equal(written.prev, GENESIS_PREV);
  assert.match(written.hash, /^[0-9a-f]{64}$/);
  assert.equal(ledger.head(), written.hash);
});

test('each entry chains from the hash of the one before it', () => {
  const ledger = new Ledger();
  const first = ledger.append(entry());
  const second = ledger.append(entry({ stage: 'enrich' }));
  assert.equal(second.prev, first.hash);
  assert.notEqual(second.hash, first.hash);
});

test('the ledger is append-only: the array it hands back is a copy', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  const taken = ledger.entries();
  taken.push('tampered');
  assert.equal(ledger.entries().length, 1);
});

test('an appended entry is frozen, so a caller cannot rewrite history in place', () => {
  const ledger = new Ledger();
  const written = ledger.append(entry());
  assert.throws(() => {
    'use strict';
    written.verdict = 'REFUSE';
  });
  assert.equal(ledger.entries()[0].verdict, 'PASS');
});

test('the ledger rejects an entry missing a required field', () => {
  const ledger = new Ledger();
  const incomplete = entry();
  delete incomplete.stage;
  assert.throws(() => ledger.append(incomplete), /stage/);
});

test('the ledger rejects a verdict outside the contract', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.append(entry({ verdict: 'MAYBE' })), /verdict/);
});

test('the ledger rejects an actor outside system and human', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.append(entry({ actor: 'robot' })), /actor/);
});

test('toJSONL emits one canonical line per entry and a trailing newline', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  ledger.append(entry({ stage: 'enrich' }));
  const text = ledger.toJSONL();
  assert.ok(text.endsWith('\n'));
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).stage, 'ingest');
  // canonical ordering: hash sorts before lead_id sorts before prev
  assert.ok(lines[0].startsWith('{"actor":"system"'));
});

test('two ledgers fed identical entries produce identical bytes', () => {
  const build = () => {
    const ledger = new Ledger();
    ledger.append(entry());
    ledger.append(entry({ stage: 'enrich', verdict: 'REFUSE', reason_codes: ['X'] }));
    return ledger.toJSONL();
  };
  assert.equal(build(), build());
});

test('verifyChain accepts a ledger it wrote itself', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  ledger.append(entry({ stage: 'enrich' }));
  assert.deepEqual(verifyChain(ledger.entries()), { ok: true });
});

test('verifyChain catches a payload edited after the fact', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  ledger.append(entry({ stage: 'enrich' }));
  const tampered = ledger.entries().map((e) => ({ ...e }));
  tampered[0].verdict = 'REFUSE';
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.index, 0);
  assert.match(result.reason, /hash/);
});

test('verifyChain catches a removed entry, because the links no longer meet', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  ledger.append(entry({ stage: 'enrich' }));
  ledger.append(entry({ stage: 'score' }));
  const withHole = [ledger.entries()[0], ledger.entries()[2]];
  const result = verifyChain(withHole);
  assert.equal(result.ok, false);
  assert.equal(result.index, 1);
  assert.match(result.reason, /prev/);
});

test('an empty chain verifies, because nothing has been claimed yet', () => {
  assert.deepEqual(verifyChain([]), { ok: true });
});

test('parseLedger round-trips the bytes a ledger wrote', () => {
  const ledger = new Ledger();
  ledger.append(entry());
  ledger.append(entry({ stage: 'enrich' }));
  assert.deepEqual(parseLedger(ledger.toJSONL()), ledger.entries());
});
