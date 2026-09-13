// Test family 3 of 4 — adversarial.
//
// DESIGN.md §7 lists the hostile inputs the corpus must ship, each ending in a VISIBLE catch
// with a full ledger trail. M1 landed the malformed webhook and the duplicate signal, M2 added
// PII mid-enrichment, the rubric failure and the ungrounded prose claim, and M3 closes the list
// with the wrong-person match, the decayed record, the prompt injection and the hallucination
// bait. Nothing on that list is outstanding now.
//
// Each catch is asserted four ways: the lead is refused, the reason code is the expected one,
// the catch happens at the stage that OWNS it rather than merely somewhere downstream, and the
// ledger carries a trail a human can read. A refusal with no trail is not an inspectable system,
// and a refusal at the wrong stage is a coincidence rather than a safeguard.

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

// --- hostile fixture 7: the wrong-person match ---------------------------------------
//
// The signal is valid in every way a webhook can be checked. It is correctly signed, in window,
// not a duplicate, and it names a real-looking company and a real-looking contact. What is wrong
// with it is not visible at ingest at all: the person-level source says that address belongs to
// someone at a different company. See docs/M3-SPEC.md part 1 (a).

// The lead id is derived from the domain and the address, so it is looked up through the
// signal that produced it rather than pasted in as a literal a template change would strand.
function leadIdForSignal(signalId) {
  const entry = run.ledger
    .entries()
    .find((e) => e.stage === 'ingest' && e.evidence_refs.includes(`signal:${signalId}`));
  return entry?.lead_id;
}

test('the wrong-person fixture ships in the corpus and is a perfectly valid webhook', () => {
  const { signals } = loadFixtures();
  const signal = signals.find((s) => s.id === 'sig-9007');
  assert.ok(signal, 'fixtures/signals/9007-wrong-person-match.json is loaded');
  assert.equal(
    signal.signature,
    signPayload(FIXTURE_SECRET, signal.payload),
    'correctly signed, so nothing at ingest can catch it',
  );
  assert.ok(signal.payload.company.domain, 'and well formed, so the shape check cannot either');
});

test('the wrong-person match is REFUSED with IDENTITY_CONTRADICTED', () => {
  const lead = run.report.leads.find((l) => l.lead_id === leadIdForSignal('sig-9007'));
  assert.equal(lead.final_status, 'REFUSE');
  assert.deepEqual(lead.reason_codes, ['IDENTITY_CONTRADICTED']);
});

test('the wrong-person match is caught at enrich, the stage that holds the evidence', () => {
  const lead = run.report.leads.find((l) => l.lead_id === leadIdForSignal('sig-9007'));
  assert.equal(lead.final_stage, 'enrich');
  const stages = entriesFor(lead.lead_id).map((e) => e.stage);
  assert.deepEqual([...new Set(stages)], ['ingest', 'enrich'], 'nothing scored, routed or drafted');
});

test('the wrong-person refusal names both the company claimed and the company recorded', () => {
  const leadId = leadIdForSignal('sig-9007');
  const refusal = entriesFor(leadId).find((e) => e.verdict === 'REFUSE');
  assert.match(refusal.detail, /meridian\.test/, 'the company the signal claimed');
  assert.match(refusal.detail, /harborline\.test/, 'the company the person record puts them at');
  assert.ok(refusal.evidence_refs.length > 0, 'and cites the source it stood on');
});

test('no draft is ever composed for the wrong person', () => {
  // The point of catching it at enrich. A message to the wrong human is not made safer by being
  // written first and refused later.
  const leadId = leadIdForSignal('sig-9007');
  assert.deepEqual(
    run.ledger.entries().filter((e) => e.lead_id === leadId && e.stage === 'draft'),
    [],
  );
});

// --- hostile fixture 8: the decayed record -------------------------------------------
//
// The source answers. It answers 200, in the right shape, with a headcount and an industry. The
// record is eleven months old, and a 200 is not freshness. See docs/M3-SPEC.md part 1 (b).

test('the decayed-enrichment fixture ships in the corpus, with a source that really does answer', () => {
  const { signals, recordings } = loadFixtures();
  assert.ok(signals.find((s) => s.id === 'sig-9008'), 'the signal is loaded');
  const record = recordings['https://directory.test/company/cinder.test'];
  assert.equal(record.status, 200, 'the source is reachable, so nothing about availability catches it');
  assert.ok(record.body.claims.employee_count, 'and it carries a perfectly well-formed claim');
});

test('the decayed record is REFUSED with EVIDENCE_DECAYED, not with NO_CITED_CLAIMS', () => {
  const lead = run.report.leads.find((l) => l.lead_id === leadIdForSignal('sig-9008'));
  assert.equal(lead.final_status, 'REFUSE');
  assert.deepEqual(lead.reason_codes, ['EVIDENCE_DECAYED']);
});

test('the decayed record is caught at enrich, and the trail names the date and the window', () => {
  const leadId = leadIdForSignal('sig-9008');
  const lead = run.report.leads.find((l) => l.lead_id === leadId);
  assert.equal(lead.final_stage, 'enrich');

  const drop = entriesFor(leadId).find((e) => e.reason_codes.includes('EVIDENCE_DECAYED') && e.verdict === 'PASS');
  assert.ok(drop, 'the drop is recorded before the refusal, so a reader sees what was thrown away');
  assert.match(drop.detail, /2025-04-02/, 'the date the record carried');
  assert.match(drop.detail, /90 day/, 'and the window it fell outside');
});

test('the decayed lead still had its identity confirmed, so it fails for exactly one reason', () => {
  // Fixture hygiene that is also the product claim. A hostile fixture that trips two safeguards
  // proves neither of them, because the second one never had to work.
  const leadId = leadIdForSignal('sig-9008');
  assert.ok(entriesFor(leadId).some((e) => e.reason_codes.includes('IDENTITY_CONFIRMED')));
});

test('the decayed claim never reaches a draft, so an expired number is never stated as current', () => {
  const leadId = leadIdForSignal('sig-9008');
  assert.deepEqual(
    run.ledger.entries().filter((e) => e.lead_id === leadId && e.stage === 'draft'),
    [],
  );
});

test('no claim anywhere in the demo run rests on a source the run did not date', () => {
  // The corpus cannot contain an undated recording, because the rule that makes undated evidence
  // unusable would then be untestable against the demo everyone actually runs.
  const { recordings } = loadFixtures();
  const undated = Object.entries(recordings)
    .filter(([url]) => !url.startsWith('https://judge.test/'))
    .filter(([, response]) => response.status === 200 && typeof response.body?.as_of !== 'string');
  assert.deepEqual(undated.map(([url]) => url), []);
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

  // Every lead routed to the poisoned play is caught, not merely one of them. The count is
  // derived rather than hardcoded, so adding a fixture to the corpus does not silently turn
  // this into a weaker assertion than it was written to be.
  const reachedTheGate = report.leads.filter((l) => l.output?.draft?.template === 'executive-intro');
  const refused = report.leads.filter((l) => l.reason_codes.includes('UNGROUNDED_PROSE_CLAIM'));
  assert.ok(reachedTheGate.length >= 2, 'more than one lead is routed to the poisoned play');
  assert.equal(
    refused.length,
    reachedTheGate.length,
    'every lead routed to the poisoned play was refused for its prose',
  );
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
