// The sealed terminal ledger entry.
//
// The M1 review's missing question, and it is a real hole: a hash chain proves ORDER and
// INTEGRITY, not COMPLETENESS. Every entry links to the one before it, so no line can be
// edited or reordered undetected. Nothing in that construction says anything about whether the
// last line you are holding is the last line that was written.
//
// So truncating a ledger's final entries leaves a chain that verifies perfectly clean, and the
// review demonstrated exactly that. The first test below reproduces it, and the rest pin the
// fix: a terminal entry naming the run's outcome, without which the ledger is not a record of
// a completed run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeFixtureRun } from '../src/runner.mjs';
import { verifyChain, parseLedger, isSealed, sealOf, GENESIS_PREV } from '../src/ledger.mjs';

const run = await executeFixtureRun();
const entries = run.ledger.entries();

// --- the hole, reproduced ---------------------------------------------------------------

test('a truncated ledger still verifies as an unbroken hash chain', () => {
  // This is the M1 review's repro, and it is asserted rather than fixed, because it is not a
  // bug in the chain. It is what a chain is. Stating it here is what makes the seal's job
  // legible to the next reader.
  const truncated = entries.slice(0, entries.length - 3);
  assert.deepEqual(verifyChain(truncated), { ok: true }, 'the chain has nothing to object to');
  assert.notEqual(truncated.length, entries.length, 'and three decisions have vanished');
});

test('but a truncated ledger is NOT sealed, which is how the loss is detected', () => {
  const truncated = entries.slice(0, entries.length - 3);
  assert.equal(isSealed(truncated), false);
  assert.equal(isSealed(entries), true);
});

test('dropping only the final line is caught, because the seal is the final line', () => {
  assert.equal(isSealed(entries.slice(0, entries.length - 1)), false);
});

test('an empty ledger is not sealed', () => {
  assert.equal(isSealed([]), false);
});

// --- the seal itself ----------------------------------------------------------------------

test('a completed run ends with exactly one seal, and it is the last entry', () => {
  const seals = entries.filter((e) => e.stage === 'seal');
  assert.equal(seals.length, 1);
  assert.equal(entries[entries.length - 1].stage, 'seal');
});

test('the seal carries the run summary, matching the report the run produced', () => {
  const seal = sealOf(entries);
  assert.deepEqual(seal.summary, run.report.summary);
});

test('the seal carries the head hash of everything before it', () => {
  const seal = sealOf(entries);
  const previous = entries[entries.length - 2];
  assert.equal(seal.head, previous.hash, 'the head names the last decision the run recorded');
  assert.equal(seal.prev, previous.hash, 'and the chain link agrees with it');
});

test('the head is inside the hashed payload, so editing it breaks the seal itself', () => {
  // Not merely duplicated for convenience. Because `head` is part of the payload the entry's
  // own hash covers, a forger cannot rewrite the summary or the head and leave a valid entry.
  const seal = sealOf(entries);
  const forged = { ...seal, head: GENESIS_PREV };
  assert.deepEqual(verifyChain([...entries.slice(0, -1), forged]).ok, false);
});

test('rewriting the seal summary also breaks the chain', () => {
  const seal = sealOf(entries);
  const forged = { ...seal, summary: { ...seal.summary, REFUSE: 0 } };
  const result = verifyChain([...entries.slice(0, -1), forged]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /hashes to/);
});

test('the seal files under a sentinel lead id no derived lead can collide with', () => {
  const seal = sealOf(entries);
  assert.equal(seal.lead_id, '-');
  for (const entry of entries.filter((e) => e.stage !== 'seal')) {
    assert.notEqual(entry.lead_id, '-');
  }
});

test('the seal is a system record, not a human one', () => {
  assert.equal(sealOf(entries).actor, 'system');
});

test('the seal is a valid ledger entry like any other', () => {
  const seal = sealOf(entries);
  for (const field of ['ts', 'run_id', 'lead_id', 'stage', 'verdict', 'reason_codes', 'evidence_refs', 'actor']) {
    assert.notEqual(seal[field], undefined, `the seal carries ${field}`);
  }
  assert.deepEqual(verifyChain(entries), { ok: true });
});

test('the seal is deterministic, so a sealed run still replays byte for byte', async () => {
  const second = await executeFixtureRun();
  assert.equal(run.ledger.toJSONL(), second.ledger.toJSONL());
  assert.equal(sealOf(entries).hash, sealOf(second.ledger.entries()).hash);
});

test('sealOf returns nothing for a ledger that has none', () => {
  assert.equal(sealOf(entries.slice(0, 3)), undefined);
  assert.equal(sealOf([]), undefined);
});

// --- the seal survives a round trip through the file format --------------------------------

test('a sealed ledger written and re-parsed is still sealed', () => {
  const reparsed = parseLedger(run.ledger.toJSONL());
  assert.equal(isSealed(reparsed), true);
  assert.deepEqual(sealOf(reparsed).summary, run.report.summary);
});
