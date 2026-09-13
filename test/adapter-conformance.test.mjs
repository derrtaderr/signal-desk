// Adapter-contract conformance.
//
// The same idea as test/contract-conformance.test.mjs, applied to the sender registry: ONE
// harness, applied to EVERY registered adapter, so a third adapter added tomorrow is covered
// the moment it is registered rather than whenever someone remembers to write tests for it.
//
// The contract is documented in docs/ADAPTERS.md. This file is what makes it a contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { adapters, ADAPTER_CONTRACT_FIELDS, artifactFilename } from '../src/adapters.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';
import { computeDraftHash } from '../src/draft-hash.mjs';

const CITATION = 'https://directory.test/company/acme.test';

function lead() {
  const draft = {
    to: 'dana@acme.test',
    subject: 'Your team and Acme Robotics',
    body: 'Hi Dana,\n\nOpen to a short call?',
    template: 'executive-intro',
    claim_refs: [{ field: 'employee_count', citation: CITATION }],
  };
  const draft_hash = computeDraftHash(draft);
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test' },
    claims: [],
    citations: [CITATION],
    score: { total: 88, factors: [] },
    route: { band: 'priority', owner: 'ae-round-robin', play: 'executive-intro', reason: 'x' },
    draft,
    draft_hash,
    gate: { violations: [], rules_run: [] },
    queue: { autonomy_enabled: false, owner: 'ae-round-robin', draft_hash },
    approval: { draft_hash, lead_id: 'lead-abc123456789', decision: 'approve', by: 'dana.reviewer', at: '2026-03-01T08:55:00.000Z' },
  };
}

function ctx() {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture', handoff: { adapter: 'dry-run-json' } },
    run_id: 'run-test',
  });
}

test('the registry is not empty, so the harness below is not vacuous', () => {
  assert.ok(Object.keys(adapters).length >= 2);
});

for (const [key, adapter] of Object.entries(adapters)) {
  test(`${key}: carries every field the contract requires`, () => {
    for (const field of ADAPTER_CONTRACT_FIELDS) {
      assert.notEqual(adapter[field], undefined, `${key} declares ${field}`);
    }
    assert.equal(typeof adapter.render, 'function');
    assert.equal(typeof adapter.serialize, 'function');
  });

  test(`${key}: its name matches its registry key, so a refusal can name it`, () => {
    assert.equal(adapter.name, key);
  });

  test(`${key}: declares a plain file extension`, () => {
    assert.match(adapter.extension, /^[a-z0-9]+$/);
  });

  test(`${key}: renders a plain object`, () => {
    const artifact = adapter.render(lead(), ctx());
    assert.equal(typeof artifact, 'object');
    assert.ok(artifact !== null && !Array.isArray(artifact));
  });

  test(`${key}: serialises to a string ending in a newline`, () => {
    const text = adapter.serialize(adapter.render(lead(), ctx()));
    assert.equal(typeof text, 'string');
    assert.ok(text.endsWith('\n'));
  });

  test(`${key}: is deterministic, so an export can be compared between runs`, () => {
    const first = adapter.serialize(adapter.render(lead(), ctx()));
    const second = adapter.serialize(adapter.render(lead(), ctx()));
    assert.equal(first, second);
  });

  test(`${key}: does not mutate the lead it was handed`, () => {
    const subject = lead();
    const before = JSON.stringify(subject);
    adapter.render(subject, ctx());
    assert.equal(JSON.stringify(subject), before);
  });

  test(`${key}: marks the artifact as a dry run and never as sent`, () => {
    const artifact = adapter.render(lead(), ctx());
    assert.equal(artifact.dry_run, true);
    assert.notEqual(artifact.sent, true);
  });

  test(`${key}: binds the artifact to the draft that was approved`, () => {
    const subject = lead();
    const artifact = adapter.render(subject, ctx());
    assert.equal(artifact.draft_hash, subject.approval.draft_hash);
  });

  test(`${key}: records who approved it, so the export is attributable`, () => {
    assert.equal(adapter.render(lead(), ctx()).approved_by, 'dana.reviewer');
  });

  test(`${key}: the SERIALISED BYTES carry the claim citations, not just the object`, () => {
    // Asserted on the bytes, because that is what ships. The pre-serialisation object had the
    // citations all along; the JSON writer was stripping every nested object, so every export
    // read "claim_refs": [{}] and the evidence behind each claim was gone from the artifact.
    // An assertion on adapter.render() alone passed happily through that.
    const text = adapter.serialize(adapter.render(lead(), ctx()));
    assert.match(text, /employee_count/, 'the claim field survives serialisation');
    assert.match(text, /directory\.test/, 'and the citation that grounds it');
    assert.doesNotMatch(text, /\{\s*\}/, 'no object was flattened to an empty one');
  });

  test(`${key}: serialised bytes round-trip to the same structure that was rendered`, () => {
    // The general form of the bug above: whatever the writer does to key order or formatting,
    // it must not LOSE anything.
    const artifact = adapter.render(lead(), ctx());
    const text = adapter.serialize(artifact);
    if (adapter.extension !== 'json') return;
    assert.deepEqual(JSON.parse(text), artifact);
  });

  test(`${key}: carries the message a reader would receive`, () => {
    const text = adapter.serialize(adapter.render(lead(), ctx()));
    assert.match(text, /Open to a short call\?/);
    assert.match(text, /dana@acme\.test/);
  });

  test(`${key}: names its artifact per lead AND per draft, so two messages cannot collide`, () => {
    const subject = lead();
    const name = artifactFilename(subject, adapter);
    assert.ok(name.includes(subject.lead_id), 'the lead is in the name');
    assert.ok(name.includes(subject.draft_hash), 'and so is the draft');
    assert.ok(name.endsWith(`.${adapter.extension}`));
  });

  test(`${key}: a different draft for the same lead gets a different filename`, () => {
    const first = lead();
    const second = lead();
    second.draft = { ...second.draft, subject: 'A different subject entirely' };
    second.draft_hash = computeDraftHash(second.draft);

    assert.equal(first.lead_id, second.lead_id);
    assert.notEqual(artifactFilename(first, adapter), artifactFilename(second, adapter));
  });

  test(`${key}: render performs no I/O, so it cannot send anything`, () => {
    // Asserted structurally rather than by inspection: an adapter handed a context whose fetch
    // throws on any call must still render. Nothing in a renderer has any business reaching
    // the outside world.
    const hostile = createContext({
      ledger: new Ledger(),
      clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
      fetch: () => {
        throw new Error('an adapter reached the network');
      },
      config: { mode: 'fixture' },
      run_id: 'run-test',
    });
    assert.doesNotThrow(() => adapter.render(lead(), hostile));
  });
}

test('no adapter in the registry exposes a send, transmit or deliver function', () => {
  // The open tool never sends. This is the assertion that keeps a future adapter honest.
  for (const [key, adapter] of Object.entries(adapters)) {
    for (const forbidden of ['send', 'transmit', 'deliver', 'post', 'dispatch']) {
      assert.equal(adapter[forbidden], undefined, `${key} exposes no ${forbidden}()`);
    }
  }
});

test('the eml adapter renders RFC-5322-shaped headers followed by a blank line', () => {
  const text = adapters.eml.serialize(adapters.eml.render(lead(), ctx()));
  assert.match(text, /^To: dana@acme\.test\n/);
  assert.match(text, /\nSubject: Your team and Acme Robotics\n/);
  assert.match(text, /\n\nHi Dana,/, 'headers and body are separated by a blank line');
});

test('the eml adapter announces itself as a dry run in its own headers', () => {
  // A file that somehow escaped this repo should still say what it is.
  const text = adapters.eml.serialize(adapters.eml.render(lead(), ctx()));
  assert.match(text, /X-Signal-Desk-Dry-Run: true/);
});

test('the eml adapter writes no Date header, because a wall clock would break replay', () => {
  const text = adapters.eml.serialize(adapters.eml.render(lead(), ctx()));
  assert.doesNotMatch(text, /^Date:/m);
});
