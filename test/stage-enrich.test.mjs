import test from 'node:test';
import assert from 'node:assert/strict';

import { enrich } from '../src/stages/enrich.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';
const NEWSROOM = 'https://newsroom.test/acme.test';
const PERSON = 'https://people.test/dana@acme.test';

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

function makeCtx(recordings, enrichConfig = {}) {
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
        ...enrichConfig,
      },
    },
    run_id: 'run-test',
  });
}

// The identity-source wiring the wrong-person fixture exercises. Kept out of the default
// config above so the tests that predate it keep asserting what they were written to assert.
const withIdentity = { identitySource: 'https://people.test/{email}' };

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

// --- identity verification, the wrong-person catch -----------------------------------
//
// The signal names a contact. Vendor-side identity resolution is probabilistic, so the human
// the signal names is not reliably the human behind the visit. These tests are the mechanism
// the 9007 fixture exercises end to end. See docs/M3-SPEC.md part 1 (a).

function personRecord(overrides = {}) {
  return {
    status: 200,
    body: {
      identity: {
        name: 'Dana Ruiz',
        email: 'dana@acme.test',
        company_domain: 'acme.test',
        title: 'VP Revenue Operations',
        ...overrides,
      },
    },
  };
}

test('an identity source that confirms the contact records IDENTITY_CONFIRMED and proceeds', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: personRecord() }, withIdentity),
  );
  assert.equal(result.status, 'PASS');
  const confirmation = result.entries.find((e) => e.reason_codes?.includes('IDENTITY_CONFIRMED'));
  assert.ok(confirmation, 'the confirmation is on the record, not merely implied by the absence of a refusal');
  assert.deepEqual(confirmation.evidence_refs, [PERSON]);
});

test('an identity source placing the contact at another company REFUSES with IDENTITY_CONTRADICTED', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: personRecord({ company_domain: 'harborline.test' }) }, withIdentity),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['IDENTITY_CONTRADICTED']);
  assert.match(result.detail, /harborline\.test/);
});

test('an identity source naming a different person REFUSES with IDENTITY_CONTRADICTED', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: personRecord({ name: 'Jordan Blake' }) }, withIdentity),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['IDENTITY_CONTRADICTED']);
  assert.match(result.detail, /Jordan Blake/);
});

test('an identity source answering about a different address REFUSES with IDENTITY_CONTRADICTED', async () => {
  // The URL was keyed on the contact's own address, so a record naming someone else's is the
  // source answering a question nobody asked.
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: personRecord({ email: 'someone.else@acme.test' }) }, withIdentity),
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['IDENTITY_CONTRADICTED']);
});

test('a contradicted identity refuses before any claim source is fetched', async () => {
  // The whole reason identity runs first. A person the evidence contradicts should not consume
  // the claim fetches, and in live mode should not consume the spend either.
  const fetched = [];
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async (url) => {
      fetched.push(url);
      if (url === PERSON) return personRecord({ company_domain: 'harborline.test' });
      return { status: 200, body: { claims: {} } };
    },
    config: {
      mode: 'fixture',
      enrich: {
        sources: ['https://directory.test/company/{domain}', 'https://newsroom.test/{domain}'],
        ...withIdentity,
      },
    },
    run_id: 'run-test',
  });

  const result = await enrich.run(lead(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(fetched, [PERSON], 'the identity source was the only thing fetched');
});

test('identity comparison ignores case and surrounding whitespace, not substance', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx(
      { ...recordings, [PERSON]: personRecord({ name: '  dana   RUIZ ', company_domain: 'ACME.test' }) },
      withIdentity,
    ),
  );
  assert.equal(result.status, 'PASS');
});

test('an identity source with no recording records IDENTITY_UNVERIFIED and the lead proceeds', async () => {
  // Not a fail-open. Enrich is not a gate, and "no identity evidence" is the state every lead
  // was in before this rule existed. What fail-closed requires is that absence never reads as
  // CONFIRMATION, and the ledger says so out loud rather than staying silent.
  const result = await enrich.run(lead(), makeCtx(recordings, withIdentity));
  assert.equal(result.status, 'PASS');
  const entry = result.entries.find((e) => e.reason_codes?.includes('IDENTITY_UNVERIFIED'));
  assert.ok(entry, 'the gap is named in the trail');
  assert.ok(
    !result.entries.some((e) => e.reason_codes?.includes('IDENTITY_CONFIRMED')),
    'an unverified identity is never reported as a confirmed one',
  );
});

test('an identity source answering non-200 records IDENTITY_UNVERIFIED rather than confirming', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: { status: 503, body: {} } }, withIdentity),
  );
  assert.equal(result.status, 'PASS');
  assert.ok(result.entries.some((e) => e.reason_codes?.includes('IDENTITY_UNVERIFIED')));
});

test('an identity response carrying no identity block records IDENTITY_UNVERIFIED', async () => {
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: { status: 200, body: {} } }, withIdentity),
  );
  assert.equal(result.status, 'PASS');
  assert.ok(result.entries.some((e) => e.reason_codes?.includes('IDENTITY_UNVERIFIED')));
});

test('with no identity source configured, enrich makes no identity claim either way', async () => {
  const result = await enrich.run(lead(), makeCtx(recordings));
  assert.equal(result.status, 'PASS');
  const identityEntries = result.entries.filter((e) =>
    (e.reason_codes ?? []).some((code) => code.startsWith('IDENTITY_')),
  );
  assert.deepEqual(identityEntries, [], 'a pipeline not doing identity verification does not report one');
});

test('the identity source contributes no claim and no citation, only a verification', async () => {
  // It answers "is this the right person", not "what is true about this company". Letting it
  // count as a citation would make a lead with zero usable claims look evidenced.
  const result = await enrich.run(
    lead(),
    makeCtx({ ...recordings, [PERSON]: personRecord() }, withIdentity),
  );
  assert.deepEqual(result.output.citations.sort(), [DIRECTORY, NEWSROOM].sort());
  assert.ok(!result.output.claims.some((c) => c.citation === PERSON));
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
