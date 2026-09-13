import test from 'node:test';
import assert from 'node:assert/strict';

import { gate } from '../src/stages/gate.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';

function lead(draftOverrides = {}, leadOverrides = {}) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    claims: [
      { field: 'employee_count', value: 240, citation: DIRECTORY, cited: true },
      { field: 'contact_title', value: 'VP Revenue Operations', citation: null, cited: false },
    ],
    citations: [DIRECTORY],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae', play: 'problem-first', reason: 'x' },
    draft: {
      to: 'dana@acme.test',
      subject: 'A question about Acme Robotics',
      body: 'Hi Dana,\n\nYou run revenue operations at a company of about 240 people.\n\nWorth a short conversation?',
      template: 'problem-first',
      claim_refs: [{ field: 'employee_count', citation: DIRECTORY }],
      ...draftOverrides,
    },
    ...leadOverrides,
  };
}

function makeCtx(config = {}) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: {
      mode: 'fixture',
      gate: {
        minBodyChars: 40,
        maxBodyChars: 900,
        bannedPhrases: ['guaranteed results', '100% risk free'],
        ...config,
      },
    },
    run_id: 'run-test',
  });
}

test('a clean, grounded draft passes the gate', async () => {
  const result = await gate.run(lead(), makeCtx());
  assert.equal(result.status, 'PASS');
});

test('the gate reports which rules it ran, so a pass is inspectable too', async () => {
  const result = await gate.run(lead(), makeCtx());
  assert.ok(result.output.gate.rules_run.length >= 5);
  assert.deepEqual(result.output.gate.violations, []);
});

// --- independent grounding re-check --------------------------------------------------

test('a claim_ref with no matching cited claim on the lead REFUSES with UNGROUNDED_CLAIM', async () => {
  const result = await gate.run(
    lead({ claim_refs: [{ field: 'revenue', citation: DIRECTORY }] }),
    makeCtx(),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
  assert.match(result.detail, /revenue/);
});

test('a claim_ref pointing at an uncited claim REFUSES, even though the field exists', async () => {
  const result = await gate.run(
    lead({ claim_refs: [{ field: 'contact_title', citation: null }] }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
});

test('a claim_ref citing a source the lead never fetched REFUSES', async () => {
  const result = await gate.run(
    lead({ claim_refs: [{ field: 'employee_count', citation: 'https://invented.test/x' }] }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
});

// --- unresolved placeholders ---------------------------------------------------------

test('an unresolved placeholder in the body REFUSES with PLACEHOLDER_UNRESOLVED', async () => {
  const result = await gate.run(lead({ body: 'Hi {contact_first_name}, this never filled in properly.' }), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['PLACEHOLDER_UNRESOLVED']);
});

test('an unresolved placeholder in the subject REFUSES too', async () => {
  const result = await gate.run(lead({ subject: 'About {company_name}' }), makeCtx());
  assert.deepEqual(result.reason_codes, ['PLACEHOLDER_UNRESOLVED']);
});

// --- PII leakage ---------------------------------------------------------------------

test('a third-party email address in the body REFUSES with PII_IN_BODY', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nI also spoke with marcus.webb@othercorp.test about this account already.' }),
    makeCtx(),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['PII_IN_BODY']);
  assert.match(result.detail, /othercorp\.test/);
});

test("the recipient's own address in the body is not a leak", async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nI am writing to dana@acme.test about your pricing visit this week.' }),
    makeCtx(),
  );
  assert.equal(result.status, 'PASS');
});

test('a phone number in the body REFUSES with PII_IN_BODY', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nYour colleague can be reached on 415-555-0132 most afternoons.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['PII_IN_BODY']);
});

// --- banned phrases and length -------------------------------------------------------

test('a banned phrase REFUSES with BANNED_PHRASE and names the phrase', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nWe deliver guaranteed results for teams like yours, every time.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['BANNED_PHRASE']);
  assert.match(result.detail, /guaranteed results/);
});

test('the banned phrase check is case-insensitive', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nWe deliver GUARANTEED RESULTS for teams like yours, every time.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['BANNED_PHRASE']);
});

test('a body under the minimum REFUSES with DRAFT_TOO_SHORT', async () => {
  const result = await gate.run(lead({ body: 'Hi.' }), makeCtx());
  assert.deepEqual(result.reason_codes, ['DRAFT_TOO_SHORT']);
});

test('a body over the maximum REFUSES with DRAFT_TOO_LONG', async () => {
  const result = await gate.run(lead({ body: `Hi Dana, ${'x'.repeat(2000)}` }), makeCtx());
  assert.deepEqual(result.reason_codes, ['DRAFT_TOO_LONG']);
});

// --- fail-closed ---------------------------------------------------------------------

test('a gate that cannot evaluate REFUSES with GATE_ERROR; it never passes on error', async () => {
  const result = await gate.run(lead({}, { draft: undefined }), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['GATE_ERROR']);
});

test('a gate handed a malformed config still refuses rather than skipping its rules', async () => {
  const ctx = makeCtx({ bannedPhrases: 'not-an-array' });
  const result = await gate.run(lead(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['GATE_ERROR']);
});

// --- reporting -----------------------------------------------------------------------

test('every violation is reported, not just the first, so one pass shows all the work', async () => {
  const result = await gate.run(
    lead({ body: 'Hi {name}, guaranteed results await at contact@other.test.' }),
    makeCtx(),
  );
  assert.equal(result.status, 'REFUSE');
  assert.ok(result.output.gate.violations.length >= 3);
});

test('the refusal reason code is the first violation in a stable rule order', async () => {
  const result = await gate.run(
    lead({ body: 'Hi {name}, guaranteed results await at contact@other.test.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['PLACEHOLDER_UNRESOLVED']);
});

test('gating is deterministic: the same draft gates the same way twice', async () => {
  const a = await gate.run(lead(), makeCtx());
  const b = await gate.run(lead(), makeCtx());
  assert.deepEqual(a.output.gate, b.output.gate);
});
