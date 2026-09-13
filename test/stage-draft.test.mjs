import test from 'node:test';
import assert from 'node:assert/strict';

import { draft } from '../src/stages/draft.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';

function lead(overrides = {}) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    claims: [
      { field: 'employee_count', value: 240, citation: DIRECTORY, cited: true },
      { field: 'industry', value: 'industrial robotics', citation: DIRECTORY, cited: true },
      { field: 'contact_title', value: 'VP Revenue Operations', citation: null, cited: false },
    ],
    citations: [DIRECTORY],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae', play: 'problem-first', reason: 'x' },
    ...overrides,
  };
}

function makeCtx(templates) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: {
      mode: 'fixture',
      draft: {
        maxBodyChars: 900,
        templates: templates ?? {
          'problem-first': {
            subject: 'A question about {company_name}',
            body: [
              'Hi {contact_first_name},',
              '',
              'You run revenue operations at a {claim:industry} company of about {claim:employee_count} people.',
              '',
              'Worth a short conversation?',
            ].join('\n'),
          },
        },
      },
    },
    run_id: 'run-test',
  });
}

test('draft composes the template for the play the router chose', async () => {
  const result = await draft.run(lead(), makeCtx());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.draft.template, 'problem-first');
});

test('identity placeholders resolve from the lead', async () => {
  const { output } = await draft.run(lead(), makeCtx());
  assert.match(output.draft.subject, /Acme Robotics/);
  assert.match(output.draft.body, /Hi Dana,/);
});

test('cited claims are substituted into the body', async () => {
  const { output } = await draft.run(lead(), makeCtx());
  assert.match(output.draft.body, /industrial robotics/);
  assert.match(output.draft.body, /240 people/);
});

test('the draft records which claims it used and where each came from', async () => {
  const { output } = await draft.run(lead(), makeCtx());
  assert.deepEqual(output.draft.claim_refs, [
    { field: 'employee_count', citation: DIRECTORY },
    { field: 'industry', citation: DIRECTORY },
  ]);
});

test('a template referencing an uncited claim REFUSES with UNGROUNDED_CLAIM', async () => {
  const ctx = makeCtx({
    'problem-first': { subject: 'Hello', body: 'You are {claim:contact_title}.' },
  });
  const result = await draft.run(lead(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
  assert.match(result.detail, /contact_title/);
});

test('a template referencing a claim the lead does not have REFUSES with UNGROUNDED_CLAIM', async () => {
  const ctx = makeCtx({ 'problem-first': { subject: 'Hi', body: '{claim:revenue}' } });
  const result = await draft.run(lead(), ctx);
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
  assert.match(result.detail, /revenue/);
});

test('a play with no template REFUSES with NO_TEMPLATE_FOR_PLAY rather than improvising', async () => {
  const result = await draft.run(lead({ route: { play: 'nonexistent', band: 'x', owner: 'y', reason: 'z' } }), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['NO_TEMPLATE_FOR_PLAY']);
});

test('a missing identity field REFUSES rather than addressing a blank', async () => {
  const bare = lead();
  delete bare.contact.name;
  const result = await draft.run(bare, makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNRESOLVED_IDENTITY']);
});

test('a body longer than the configured maximum REFUSES with DRAFT_TOO_LONG', async () => {
  const ctx = makeCtx({ 'problem-first': { subject: 'Hi', body: 'x'.repeat(2000) } });
  const result = await draft.run(lead(), ctx);
  assert.deepEqual(result.reason_codes, ['DRAFT_TOO_LONG']);
});

test('the composed draft leaves no placeholder behind', async () => {
  const { output } = await draft.run(lead(), makeCtx());
  assert.doesNotMatch(output.draft.body, /\{[a-z_:]+\}/);
  assert.doesNotMatch(output.draft.subject, /\{[a-z_:]+\}/);
});

test('drafting is deterministic: the same lead drafts the same bytes twice', async () => {
  const a = await draft.run(lead(), makeCtx());
  const b = await draft.run(lead(), makeCtx());
  assert.deepEqual(a.output.draft, b.output.draft);
});

test('the draft is addressed to the contact the signal identified', async () => {
  const { output } = await draft.run(lead(), makeCtx());
  assert.equal(output.draft.to, 'dana@acme.test');
});

test('draft cites its grounding as evidence on the verdict', async () => {
  const result = await draft.run(lead(), makeCtx());
  assert.deepEqual(result.evidence_refs, [DIRECTORY]);
});

// --- model mode, new in M4 -------------------------------------------------------------------
//
// M4 spec §5. `draft.mode` selects the composer: 'template' is M1's mechanical fill and stays the
// default, 'model' calls the LLM through the ctx.model seam.
//
// Every failure here is a REFUSAL WITH ITS OWN CODE and none of them falls back to a template. A
// silent fallback would be the worst failure available at this stage: it produces a plausible
// artifact nobody chose, on a path the operator believes is running a model, and the ledger would
// say PASS. The rubric's rule, one stage earlier.

function modelCtx(model, draftConfig = {}) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    model,
    config: {
      mode: 'live',
      draft: { mode: 'model', maxBodyChars: 900, templates: {}, ...draftConfig },
    },
    run_id: 'run-test',
  });
}

function respondWith(payload) {
  return async () => ({ text: typeof payload === 'string' ? payload : JSON.stringify(payload), model: 'claude-sonnet-5' });
}

const GOOD = {
  subject: 'A question about Acme Robotics',
  body: 'Hi Dana,\n\nAt around 240 people, who decides which inbound signals get a human reply?\n\nWorth a short conversation?',
  claim_refs: [{ field: 'employee_count', citation: DIRECTORY }],
};

test('model mode composes the draft from the model and binds it to a content hash', async () => {
  const result = await draft.run(lead(), modelCtx(respondWith(GOOD)));
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.draft.subject, GOOD.subject);
  assert.equal(result.output.draft.to, 'dana@acme.test', 'the address is filled in locally, never by the model');
  assert.match(result.output.draft_hash, /^draft-[0-9a-f]+$/);
});

test('the draft records that a model composed it, and which one', async () => {
  const result = await draft.run(lead(), modelCtx(respondWith(GOOD)));
  assert.equal(result.output.draft.composer, 'model');
  assert.equal(result.output.draft.model, 'claude-sonnet-5');
});

test('template mode remains the default, so an unconfigured pipeline composes exactly as before', async () => {
  const result = await draft.run(lead(), makeCtx({ 'problem-first': { subject: 'S {company_name}', body: 'B '.repeat(30) } }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.draft.composer, undefined, 'the template path is unchanged, including its output shape');
});

test('model mode with NO model seam REFUSES, because a configured model that is absent is not a template', async () => {
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'live', draft: { mode: 'model', templates: { 'problem-first': { subject: 'S', body: 'B' } } } },
    run_id: 'run-test',
  });
  const result = await draft.run(lead(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MODEL_UNAVAILABLE']);
  assert.ok(!('draft' in result.output), 'and it did not quietly compose the template that was sitting right there');
});

test('a model outage REFUSES with the transport code rather than falling back', async () => {
  const outage = async () => {
    const error = new Error('the model provider answered 503');
    error.stageCode = 'MODEL_UNAVAILABLE';
    throw error;
  };
  const result = await draft.run(lead(), modelCtx(outage));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MODEL_UNAVAILABLE']);
  assert.match(result.detail, /503/);
});

test('a model refusal REFUSES with MODEL_REFUSED, kept distinct from an outage', async () => {
  const refusing = async () => {
    const error = new Error('the model declined to write this message');
    error.stageCode = 'MODEL_REFUSED';
    throw error;
  };
  const result = await draft.run(lead(), modelCtx(refusing));
  assert.deepEqual(result.reason_codes, ['MODEL_REFUSED']);
});

test('an unparseable completion REFUSES with MODEL_UNPARSEABLE', async () => {
  const result = await draft.run(lead(), modelCtx(respondWith('Happy to help! Here is your email...')));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MODEL_UNPARSEABLE']);
});

test('a thrown error with no code still REFUSES, because an unknown failure is not a pass', async () => {
  const result = await draft.run(lead(), modelCtx(async () => { throw new TypeError('undefined is not a function'); }));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MODEL_UNAVAILABLE']);
});

test('an over-long body REFUSES on the same bound the template path uses', async () => {
  const result = await draft.run(
    lead(),
    modelCtx(respondWith({ ...GOOD, body: 'x'.repeat(2000) }), { maxBodyChars: 900 }),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['DRAFT_TOO_LONG']);
});

test("the model's claim_refs are carried through UNVERIFIED, for the gate to check", async () => {
  // The important negative. The draft stage does not validate the self-report, on purpose: the
  // gate is the single place grounding is decided, and a second, weaker check here would invite
  // somebody to trust it. A lying self-report must reach the gate intact to be refused there.
  const lying = { ...GOOD, claim_refs: [{ field: 'funding_stage', citation: 'https://invented.example.com/x' }] };
  const result = await draft.run(lead(), modelCtx(respondWith(lying)));
  assert.equal(result.status, 'PASS', 'draft does not adjudicate grounding');
  assert.deepEqual(result.output.draft.claim_refs, lying.claim_refs);
});

test('the prompt the model is handed carries only cited claims and never the address', async () => {
  let seen = null;
  await draft.run(lead(), modelCtx(async (request) => {
    seen = request;
    return { text: JSON.stringify(GOOD), model: 'claude-sonnet-5' };
  }));
  const everything = `${seen.system}\n${seen.prompt}`;
  assert.match(everything, /employee_count/);
  assert.ok(!everything.includes('contact_title'));
  assert.ok(!everything.includes('dana@acme.test'));
});

test('a lead with no cited claim still REFUSES before a model call is spent on it', async () => {
  // enrich refuses this case already, so this is a second line. It matters because a model handed
  // no claims will write something pleasant and unfounded, and paying for that is worse than
  // refusing for free.
  let called = 0;
  const result = await draft.run(
    lead({ claims: [{ field: 'contact_title', value: 'VP', citation: null, cited: false }], citations: [] }),
    modelCtx(async () => { called += 1; return { text: JSON.stringify(GOOD) }; }),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['NO_CITED_CLAIMS']);
  assert.equal(called, 0, 'nothing was spent');
});
