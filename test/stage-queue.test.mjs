import test from 'node:test';
import assert from 'node:assert/strict';

import { queue } from '../src/stages/queue.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { computeDraftHash } from '../src/draft-hash.mjs';

function lead(overrides = {}) {
  const base = {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test' },
    claims: [],
    citations: [],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae', play: 'problem-first', reason: 'x' },
    draft: {
      to: 'dana@acme.test',
      subject: 'A question about Acme Robotics',
      body: 'Hi Dana,\n\nWho owns the handoff between the signal and the send?',
      template: 'problem-first',
      claim_refs: [],
    },
    gate: { violations: [], rules_run: [] },
    ...overrides,
  };
  return { ...base, draft_hash: computeDraftHash(base.draft) };
}

function makeCtx(queueConfig = {}) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture', queue: queueConfig },
    run_id: 'run-test',
  });
}

function approvalFor(subject, overrides = {}) {
  return {
    draft_hash: subject.draft_hash,
    lead_id: subject.lead_id,
    decision: 'approve',
    by: 'dana.reviewer',
    at: '2026-03-01T08:55:00.000Z',
    ...overrides,
  };
}

// --- parking is the default ------------------------------------------------------------

test('with no recorded decision the lead parks for a human', async () => {
  const result = await queue.run(lead(), makeCtx());
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

test('parking is the default even when the gate passed cleanly', async () => {
  const result = await queue.run(lead({ gate: { violations: [], rules_run: ['all'] } }), makeCtx());
  assert.equal(result.status, 'NEEDS_HUMAN');
});

test('the parked lead carries the draft hash a human would be deciding on', async () => {
  const subject = lead();
  const result = await queue.run(subject, makeCtx());
  assert.equal(result.output.queue.draft_hash, subject.draft_hash);
  assert.ok(result.evidence_refs.includes(`draft:${subject.draft_hash}`));
});

// --- a decision bound to this exact draft -----------------------------------------------

test('an approval bound to this draft hash lets the lead through', async () => {
  const subject = lead();
  const result = await queue.run(subject, makeCtx({ approvals: [approvalFor(subject)] }));
  assert.equal(result.status, 'PASS');
});

test('an approved lead carries the approval onto its output', async () => {
  const subject = lead();
  const { output } = await queue.run(subject, makeCtx({ approvals: [approvalFor(subject)] }));
  assert.equal(output.approval.decision, 'approve');
  assert.equal(output.approval.by, 'dana.reviewer');
  assert.equal(output.approval.draft_hash, subject.draft_hash);
});

test('a human approval is recorded with actor human, not system', async () => {
  const subject = lead();
  const result = await queue.run(subject, makeCtx({ approvals: [approvalFor(subject)] }));
  const humanEntry = result.entries.find((e) => e.actor === 'human');
  assert.ok(humanEntry, 'the human decision leaves its own ledger entry');
  assert.match(humanEntry.detail, /dana\.reviewer/);
  assert.match(humanEntry.detail, new RegExp(subject.draft_hash), 'naming the draft it authorised');
});

test('a rejection bound to this draft REFUSES with REJECTED_BY_HUMAN', async () => {
  const subject = lead();
  const result = await queue.run(
    subject,
    makeCtx({ approvals: [approvalFor(subject, { decision: 'reject', note: 'wrong persona' })] }),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['REJECTED_BY_HUMAN']);
  assert.match(result.detail, /wrong persona/);
});

test('an unrecognised decision parks rather than guessing what the human meant', async () => {
  const subject = lead();
  const result = await queue.run(
    subject,
    makeCtx({ approvals: [approvalFor(subject, { decision: 'maybe' })] }),
  );
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

// --- THE M1 REVIEW'S DEMO, CLOSED --------------------------------------------------------
//
// M1 keyed approvals by lead id, so one recorded approval released a second draft the human
// had never seen. These are the tests that make that impossible.

test('an approval does NOT release a different draft for the same lead', async () => {
  const approved = lead();
  const decision = approvalFor(approved);

  // The same person, the same lead id, a different message. This is exactly the shape of the
  // M1 bug: under lead-id keying this passed.
  const rewritten = lead({
    draft: { ...approved.draft, body: 'Hi Dana,\n\nA completely different pitch you never read.' },
  });
  assert.equal(rewritten.lead_id, approved.lead_id, 'same lead, so lead-id keying would match');
  assert.notEqual(rewritten.draft_hash, approved.draft_hash, 'but a different message');

  const result = await queue.run(rewritten, makeCtx({ approvals: [decision] }));
  assert.notEqual(result.status, 'PASS', 'the unapproved draft does not advance');
  assert.deepEqual(result.reason_codes, ['APPROVAL_STALE']);
});

test('a stale approval parks rather than refusing, because what is missing is authorisation', async () => {
  const approved = lead();
  const rewritten = lead({ draft: { ...approved.draft, subject: 'Rewritten subject' } });
  const result = await queue.run(rewritten, makeCtx({ approvals: [approvalFor(approved)] }));
  assert.equal(result.status, 'NEEDS_HUMAN');
});

test('the stale refusal names both drafts, so a human can see what changed', async () => {
  const approved = lead();
  const rewritten = lead({ draft: { ...approved.draft, subject: 'Rewritten subject' } });
  const result = await queue.run(rewritten, makeCtx({ approvals: [approvalFor(approved)] }));
  assert.match(result.detail, new RegExp(approved.draft_hash), 'the draft that was decided on');
  assert.match(result.detail, new RegExp(rewritten.draft_hash), 'and the one in hand now');
});

test('a REJECTION also goes stale when the draft changes; decisions bind to content both ways', async () => {
  const rejected = lead();
  const rewritten = lead({ draft: { ...rejected.draft, subject: 'Try again' } });
  const result = await queue.run(
    rewritten,
    makeCtx({ approvals: [approvalFor(rejected, { decision: 'reject' })] }),
  );
  assert.deepEqual(result.reason_codes, ['APPROVAL_STALE']);
});

test('an approval for a different lead does not release this one', async () => {
  const subject = lead();
  const elsewhere = { ...approvalFor(subject), lead_id: 'lead-someone-else', draft_hash: 'draft-ffffffffffffffff' };
  const result = await queue.run(subject, makeCtx({ approvals: [elsewhere] }));
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

test('a decision whose hash matches but whose lead does not REFUSES', async () => {
  // Belt and braces against a hand-edited store. Content keying makes this structurally
  // unlikely, not harmless.
  const subject = lead();
  const crossed = { ...approvalFor(subject), lead_id: 'lead-someone-else' };
  const result = await queue.run(subject, makeCtx({ approvals: [crossed] }));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['APPROVAL_LEAD_MISMATCH']);
});

// --- fail-closed -------------------------------------------------------------------------

test("M1's lead-keyed approval store is REFUSED, not read as empty", async () => {
  // A store of the wrong shape must not silently mean "no approvals". Reading it as empty
  // would park a corpus a reader expected to move, and blame the wrong thing.
  const subject = lead();
  const legacy = { [subject.lead_id]: { decision: 'approve', by: 'x', at: 'y' } };
  const result = await queue.run(subject, makeCtx({ approvals: legacy }));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['QUEUE_ERROR']);
});

test('a lead whose stated draft hash disagrees with its content REFUSES', async () => {
  const subject = lead();
  subject.draft_hash = 'draft-0000000000000000';
  const result = await queue.run(subject, makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['DRAFT_HASH_MISMATCH']);
});

test('a lead with no draft at all REFUSES rather than parking something unreadable', async () => {
  // Built without the helper, which hashes the draft and would throw here itself.
  const draftless = { ...lead() };
  delete draftless.draft;
  delete draftless.draft_hash;

  const result = await queue.run(draftless, makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['QUEUE_ERROR']);
});

// --- the earned-autonomy hook --------------------------------------------------------

test('the earned-autonomy hook is disabled by default', async () => {
  const result = await queue.run(lead(), makeCtx());
  assert.equal(result.output.queue.autonomy_enabled, false);
});

test('an absent autonomy config does not enable autonomy', async () => {
  const result = await queue.run(lead(), makeCtx({ autonomy: undefined }));
  assert.equal(result.status, 'NEEDS_HUMAN');
});

test('an autonomy config present but not explicitly enabled still parks the lead', async () => {
  const result = await queue.run(lead(), makeCtx({ autonomy: { minScore: 10 } }));
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.output.queue.autonomy_enabled, false);
});

test('the shipped default config in the repo does not enable autonomy', async () => {
  const { defaultConfig } = await import('../src/config.mjs');
  assert.notEqual(defaultConfig.queue?.autonomy?.enabled, true);
});
