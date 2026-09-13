// The fail-closed LLM rubric. Pattern adapted from gtm-agent-evals; no code vendored.
//
// The pattern's one rule: SILENCE IS NOT A PASS. A judge that did not answer, answered about
// something else, or answered in a shape the caller cannot read has not approved anything.
// Every one of those is a refusal, and each gets its own reason code so a reader can tell an
// outage apart from a rejection.
//
// In fixture mode the judge is a recorded response reached through ctx.fetch, which is what
// keeps the whole thing keyless and deterministic. The live-key path is M4; what M2 owes is
// the seam, and the seam is that the rubric's only contact with the outside world is ctx.fetch,
// exactly like enrichment's.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRubric, RUBRIC_ENDPOINT } from '../src/rubric.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DRAFT_HASH = 'draft-0123456789abcdef';
const CONFIG = {
  endpoint: RUBRIC_ENDPOINT,
  requiredCriteria: ['claim_grounding', 'audience_fit', 'tone'],
};

function judgment(overrides = {}) {
  return {
    draft_hash: DRAFT_HASH,
    verdict: 'PASS',
    criteria: [
      { name: 'claim_grounding', verdict: 'PASS', note: 'every assertion traces to a citation' },
      { name: 'audience_fit', verdict: 'PASS', note: 'addressed to the right operator' },
      { name: 'tone', verdict: 'PASS', note: 'not a pitch' },
    ],
    ...overrides,
  };
}

function ctxWith(recordings) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher(recordings),
    config: { mode: 'fixture' },
    run_id: 'run-test',
  });
}

function recordedAs(body, status = 200, hash = DRAFT_HASH) {
  return { [`${RUBRIC_ENDPOINT}/${hash}`]: { status, body } };
}

// --- the passing path -------------------------------------------------------------------

test('a clean judgment on this exact draft passes', async () => {
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(judgment())), CONFIG);
  assert.equal(result.ok, true);
});

test('the request is addressed by draft hash, so a verdict binds to the content it judged', async () => {
  const asked = [];
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async (url) => {
      asked.push(url);
      return { status: 200, body: judgment() };
    },
    config: { mode: 'fixture' },
    run_id: 'run-test',
  });
  await evaluateRubric(DRAFT_HASH, ctx, CONFIG);
  assert.deepEqual(asked, [`${RUBRIC_ENDPOINT}/${DRAFT_HASH}`]);
});

test('the rubric reports the criteria it saw, so a pass is inspectable too', async () => {
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(judgment())), CONFIG);
  assert.deepEqual(result.criteria.map((c) => c.name).sort(), [
    'audience_fit',
    'claim_grounding',
    'tone',
  ]);
});

// --- silence is not a pass ----------------------------------------------------------------

test('no recording at all REFUSES with RUBRIC_UNAVAILABLE, it does not pass', async () => {
  const result = await evaluateRubric(DRAFT_HASH, ctxWith({}), CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_UNAVAILABLE');
});

test('a judge that errors REFUSES rather than being treated as silent assent', async () => {
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async () => {
      throw new Error('connection reset');
    },
    config: { mode: 'fixture' },
    run_id: 'run-test',
  });
  const result = await evaluateRubric(DRAFT_HASH, ctx, CONFIG);
  assert.equal(result.code, 'RUBRIC_UNAVAILABLE');
  assert.match(result.detail, /connection reset/);
});

test('a non-200 judge response REFUSES', async () => {
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(judgment(), 503)), CONFIG);
  assert.equal(result.code, 'RUBRIC_UNAVAILABLE');
});

// --- a verdict about a different draft is not a verdict about this one --------------------

test('a judgment carrying another draft hash REFUSES with RUBRIC_MISMATCH', async () => {
  // The same lesson as the approval hash, one layer down. A recorded verdict that was not
  // made about this exact draft is a verdict about something else.
  const result = await evaluateRubric(
    DRAFT_HASH,
    ctxWith(recordedAs(judgment({ draft_hash: 'draft-ffffffffffffffff' }))),
    CONFIG,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_MISMATCH');
});

test('a judgment with no draft hash at all REFUSES, rather than being assumed to be ours', async () => {
  const { draft_hash, ...anonymous } = judgment();
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(anonymous)), CONFIG);
  assert.equal(result.code, 'RUBRIC_MISMATCH');
});

// --- a shape the caller cannot read is not a pass ------------------------------------------

test('a missing verdict REFUSES with RUBRIC_MALFORMED', async () => {
  const { verdict, ...noVerdict } = judgment();
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(noVerdict)), CONFIG);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

test('an unrecognised verdict REFUSES rather than being interpreted', async () => {
  const result = await evaluateRubric(
    DRAFT_HASH,
    ctxWith(recordedAs(judgment({ verdict: 'PROBABLY_FINE' }))),
    CONFIG,
  );
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

test('criteria that are not a list REFUSE', async () => {
  const result = await evaluateRubric(
    DRAFT_HASH,
    ctxWith(recordedAs(judgment({ criteria: 'all good' }))),
    CONFIG,
  );
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

test('a MISSING required criterion REFUSES, because an unanswered question is not a pass', async () => {
  // The heart of the pattern. The judge returned an overall PASS while simply not addressing
  // claim grounding. Reading that as approval is exactly the failure mode being designed out.
  const partial = judgment({
    criteria: judgment().criteria.filter((c) => c.name !== 'claim_grounding'),
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(partial)), CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
  assert.match(result.detail, /claim_grounding/);
});

test('an unrecognised criterion verdict REFUSES', async () => {
  const odd = judgment({
    criteria: judgment().criteria.map((c) =>
      c.name === 'tone' ? { ...c, verdict: 'MEH' } : c,
    ),
  });
  assert.equal((await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(odd)), CONFIG)).code, 'RUBRIC_MALFORMED');
});

// --- an actual rejection ------------------------------------------------------------------

test('an overall FAIL verdict REFUSES with RUBRIC_FAILED', async () => {
  const result = await evaluateRubric(
    DRAFT_HASH,
    ctxWith(recordedAs(judgment({ verdict: 'FAIL' }))),
    CONFIG,
  );
  assert.equal(result.code, 'RUBRIC_FAILED');
});

test('a single failing criterion REFUSES even when the overall verdict says PASS', async () => {
  // The judge contradicting itself resolves to the safe reading, not the permissive one.
  const conflicted = judgment({
    criteria: judgment().criteria.map((c) =>
      c.name === 'audience_fit' ? { ...c, verdict: 'FAIL', note: 'wrong operator entirely' } : c,
    ),
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(conflicted)), CONFIG);
  assert.equal(result.code, 'RUBRIC_FAILED');
  assert.match(result.detail, /audience_fit/);
  assert.match(result.detail, /wrong operator entirely/);
});

// --- determinism and configuration --------------------------------------------------------

test('the rubric is deterministic: the same recording judges the same way twice', async () => {
  const recordings = recordedAs(judgment());
  assert.deepEqual(
    await evaluateRubric(DRAFT_HASH, ctxWith(recordings), CONFIG),
    await evaluateRubric(DRAFT_HASH, ctxWith(recordings), CONFIG),
  );
});

test('a missing rubric config REFUSES rather than skipping the rubric', async () => {
  // A gate part that disappears when its config is absent is not a gate part.
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(judgment())), undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

test('an empty requiredCriteria list REFUSES, because a rubric asking nothing certifies nothing', async () => {
  const result = await evaluateRubric(
    DRAFT_HASH,
    ctxWith(recordedAs(judgment())),
    { endpoint: RUBRIC_ENDPOINT, requiredCriteria: [] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

// --- a FAIL is a FAIL, whether or not the config asked for that criterion -------------------
//
// The ship-check found the code and the spec disagreeing here. docs/M2-SPEC.md promised "any
// single criterion FAIL" refuses; the code only inspected the REQUIRED ones, so a judge
// volunteering a failure outside the configured list was ignored and the draft passed.
//
// Reconciled toward the code matching the spec, because the alternative inverts this module's
// one rule. "Silence is not a pass" exists so an unanswered question cannot be read as
// approval. Dropping a volunteered FAIL is the same mistake pointed the other way: treating
// something the judge actually SAID as if it had not been said. A judge that spots a problem
// nobody thought to ask about is the most valuable thing a judge does.

test('a FAIL on a criterion outside requiredCriteria still REFUSES', async () => {
  const volunteered = judgment({
    criteria: [
      ...judgment().criteria,
      { name: 'legal_risk', verdict: 'FAIL', note: 'names a competitor in a defamatory way' },
    ],
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(volunteered)), CONFIG);
  assert.equal(result.ok, false, 'a volunteered failure is not discarded');
  assert.equal(result.code, 'RUBRIC_FAILED');
});

test('the refusal names the volunteered criterion and its note', async () => {
  const volunteered = judgment({
    criteria: [
      ...judgment().criteria,
      { name: 'legal_risk', verdict: 'FAIL', note: 'names a competitor in a defamatory way' },
    ],
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(volunteered)), CONFIG);
  assert.match(result.detail, /legal_risk/);
  assert.match(result.detail, /defamatory/);
});

test('an extra criterion that PASSES does not refuse, and is reported', async () => {
  // The rule is "any FAIL refuses", not "any extra criterion is suspicious".
  const extra = judgment({
    criteria: [...judgment().criteria, { name: 'legal_risk', verdict: 'PASS', note: 'clean' }],
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(extra)), CONFIG);
  assert.equal(result.ok, true);
  assert.ok(
    result.criteria.some((c) => c.name === 'legal_risk'),
    'everything the judge answered is reported, not just what was asked',
  );
});

test('a required criterion is still mandatory; volunteering others does not substitute', async () => {
  const wrongQuestions = judgment({
    criteria: [
      { name: 'claim_grounding', verdict: 'PASS', note: 'ok' },
      { name: 'audience_fit', verdict: 'PASS', note: 'ok' },
      { name: 'legal_risk', verdict: 'PASS', note: 'ok' },
    ],
  });
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(wrongQuestions)), CONFIG);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
  assert.match(result.detail, /tone/, 'the unanswered required criterion is named');
});

// --- model mode, new in M4 -------------------------------------------------------------------
//
// M4 spec §5. `rubric.mode` is 'recorded' (the default, everything above) or 'model'.
//
// The VALIDATION is shared, deliberately and completely. Every fail-closed rule the recorded path
// enforces — an unanswered required criterion is not a pass, a volunteered FAIL counts, a
// self-contradicting judge resolves to the safe reading — applies identically to a live judge,
// because those rules are about what a judgment MEANS rather than about where it arrived from.
// Model mode changes the acquisition and nothing else, which is why it is a branch above the
// validator instead of a second validator.

import { buildRubricPrompt } from '../src/rubric.mjs';

const MODEL_CONFIG = { ...CONFIG, mode: 'model' };
const DRAFT = {
  to: 'dana@acme.example.com',
  subject: 'A question about Acme Robotics',
  body: 'Hi Dana,\n\nAt around 240 people, who owns the handoff?\n\nWorth a short call?',
  claim_refs: [{ field: 'employee_count', citation: 'https://directory.example.com/c' }],
};
const CLAIMS = [
  { field: 'employee_count', value: 240, citation: 'https://directory.example.com/c', cited: true },
];

function modelCtx(model) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    model,
    config: { mode: 'live' },
    run_id: 'run-test',
  });
}

function judgingModel(payload) {
  return async () => ({ text: typeof payload === 'string' ? payload : JSON.stringify(payload), model: 'claude-sonnet-5' });
}

const LIVE_VERDICT = {
  verdict: 'PASS',
  criteria: [
    { name: 'claim_grounding', verdict: 'PASS', note: 'traces' },
    { name: 'audience_fit', verdict: 'PASS', note: 'right operator' },
    { name: 'tone', verdict: 'PASS', note: 'not a pitch' },
  ],
};

test('a live judge that certifies every required criterion passes', async () => {
  const result = await evaluateRubric(DRAFT_HASH, modelCtx(judgingModel(LIVE_VERDICT)), MODEL_CONFIG, {
    draft: DRAFT,
    claims: CLAIMS,
  });
  assert.equal(result.ok, true);
});

test('the judgment is bound to THIS draft by us, never by the judge saying so', async () => {
  // The recorded path checks the hash the recording claims, because a recording can outlive the
  // draft it judged. A live completion cannot: it was generated for the request this run just
  // made. So the binding is asserted locally rather than asked for, which removes a field the
  // model could get wrong and turn into a spurious RUBRIC_MISMATCH.
  const wrongHash = { ...LIVE_VERDICT, draft_hash: 'draft-something-else-entirely' };
  const result = await evaluateRubric(DRAFT_HASH, modelCtx(judgingModel(wrongHash)), MODEL_CONFIG, {
    draft: DRAFT,
    claims: CLAIMS,
  });
  assert.equal(result.ok, true, 'a hash the judge volunteered is not what binds the verdict');
});

test('the draft under judgment is fenced as untrusted, because it may carry what a source put there', async () => {
  let seen = null;
  await evaluateRubric(DRAFT_HASH, modelCtx(async (request) => {
    seen = request;
    return { text: JSON.stringify(LIVE_VERDICT) };
  }), MODEL_CONFIG, { draft: DRAFT, claims: CLAIMS });

  assert.match(seen.prompt, /untrusted/i);
  assert.match(seen.prompt, /A question about Acme Robotics/, 'the judge does see the draft it is judging');
  assert.match(seen.system, /claim_grounding/, 'and it is told which questions it must answer');
});

test('every required criterion is named in the prompt, so an unanswered one is the judge ignoring a question', async () => {
  const built = buildRubricPrompt({ draftHash: DRAFT_HASH, draft: DRAFT, claims: CLAIMS, required: MODEL_CONFIG.requiredCriteria });
  for (const name of MODEL_CONFIG.requiredCriteria) assert.match(built.system, new RegExp(name));
});

test('the cited claims go with the draft, since claim_grounding cannot be judged without them', async () => {
  const built = buildRubricPrompt({ draftHash: DRAFT_HASH, draft: DRAFT, claims: CLAIMS, required: MODEL_CONFIG.requiredCriteria });
  assert.match(built.prompt, /employee_count/);
  assert.match(built.prompt, /240/);
});

test('a judge outage REFUSES with RUBRIC_UNAVAILABLE, because silence is not a pass', async () => {
  const outage = async () => {
    const error = new Error('the model provider answered 503');
    error.stageCode = 'MODEL_UNAVAILABLE';
    throw error;
  };
  const result = await evaluateRubric(DRAFT_HASH, modelCtx(outage), MODEL_CONFIG, { draft: DRAFT, claims: CLAIMS });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_UNAVAILABLE');
});

test('model mode with NO model seam REFUSES rather than certifying nothing', async () => {
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'live' },
    run_id: 'run-test',
  });
  const result = await evaluateRubric(DRAFT_HASH, ctx, MODEL_CONFIG, { draft: DRAFT, claims: CLAIMS });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_UNAVAILABLE');
});

test('a completion that is not a judgment REFUSES with RUBRIC_MALFORMED', async () => {
  const result = await evaluateRubric(DRAFT_HASH, modelCtx(judgingModel('I think it looks good!')), MODEL_CONFIG, {
    draft: DRAFT,
    claims: CLAIMS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUBRIC_MALFORMED');
});

test('EVERY fail-closed rule of the recorded path applies to a live judge unchanged', async () => {
  // The validator is shared, and this is the test that says so out loud. If these ever diverge,
  // the live path becomes the weaker one, which is precisely the direction a gate must not drift.
  const unanswered = { verdict: 'PASS', criteria: [{ name: 'tone', verdict: 'PASS' }] };
  const missing = await evaluateRubric(DRAFT_HASH, modelCtx(judgingModel(unanswered)), MODEL_CONFIG, {
    draft: DRAFT,
    claims: CLAIMS,
  });
  assert.equal(missing.code, 'RUBRIC_MALFORMED', 'an unanswered required criterion is not a pass');

  const volunteered = {
    verdict: 'PASS',
    criteria: [
      ...LIVE_VERDICT.criteria,
      { name: 'something_nobody_asked', verdict: 'FAIL', note: 'the claim is stale' },
    ],
  };
  const failed = await evaluateRubric(DRAFT_HASH, modelCtx(judgingModel(volunteered)), MODEL_CONFIG, {
    draft: DRAFT,
    claims: CLAIMS,
  });
  assert.equal(failed.code, 'RUBRIC_FAILED', 'a volunteered FAIL still counts');
});

test('recorded mode is untouched and stays the default when no mode is named', async () => {
  const result = await evaluateRubric(DRAFT_HASH, ctxWith(recordedAs(judgment())), CONFIG);
  assert.equal(result.ok, true);
});
