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
