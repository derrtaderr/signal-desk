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

const RUBRIC = {
  endpoint: 'https://judge.test/rubric',
  requiredCriteria: ['claim_grounding', 'audience_fit', 'tone'],
};

// A judge that answers cleanly about whatever draft it is asked about. These tests exercise the
// DETERMINISTIC rules, so the rubric is held constant here rather than being the thing under
// test; src/rubric.mjs has its own file covering every way a judge can fail to certify.
//
// It echoes the requested hash back, which is what a real judge asked about a specific draft
// would do, and is what the gate checks before reading the verdict.
function passingJudge() {
  return async (url) => ({
    status: 200,
    body: {
      draft_hash: url.slice(url.lastIndexOf('/') + 1),
      verdict: 'PASS',
      criteria: RUBRIC.requiredCriteria.map((name) => ({ name, verdict: 'PASS', note: 'fine' })),
    },
  });
}

function makeCtx(config = {}, fetch = passingJudge()) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch,
    config: {
      mode: 'fixture',
      gate: {
        minBodyChars: 40,
        maxBodyChars: 900,
        bannedPhrases: ['guaranteed results', '100% risk free'],
        rubric: RUBRIC,
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
  // The detail names the kind of finding, not the address. See "the refusal must not reproduce
  // the thing it refused" below for why, and for the assertions that pin it.
  assert.match(result.detail, /third-party email address/);
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

// --- fail-closed redaction: the asymmetric pass ---------------------------------------
//
// The gate does not merely look for PII, it redacts and then verifies the redaction. When the
// verifying pass still finds something, the gate cannot characterise what is in the draft, and
// that is a strictly more severe refusal than "I found a phone number".

test('PII the redacting pattern misses is caught by the verifying pass, as REDACTION_INCOMPLETE', async () => {
  // A TLD-less internal address. The redacting pattern requires a dotted TLD and does not
  // match; the broader verifying pattern does.
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nForward this to ops@internal and they will route it for you.' }),
    makeCtx(),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['REDACTION_INCOMPLETE']);
});

test('an unseparated digit run is caught by the verifying pass too', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nTheir desk line is 4155550132 if you would rather call them.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['REDACTION_INCOMPLETE']);
});

test('REDACTION_INCOMPLETE outranks PII_IN_BODY, because it is the more severe finding', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nMail marcus@othercorp.test, or failing that ops@internal.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['REDACTION_INCOMPLETE']);
  const codes = result.output.gate.violations.map((v) => v.code);
  assert.ok(codes.includes('PII_IN_BODY'), 'the ordinary finding is still reported alongside it');
});

test('the redaction rule reports the verification failure so a reader can act on it', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nForward this to ops@internal and they will route it for you.' }),
    makeCtx(),
  );
  assert.match(result.detail, /ops@internal|redaction/i);
});

test('a clean draft passes the redaction rule without its text being altered', async () => {
  // Redaction is a detection mechanism here, not a repair. Nothing is ever sent in redacted
  // form, so the draft the gate passes through must be the draft that was written.
  const original = lead();
  const result = await gate.run(original, makeCtx());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.draft.body, original.draft.body);
  assert.equal(result.output.draft.subject, original.draft.subject);
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

// --- the LLM rubric, as the gate's last rule ------------------------------------------
//
// src/rubric.mjs covers every way a judge can fail to certify. What is asserted here is the
// gate's INTEGRATION of it: that it runs, that it runs last, that it is genuinely required,
// and that it does not run on a draft already known to be broken.

test('a clean draft is not passed on the deterministic rules alone; the rubric must speak', async () => {
  // The rubric's verdict is what the pass rests on, so a gate with no judge available REFUSES.
  const result = await gate.run(lead(), makeCtx({}, recordedFetcher({})));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['RUBRIC_UNAVAILABLE']);
});

test('the rubric runs last, after every deterministic rule', async () => {
  const result = await gate.run(lead(), makeCtx());
  const rules = result.output.gate.rules_run;
  assert.equal(rules[rules.length - 1], 'llm_rubric');
  assert.deepEqual(rules, [
    'placeholder_resolution',
    'claim_grounding',
    'prose_grounding',
    'pii_redaction',
    'banned_phrases',
    'length_bounds',
    'llm_rubric',
  ]);
});

test('a passing gate records the criteria the judge answered, so the pass is inspectable', async () => {
  const result = await gate.run(lead(), makeCtx());
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.output.gate.rubric.map((c) => c.name), [
    'claim_grounding',
    'audience_fit',
    'tone',
  ]);
});

test('a rubric FAIL refuses with RUBRIC_FAILED and carries the judge note', async () => {
  const failing = async (url) => ({
    status: 200,
    body: {
      draft_hash: url.slice(url.lastIndexOf('/') + 1),
      verdict: 'FAIL',
      criteria: [
        { name: 'claim_grounding', verdict: 'PASS', note: 'fine' },
        { name: 'audience_fit', verdict: 'FAIL', note: 'written to the wrong operator' },
        { name: 'tone', verdict: 'PASS', note: 'fine' },
      ],
    },
  });
  const result = await gate.run(lead(), makeCtx({}, failing));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['RUBRIC_FAILED']);
  assert.match(result.detail, /wrong operator/);
});

test('a draft already failing a deterministic rule never reaches the judge', async () => {
  // Not an optimisation for its own sake. A short-circuit on the refusing path cannot weaken
  // fail-closed, and in live mode a known-broken draft does not deserve the spend.
  let asked = 0;
  const counting = async (url) => {
    asked += 1;
    return { status: 200, body: { draft_hash: url.slice(url.lastIndexOf('/') + 1), verdict: 'PASS', criteria: [] } };
  };
  const result = await gate.run(lead({ body: 'Hi.' }), makeCtx({}, counting));
  assert.deepEqual(result.reason_codes, ['DRAFT_TOO_SHORT']);
  assert.equal(asked, 0, 'the judge was never called');
  assert.ok(!result.output.gate.rules_run.includes('llm_rubric'));
});

test('a judge that throws refuses rather than being read as assent', async () => {
  const broken = async () => {
    throw new Error('judge exploded');
  };
  const result = await gate.run(lead(), makeCtx({}, broken));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['RUBRIC_UNAVAILABLE']);
});

// --- the draft hash the approval will bind to -----------------------------------------

test('a lead whose stated draft hash disagrees with its content REFUSES', async () => {
  const tampered = lead();
  tampered.draft_hash = 'draft-0000000000000000';
  const result = await gate.run(tampered, makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['DRAFT_HASH_MISMATCH']);
});

test('a lead carrying the correct draft hash passes, and the rubric is asked about that hash', async () => {
  const { computeDraftHash } = await import('../src/draft-hash.mjs');
  const subject = lead();
  subject.draft_hash = computeDraftHash(subject.draft);

  const asked = [];
  const recording = async (url) => {
    asked.push(url);
    return {
      status: 200,
      body: {
        draft_hash: url.slice(url.lastIndexOf('/') + 1),
        verdict: 'PASS',
        criteria: RUBRIC.requiredCriteria.map((name) => ({ name, verdict: 'PASS', note: 'fine' })),
      },
    };
  };

  const result = await gate.run(subject, makeCtx({}, recording));
  assert.equal(result.status, 'PASS');
  assert.deepEqual(asked, [`${RUBRIC.endpoint}/${subject.draft_hash}`]);
});

// --- the refusal must not reproduce the thing it refused ------------------------------
//
// The gate refuses a draft precisely so that a leaked value does not travel. A refusal detail
// quoting that value verbatim sends it straight into the ledger, which is the durable,
// shareable, committed artifact of the run. The safeguard would then be the mechanism of the
// leak, which is the one thing it must never be.

test('a PII refusal names the KIND of finding, never the value', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nI also spoke with marcus.webb@othercorp.test about this already.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['PII_IN_BODY']);
  assert.doesNotMatch(result.detail, /marcus\.webb@othercorp\.test/, 'the address is not repeated');
  assert.match(result.detail, /email/i, 'but the reader is told what kind of thing was found');
});

test('a phone refusal does not repeat the number', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nYour colleague can be reached on 415-555-0132 most afternoons.' }),
    makeCtx(),
  );
  assert.doesNotMatch(result.detail, /415-555-0132/);
  assert.match(result.detail, /phone/i);
});

test('a REDACTION_INCOMPLETE refusal does not repeat the residue either', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\nForward this to ops@internal and they will route it for you.' }),
    makeCtx(),
  );
  assert.deepEqual(result.reason_codes, ['REDACTION_INCOMPLETE']);
  assert.doesNotMatch(result.detail, /ops@internal/);
  assert.match(result.detail, /email/i);
});

test('the violation report counts findings, so a reader knows the scale', async () => {
  const result = await gate.run(
    lead({ body: 'Hi Dana,\n\ncc a@one.test and b@two.test on the thread.' }),
    makeCtx(),
  );
  const pii = result.output.gate.violations.filter((v) => v.code === 'PII_IN_BODY');
  assert.equal(pii.length, 2, 'both findings are reported');
  for (const violation of pii) {
    assert.doesNotMatch(violation.detail, /one\.test|two\.test/);
  }
});

test('the draft itself still carries the text, so an operator can find and fix it', async () => {
  // The value is withheld from the RECORD, not from the operator. The draft is right there.
  const subject = lead({ body: 'Hi Dana,\n\nI spoke with marcus.webb@othercorp.test already.' });
  const result = await gate.run(subject, makeCtx());
  assert.match(result.output.draft.body, /marcus\.webb@othercorp\.test/);
});
