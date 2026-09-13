// The draft-content hash.
//
// This is the value an approval binds to. M1 bound approvals to a lead id, and the M1 review
// demonstrated the consequence: one recorded approval authorised a second draft the human had
// never seen. Binding to content is what makes "approved" mean "approved THIS", and every
// property that depends on it is pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDraftHash, DRAFT_HASH_FIELDS } from '../src/draft-hash.mjs';
import { draft as draftStage } from '../src/stages/draft.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { defaultConfig } from '../src/config.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';

function draftOf(overrides = {}) {
  return {
    to: 'dana@acme.test',
    subject: 'A question about Acme Robotics',
    body: 'Hi Dana,\n\nAt around 240 people, who decides which inbound signals get a reply?',
    template: 'problem-first',
    claim_refs: [{ field: 'employee_count', citation: DIRECTORY }],
    ...overrides,
  };
}

test('a draft hash is a stable, prefixed, fixed-width identifier', () => {
  assert.match(computeDraftHash(draftOf()), /^draft-[0-9a-f]{16}$/);
});

test('the same draft hashes the same way twice, so a run can be replayed', () => {
  assert.equal(computeDraftHash(draftOf()), computeDraftHash(draftOf()));
});

test('key order in the draft object does not change the hash', () => {
  const forward = draftOf();
  const reordered = {
    claim_refs: forward.claim_refs,
    template: forward.template,
    body: forward.body,
    subject: forward.subject,
    to: forward.to,
  };
  assert.equal(computeDraftHash(forward), computeDraftHash(reordered));
});

// --- every field that changes the message changes the hash ---------------------------

test('changing the body changes the hash', () => {
  assert.notEqual(
    computeDraftHash(draftOf()),
    computeDraftHash(draftOf({ body: 'Hi Dana,\n\nSomething else entirely.' })),
  );
});

test('changing the subject changes the hash', () => {
  assert.notEqual(computeDraftHash(draftOf()), computeDraftHash(draftOf({ subject: 'Different' })));
});

test('changing the recipient changes the hash, so an approval cannot be redirected', () => {
  assert.notEqual(
    computeDraftHash(draftOf()),
    computeDraftHash(draftOf({ to: 'someone.else@acme.test' })),
  );
});

test('changing a claim reference changes the hash, even with identical prose', () => {
  assert.notEqual(
    computeDraftHash(draftOf()),
    computeDraftHash(draftOf({ claim_refs: [{ field: 'employee_count', citation: 'https://elsewhere.test/x' }] })),
  );
});

test('the hashed fields are exactly the message, named rather than implied', () => {
  assert.deepEqual([...DRAFT_HASH_FIELDS].sort(), ['body', 'claim_refs', 'subject', 'template', 'to']);
});

test('a field outside the message does not affect the hash', () => {
  // Downstream stages decorate the lead. The hash must cover what was written, and nothing
  // about what happened to it afterwards, or an approval would be invalidated by its own
  // recording.
  const withExtras = { ...draftOf(), gate_passed: true, exported_at: '2026-03-01T09:00:00.000Z' };
  assert.equal(computeDraftHash(draftOf()), computeDraftHash(withExtras));
});

// --- fail-closed ---------------------------------------------------------------------

test('hashing a missing draft throws rather than returning a hash of nothing', () => {
  assert.throws(() => computeDraftHash(undefined), /draft/i);
  assert.throws(() => computeDraftHash(null), /draft/i);
});

test('hashing a draft missing a message field throws rather than hashing a hole', () => {
  const { body, ...withoutBody } = draftOf();
  assert.throws(() => computeDraftHash(withoutBody), /body/);
});

// --- the draft stage attaches it -----------------------------------------------------

function leadForDrafting() {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    claims: [
      { field: 'employee_count', value: 240, citation: DIRECTORY, cited: true },
      { field: 'industry', value: 'industrial robotics', citation: DIRECTORY, cited: true },
    ],
    citations: [DIRECTORY],
    score: { total: 96, factors: [] },
    route: { band: 'standard', owner: 'sdr-queue', play: 'problem-first', reason: 'x' },
  };
}

function ctxFor() {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock(defaultConfig.clock),
    fetch: recordedFetcher({}),
    config: defaultConfig,
    run_id: 'run-test',
  });
}

test('the draft stage attaches the hash of what it just composed', async () => {
  const result = await draftStage.run(leadForDrafting(), ctxFor());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.draft_hash, computeDraftHash(result.output.draft));
});

test('the hash sits beside the draft, never inside it, so it is not part of its own preimage', async () => {
  const result = await draftStage.run(leadForDrafting(), ctxFor());
  assert.equal(result.output.draft.hash, undefined);
  assert.equal(result.output.draft.draft_hash, undefined);
  assert.match(result.output.draft_hash, /^draft-[0-9a-f]{16}$/);
});

test('two leads with different messages get different draft hashes', async () => {
  const first = await draftStage.run(leadForDrafting(), ctxFor());
  const other = leadForDrafting();
  other.company = { name: 'Northwind Logistics', domain: 'northwind.test' };
  other.contact = { name: 'Sam Patel', email: 'sam@northwind.test', title: 'Manager' };
  const second = await draftStage.run(other, ctxFor());
  assert.notEqual(first.output.draft_hash, second.output.draft_hash);
});
