// Test family 3 of 4 — adversarial.
//
// M1 requires two hostile fixtures to REFUSE with the expected reason codes: the malformed
// webhook and the duplicate signal. The rest of the design's hostile suite (wrong-person
// match, decayed enrichment, prompt injection, PII mid-enrichment, hallucination bait) is
// M3 and is deliberately not here.
//
// Each catch is asserted three ways: the lead is refused, the reason code is the expected
// one, and the ledger carries a trail a human can read. A refusal with no trail is not an
// inspectable system.

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeFixtureRun, loadFixtures } from '../src/runner.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { pipeline, defaultConfig, FIXTURE_SECRET } from '../src/config.mjs';
import { signPayload } from '../src/stages/ingest.mjs';

const run = await executeFixtureRun();

function entriesFor(leadId) {
  return run.ledger.entries().filter((e) => e.lead_id === leadId);
}

// --- hostile fixture 1: the malformed webhook ---------------------------------------

test('the malformed-webhook fixture ships in the corpus', () => {
  const { signals } = loadFixtures();
  const malformed = signals.find((s) => s.id === 'sig-9001');
  assert.ok(malformed, 'fixtures/signals/9001-malformed-webhook.json is loaded');
  assert.equal(malformed.payload.company.domain, undefined, 'it really is malformed');
});

test('the malformed webhook is REFUSED', () => {
  const lead = run.report.leads.find((l) => l.lead_id === 'sig-9001');
  assert.equal(lead.final_status, 'REFUSE');
});

test('the malformed webhook refuses with MALFORMED_PAYLOAD', () => {
  const lead = run.report.leads.find((l) => l.lead_id === 'sig-9001');
  assert.deepEqual(lead.reason_codes, ['MALFORMED_PAYLOAD']);
});

test('the malformed webhook is caught at ingest, before anything acts on it', () => {
  const lead = run.report.leads.find((l) => l.lead_id === 'sig-9001');
  assert.equal(lead.final_stage, 'ingest');
  const stages = entriesFor('sig-9001').map((e) => e.stage);
  assert.deepEqual(stages, ['ingest'], 'no later stage ran for it');
});

test('the malformed webhook leaves a ledger trail naming the missing field', () => {
  const [entry] = entriesFor('sig-9001');
  assert.equal(entry.verdict, 'REFUSE');
  assert.deepEqual(entry.reason_codes, ['MALFORMED_PAYLOAD']);
  assert.match(entry.detail, /company\.domain/);
});

// --- hostile fixture 2: the duplicate signal ----------------------------------------

test('the duplicate-signal fixture ships in the corpus and is otherwise valid', () => {
  const { signals } = loadFixtures();
  const withId = signals.filter((s) => s.id === 'sig-1001');
  assert.equal(withId.length, 2, 'two signals share one id');
  for (const signal of withId) {
    assert.equal(
      signal.signature,
      signPayload(FIXTURE_SECRET, signal.payload),
      'the replay is correctly signed, so only idempotency can catch it',
    );
  }
});

test('the duplicate signal is REFUSED with DUPLICATE_SIGNAL', () => {
  const lead = run.report.leads.find(
    (l) => l.lead_id === 'sig-1001' && l.final_status === 'REFUSE',
  );
  assert.ok(lead, 'the replayed signal was refused');
  assert.deepEqual(lead.reason_codes, ['DUPLICATE_SIGNAL']);
});

test('the original signal still succeeded; the duplicate did not poison it', () => {
  // A passing ingest entry files under the canonical lead id, so the signal is identified
  // by its evidence ref rather than by the entry's lead_id.
  const accepted = run.ledger
    .entries()
    .filter(
      (e) =>
        e.stage === 'ingest' &&
        e.verdict === 'PASS' &&
        e.evidence_refs.includes('signal:sig-1001'),
    );
  assert.equal(accepted.length, 1, 'exactly one of the pair was accepted');
});

test('the duplicate is caught at ingest, so the motion is never doubled', () => {
  const refusals = run.ledger
    .entries()
    .filter((e) => e.lead_id === 'sig-1001' && e.verdict === 'REFUSE');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].stage, 'ingest');
});

test('the duplicate leaves a ledger trail explaining why it was refused', () => {
  const [refusal] = run.ledger
    .entries()
    .filter((e) => e.lead_id === 'sig-1001' && e.verdict === 'REFUSE');
  assert.match(refusal.detail, /already been accepted/);
});

test('exactly one draft was produced for the replayed pair, not two', () => {
  const acmeLeadId = run.report.leads.find((l) => l.final_stage === 'handoff')?.lead_id;
  const drafts = run.ledger
    .entries()
    .filter((e) => e.stage === 'draft' && e.lead_id === acmeLeadId && e.verdict === 'PASS');
  assert.equal(drafts.length, 1);
});

// --- the refusals are visible in the run's own report --------------------------------

test('every refusal in the run names a reason code; none is unexplained', () => {
  for (const entry of run.ledger.entries().filter((e) => e.verdict === 'REFUSE')) {
    assert.ok(entry.reason_codes.length > 0, `the ${entry.stage} refusal names a reason`);
  }
});

test('no lead reaches handoff without passing the gate first', () => {
  for (const lead of run.report.leads.filter((l) => l.final_stage === 'handoff')) {
    const stages = entriesFor(lead.lead_id).map((e) => e.stage);
    assert.ok(stages.indexOf('gate') < stages.indexOf('handoff'));
    const gateEntry = entriesFor(lead.lead_id).find((e) => e.stage === 'gate');
    assert.equal(gateEntry.verdict, 'PASS');
  }
});

// --- a hostile input the gate must catch, built here rather than shipped as a fixture --

test('a draft asserting a claim no source backs is refused by the gate', async () => {
  // Same pipeline, same config, one poisoned template. The gate is the last thing standing
  // between an ungrounded assertion and a handoff, so it is worth proving directly.
  const fixtures = loadFixtures();
  const poisoned = {
    ...defaultConfig,
    queue: { ...defaultConfig.queue, approvals: fixtures.approvals },
    draft: {
      ...defaultConfig.draft,
      templates: {
        ...defaultConfig.draft.templates,
        'executive-intro': {
          subject: 'About {company_name}',
          body: 'Hi {contact_first_name},\n\nYour Series C raise last month suggests you are scaling the revenue team quickly, which is usually when this breaks.',
        },
      },
    },
  };

  const ledger = new Ledger();
  const ctx = createContext({
    ledger,
    clock: fixtureClock(defaultConfig.clock),
    fetch: recordedFetcher(fixtures.recordings),
    config: poisoned,
    run_id: 'run-adversarial',
  });
  const report = await runPipeline({ stages: pipeline, signals: fixtures.signals, ctx, ledger });

  // The body asserts a Series C raise that no cited claim supports. It is free prose rather
  // than a {claim:} placeholder, so it leaves no claim_ref for the structured grounding rule
  // to check, and M1 let it through to handoff.
  //
  // M2's prose_grounding rule closes it. The lead is refused at the gate and nothing reaches
  // handoff.
  assert.deepEqual(
    report.leads.filter((l) => l.final_stage === 'handoff'),
    [],
    'no lead reaches handoff; the ungrounded assertion is caught at the gate',
  );

  // Two, not one. The poisoned template is 'executive-intro', and both leads in the priority
  // band are routed to that play, so both receive the Series C assertion and both are caught.
  const refused = report.leads.filter((l) => l.reason_codes.includes('UNGROUNDED_PROSE_CLAIM'));
  assert.equal(refused.length, 2, 'every lead routed to the poisoned play was refused');
  for (const lead of refused) {
    assert.equal(lead.final_stage, 'gate');
    assert.equal(lead.final_status, 'REFUSE');
    assert.deepEqual(
      lead.output.draft.claim_refs,
      [],
      'it carried no claim_refs at all, which is why only the prose rule could catch it',
    );
  }

  // The interesting property is not merely that it refused. A cited funding_stage claim of
  // "series B" EXISTS on the acme lead, fetched this run from the newsroom source. So this is
  // a CONTRADICTION caught by a typed check, not an absence caught by a missing-field check.
  // An untyped "is this token in any cited claim" rule would have to pass it.
  const acme = ledger
    .entries()
    .find(
      (e) =>
        e.reason_codes.includes('UNGROUNDED_PROSE_CLAIM') && /series B/i.test(e.detail ?? ''),
    );
  assert.ok(acme, 'the acme refusal names the cited funding stage it contradicts');
  assert.match(acme.detail, /Series C/i);
});

test('a draft carrying a forged citation IS caught by the gate today', async () => {
  // Unlike free prose, a claim_ref is structured, and the gate verifies every one of them
  // against the citations this run actually fetched.
  const { gate } = await import('../src/stages/gate.mjs');
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock(defaultConfig.clock),
    fetch: recordedFetcher({}),
    config: defaultConfig,
    run_id: 'run-adversarial',
  });

  const forged = {
    lead_id: 'lead-x',
    company: { name: 'Acme', domain: 'acme.test' },
    contact: { name: 'Dana', email: 'dana@acme.test' },
    claims: [{ field: 'employee_count', value: 240, citation: 'https://directory.test/company/acme.test', cited: true }],
    citations: ['https://directory.test/company/acme.test'],
    draft: {
      to: 'dana@acme.test',
      subject: 'A question about Acme',
      body: 'Hi Dana,\n\nA question rather than a pitch. At around 240 people, who decides which inbound signals get a human reply?',
      template: 'problem-first',
      claim_refs: [{ field: 'employee_count', citation: 'https://fabricated.test/source' }],
    },
  };

  const result = await gate.run(forged, ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['UNGROUNDED_CLAIM']);
  assert.match(result.detail, /fabricated\.test/);
});
