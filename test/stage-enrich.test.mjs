import test from 'node:test';
import assert from 'node:assert/strict';

import { enrich } from '../src/stages/enrich.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';
const NEWSROOM = 'https://newsroom.test/acme.test';

function lead(overrides = {}) {
  return {
    lead_id: 'lead-abc123456789',
    signal_id: 'sig-1',
    source: 'rb2b',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    intent: { page: '/pricing', visits: 4 },
    ...overrides,
  };
}

function makeCtx(recordings) {
  const ledger = new Ledger();
  return createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher(recordings),
    config: {
      mode: 'fixture',
      enrich: {
        sources: [
          'https://directory.test/company/{domain}',
          'https://newsroom.test/{domain}',
        ],
      },
    },
    run_id: 'run-test',
  });
}

const recordings = {
  [DIRECTORY]: {
    status: 200,
    body: { claims: { employee_count: 240, industry: 'industrial robotics' } },
  },
  [NEWSROOM]: { status: 200, body: { claims: { funding_stage: 'series B' } } },
};

test('enrich fetches every configured source with the domain substituted in', async () => {
  const result = await enrich.run(lead(), makeCtx(recordings));
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.output.citations.sort(), [DIRECTORY, NEWSROOM].sort());
});

test('every fetched claim binds to the citation it came from', async () => {
  const { output } = await enrich.run(lead(), makeCtx(recordings));
  const byField = Object.fromEntries(output.claims.map((c) => [c.field, c]));
  assert.equal(byField.employee_count.value, 240);
  assert.equal(byField.employee_count.citation, DIRECTORY);
  assert.equal(byField.employee_count.cited, true);
  assert.equal(byField.funding_stage.citation, NEWSROOM);
});

test('claims carried in by the signal are marked uncited, because nothing fetched them', async () => {
  const { output } = await enrich.run(lead(), makeCtx(recordings));
  const title = output.claims.find((c) => c.field === 'contact_title');
  assert.equal(title.value, 'VP Revenue Operations');
  assert.equal(title.cited, false);
  assert.equal(title.citation, null);
});

test('claims come back in a stable sorted order, so the ledger bytes do not depend on fetch order', async () => {
  const a = await enrich.run(lead(), makeCtx(recordings));
  const b = await enrich.run(lead(), makeCtx(recordings));
  assert.deepEqual(
    a.output.claims.map((c) => c.field),
    b.output.claims.map((c) => c.field),
  );
  const fields = a.output.claims.map((c) => c.field);
  assert.deepEqual(fields, [...fields].sort());
});

test('a source with no recording is skipped rather than faked, and the miss is recorded', async () => {
  const result = await enrich.run(lead(), makeCtx({ [DIRECTORY]: recordings[DIRECTORY] }));
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.output.citations, [DIRECTORY]);
  const miss = result.entries.find((e) => e.reason_codes?.includes('SOURCE_UNAVAILABLE'));
  assert.ok(miss, 'the unavailable source leaves a ledger entry');
  assert.match(miss.detail, /newsroom\.test/);
});

test('a lead where every source misses REFUSES with NO_CITED_CLAIMS', async () => {
  const result = await enrich.run(lead(), makeCtx({}));
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['NO_CITED_CLAIMS']);
});

test('a non-200 response contributes no claims and counts as unavailable', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ [DIRECTORY]: { status: 404, body: {} }, [NEWSROOM]: recordings[NEWSROOM] }),
  );
  assert.deepEqual(result.output.citations, [NEWSROOM]);
});

test('enrich reports the citations it used as evidence on its verdict', async () => {
  const result = await enrich.run(lead(), makeCtx(recordings));
  assert.deepEqual(result.evidence_refs.sort(), [DIRECTORY, NEWSROOM].sort());
});

test('enrich passes the lead through untouched alongside the claims it added', async () => {
  const { output } = await enrich.run(lead(), makeCtx(recordings));
  assert.equal(output.lead_id, 'lead-abc123456789');
  assert.equal(output.company.domain, 'acme.test');
  assert.equal(output.contact.email, 'dana@acme.test');
});

test('enrich never reaches the network directly; it only uses the injected fetcher', async () => {
  let called = 0;
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async (url) => {
      called += 1;
      return recordings[url] ?? { status: 404, body: {} };
    },
    config: { mode: 'fixture', enrich: { sources: ['https://directory.test/company/{domain}'] } },
    run_id: 'run-test',
  });
  await enrich.run(lead(), ctx);
  assert.equal(called, 1);
});
