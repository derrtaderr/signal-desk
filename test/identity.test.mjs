// The identity model: one person, one motion.
//
// This file exists because of a specific, demonstrated bug. The M1 review found that a second
// validly signed signal carrying a DIFFERENT signal id for the SAME contact passed ingest, ran
// the whole pipeline a second time, consumed the same recorded approval again, and wrote its
// handoff artifact over the first one. One person, two motions, one surviving artifact.
//
// The mechanism is worth stating because it is not obvious: the HMAC covers `payload` and
// nothing else. Changing only the `id` field leaves the signature valid, so signal-level
// idempotency can be stepped around without forging anything.
//
// docs/M2-SPEC.md decides the model these tests pin: the lead is the identity, and within a run
// a lead receives at most one motion. Signal-level dedup stays as it was and keeps its own
// reason code, because a replayed webhook and a second distinct signal are different events.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, buildRun } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { signPayload } from '../src/stages/ingest.mjs';
import { FIXTURE_SECRET } from '../src/config.mjs';

// The acme signal, re-issued under a new signal id. Same payload, so the same signature is
// still valid. This is the hostile input, built here rather than mutated from disk.
function twinOf(signal, newId) {
  return { ...signal, id: newId, received_at: '2026-03-01T08:59:50.000Z' };
}

async function runWith(signals) {
  const fixtures = loadFixtures();
  const built = buildRun({ fixtures: { ...fixtures, signals } });
  const report = await runPipeline({
    stages: built.stages,
    signals: built.signals,
    ctx: built.ctx,
    ledger: built.ledger,
  });
  return { report, ledger: built.ledger };
}

function acmeAndTwin() {
  const { signals } = loadFixtures();
  const acme = signals.find((s) => s.id === 'sig-1001');
  return [acme, twinOf(acme, 'sig-1099')];
}

// --- the mechanism, stated as its own assertion --------------------------------------

test('the signature covers the payload only, so re-issuing under a new id stays valid', () => {
  const [acme, twin] = acmeAndTwin();
  assert.notEqual(twin.id, acme.id, 'the twin carries a different signal id');
  assert.equal(
    twin.signature,
    signPayload(FIXTURE_SECRET, twin.payload),
    'and it is still correctly signed, so only lead-level dedup can catch it',
  );
});

test('both signals resolve to the same lead, because the lead is the person', async () => {
  const { ledger } = await runWith(acmeAndTwin());
  const ingestEntries = ledger.entries().filter((e) => e.stage === 'ingest');
  assert.equal(ingestEntries.length, 2, 'both signals were seen by ingest');

  // The accepted signal files under the canonical lead id. The refused one files under its
  // own signal id, because the kernel adopts an assigned lead id only on PASS, and names the
  // lead it collided with in its evidence instead. Identity resolution is the property under
  // test here, so it is read from where each entry actually records it.
  const accepted = ingestEntries.find((e) => e.verdict === 'PASS');
  const refused = ingestEntries.find((e) => e.verdict === 'REFUSE');
  assert.ok(
    refused.evidence_refs.includes(`lead:${accepted.lead_id}`),
    'the refused signal resolved to the same lead the accepted one created',
  );
});

// --- the repro, now closed -----------------------------------------------------------

test('a second signal for a lead already accepted this run is REFUSED', async () => {
  const { report } = await runWith(acmeAndTwin());
  const refused = report.leads.filter((l) => l.final_status === 'REFUSE');
  assert.equal(refused.length, 1, 'exactly one of the pair was refused');
  assert.deepEqual(refused[0].reason_codes, ['DUPLICATE_LEAD']);
});

test('the second signal is caught at ingest, before anything acts on it', async () => {
  const { ledger } = await runWith(acmeAndTwin());
  const refusals = ledger.entries().filter((e) => e.verdict === 'REFUSE');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].stage, 'ingest');
});

test('the refusal names the signal it refused and the lead it collided with', async () => {
  const { ledger } = await runWith(acmeAndTwin());
  const [refusal] = ledger.entries().filter((e) => e.verdict === 'REFUSE');
  assert.ok(
    refusal.evidence_refs.includes('signal:sig-1099'),
    'the trail names which signal was turned away',
  );
  assert.match(refusal.detail, /already been accepted/);
});

test('DUPLICATE_LEAD is distinct from DUPLICATE_SIGNAL, so the ledger says which happened', async () => {
  const { signals } = loadFixtures();
  const acme = signals.find((s) => s.id === 'sig-1001');

  // A replayed webhook: the same signal id arriving twice.
  const replay = await runWith([acme, { ...acme, received_at: '2026-03-01T08:59:45.000Z' }]);
  const replayCodes = replay.ledger
    .entries()
    .filter((e) => e.verdict === 'REFUSE')
    .flatMap((e) => e.reason_codes);
  assert.deepEqual(replayCodes, ['DUPLICATE_SIGNAL']);

  // A second distinct signal about the same person.
  const second = await runWith(acmeAndTwin());
  const secondCodes = second.ledger
    .entries()
    .filter((e) => e.verdict === 'REFUSE')
    .flatMap((e) => e.reason_codes);
  assert.deepEqual(secondCodes, ['DUPLICATE_LEAD']);
});

// --- the consequences the bug actually had -------------------------------------------

test('exactly one draft is written for the pair, so the motion is not doubled', async () => {
  const { ledger } = await runWith(acmeAndTwin());
  const drafts = ledger.entries().filter((e) => e.stage === 'draft' && e.verdict === 'PASS');
  assert.equal(drafts.length, 1);
});

test('one recorded approval is consumed once, never twice', async () => {
  const { ledger } = await runWith(acmeAndTwin());
  const approvals = ledger
    .entries()
    .filter((e) => e.actor === 'human' && e.reason_codes.includes('APPROVED_BY_HUMAN'));
  assert.equal(approvals.length, 1, 'the human authorised one draft, and one draft went out');
});

test('exactly one lead reaches handoff, so there is one artifact and nothing to overwrite', async () => {
  const { report } = await runWith(acmeAndTwin());
  const handed = report.leads.filter((l) => l.final_stage === 'handoff' && l.final_status === 'PASS');
  assert.equal(handed.length, 1);
});

// --- the model's boundary, named so it is not mistaken for an oversight ---------------

test('two different people at the same company are two leads, not one', async () => {
  const { signals } = loadFixtures();
  const acme = signals.find((s) => s.id === 'sig-1001');
  const colleague = {
    ...acme,
    id: 'sig-1098',
    payload: {
      ...acme.payload,
      contact: { name: 'Jordan Poole', email: 'jordan@acme.test', title: 'VP Revenue Operations' },
    },
  };
  colleague.signature = signPayload(FIXTURE_SECRET, colleague.payload);

  const { ledger } = await runWith([acme, colleague]);
  const accepted = ledger
    .entries()
    .filter((e) => e.stage === 'ingest' && e.verdict === 'PASS')
    .map((e) => e.lead_id);
  assert.equal(accepted.length, 2, 'both were accepted');
  assert.equal(new Set(accepted).size, 2, 'as two distinct leads');
});
