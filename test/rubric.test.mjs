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
