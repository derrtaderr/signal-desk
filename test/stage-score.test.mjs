import test from 'node:test';
import assert from 'node:assert/strict';

import { score } from '../src/stages/score.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';

function lead(claims) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    intent: { page: '/pricing', visits: 4 },
    citations: [DIRECTORY],
    claims: claims ?? [
      { field: 'employee_count', value: 240, citation: DIRECTORY, cited: true },
      { field: 'contact_title', value: 'VP Revenue Operations', citation: null, cited: false },
      { field: 'intent_visits', value: 4, citation: null, cited: false },
      { field: 'intent_page', value: '/pricing', citation: null, cited: false },
    ],
  };
}

function makeCtx(config = {}) {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: {
      mode: 'fixture',
      score: {
        seniorTitles: ['vp', 'head of', 'director', 'chief'],
        highIntentPages: ['/pricing', '/demo'],
        employeeBand: { min: 10, max: 500 },
        ...config,
      },
    },
    run_id: 'run-test',
  });
}

test('the score is the sum of its named factors, with nothing left over', async () => {
  const { output } = await score.run(lead(), makeCtx());
  const summed = output.score.factors.reduce((total, f) => total + f.points, 0);
  assert.equal(output.score.total, summed);
});

test('every factor is named, carries its points, and says why it fired', async () => {
  const { output } = await score.run(lead(), makeCtx());
  for (const factor of output.score.factors) {
    assert.equal(typeof factor.name, 'string');
    assert.equal(typeof factor.points, 'number');
    assert.equal(typeof factor.reason, 'string');
    assert.ok(factor.reason.length > 0, `factor ${factor.name} explains itself`);
    assert.ok(Array.isArray(factor.evidence_refs));
  }
});

test('a factor drawn from a cited claim carries that citation as its evidence', async () => {
  const { output } = await score.run(lead(), makeCtx());
  const band = output.score.factors.find((f) => f.name === 'employee_band');
  assert.deepEqual(band.evidence_refs, [DIRECTORY]);
});

test('a factor drawn from an uncited claim carries no external evidence and says so', async () => {
  const { output } = await score.run(lead(), makeCtx());
  const seniority = output.score.factors.find((f) => f.name === 'title_seniority');
  assert.deepEqual(seniority.evidence_refs, []);
  assert.equal(seniority.cited, false);
});

test('a senior title scores above a junior one, holding everything else equal', async () => {
  const junior = lead().claims.map((c) =>
    c.field === 'contact_title' ? { ...c, value: 'Sales Development Intern' } : c,
  );
  const a = await score.run(lead(), makeCtx());
  const b = await score.run(lead(junior), makeCtx());
  assert.ok(a.output.score.total > b.output.score.total);
});

test('a company outside the employee band scores lower than one inside it', async () => {
  const huge = lead().claims.map((c) =>
    c.field === 'employee_count' ? { ...c, value: 90000 } : c,
  );
  const a = await score.run(lead(), makeCtx());
  const b = await score.run(lead(huge), makeCtx());
  assert.ok(a.output.score.total > b.output.score.total);
});

test('a high-intent page scores above an incidental one', async () => {
  const blog = lead().claims.map((c) =>
    c.field === 'intent_page' ? { ...c, value: '/blog/hello' } : c,
  );
  const a = await score.run(lead(), makeCtx());
  const b = await score.run(lead(blog), makeCtx());
  assert.ok(a.output.score.total > b.output.score.total);
});

test('scoring is deterministic: the same lead scores the same twice', async () => {
  const a = await score.run(lead(), makeCtx());
  const b = await score.run(lead(), makeCtx());
  assert.deepEqual(a.output.score, b.output.score);
});

test('factors come back in a stable sorted order', async () => {
  const { output } = await score.run(lead(), makeCtx());
  const names = output.score.factors.map((f) => f.name);
  assert.deepEqual(names, [...names].sort());
});

test('a lead with no usable claims REFUSES with UNSCOREABLE rather than scoring zero', async () => {
  const result = await score.run(lead([]), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNSCOREABLE']);
});

test('score passes the lead through and adds the score beside it', async () => {
  const { output } = await score.run(lead(), makeCtx());
  assert.equal(output.lead_id, 'lead-abc123456789');
  assert.deepEqual(output.citations, [DIRECTORY]);
});
