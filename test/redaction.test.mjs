// Fail-closed PII redaction, adapted from redaction-gate's public pattern. No code vendored.
//
// The pattern's whole content is that redaction and verification are TWO passes with TWO
// different detectors, and the caller refuses when the second pass still finds something. A
// single-pass regex that reports what it matched cannot distinguish "there was no PII" from
// "my pattern did not match", and those are exactly the two cases that matter.
//
// The tests below are built around that asymmetry. Each REDACTION_INCOMPLETE case is a real
// string that the redacting pattern genuinely misses and the verifying pattern genuinely
// catches, rather than a contrived one, because a demonstration that cannot fail proves
// nothing about the mechanism.

import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, assertClean } from '../src/redaction.mjs';

const RECIPIENT = 'dana@acme.test';

// --- redaction ------------------------------------------------------------------------

test('a clean body redacts to itself and reports no hits', () => {
  const text = 'Hi Dana,\n\nAt around 240 people, who owns the handoff?';
  const { redacted, hits } = redact(text, { allow: [RECIPIENT] });
  assert.equal(redacted, text);
  assert.deepEqual(hits, []);
});

test('a third-party address is replaced and reported', () => {
  const { redacted, hits } = redact('spoke with marcus.webb@othercorp.test already', {
    allow: [RECIPIENT],
  });
  assert.ok(!redacted.includes('marcus.webb@othercorp.test'), 'the address is gone from the text');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'email');
  assert.equal(hits[0].value, 'marcus.webb@othercorp.test');
});

test('a phone number is replaced and reported', () => {
  const { redacted, hits } = redact('reach them on 415-555-0132 most afternoons', {
    allow: [RECIPIENT],
  });
  assert.ok(!redacted.includes('415-555-0132'));
  assert.deepEqual(hits.map((h) => h.type), ['phone']);
});

test('the recipient is replaced too, but is not a hit, because writing to someone is not leaking them', () => {
  const { redacted, hits } = redact(`writing to ${RECIPIENT} about your visit`, {
    allow: [RECIPIENT],
  });
  assert.deepEqual(hits, [], 'the recipient is not reported as leaked PII');
  assert.ok(!redacted.includes(RECIPIENT), 'but it is still removed, so verification runs on text with no addresses at all');
});

test('the allow list is matched case-insensitively, since addresses are', () => {
  const { hits } = redact('writing to Dana@Acme.TEST about your visit', { allow: [RECIPIENT] });
  assert.deepEqual(hits, []);
});

test('every third-party address is reported, not just the first', () => {
  const { hits } = redact('cc a@one.test and b@two.test', { allow: [RECIPIENT] });
  assert.equal(hits.length, 2);
});

test('redaction is deterministic', () => {
  const text = 'call 415-555-0132 or mail a@one.test';
  assert.deepEqual(redact(text, { allow: [] }), redact(text, { allow: [] }));
});

// --- verification, and the asymmetry that is the whole point ---------------------------

test('text with nothing left in it verifies clean', () => {
  const { redacted } = redact('spoke with marcus@othercorp.test', { allow: [] });
  assert.deepEqual(assertClean(redacted), { clean: true, found: [] });
});

test('the verifier catches an address the redacting pattern misses', () => {
  // A bare internal hostname with no dotted TLD. The redacting pattern requires one, so it
  // does not match. The verifier looks for an @ between word characters and does.
  const text = 'forward this to ops@internal and they will sort it';
  const { redacted, hits } = redact(text, { allow: [] });
  assert.deepEqual(hits, [], 'redaction genuinely missed it; this is not a contrived case');
  assert.equal(redacted, text, 'so the text came back unchanged');

  const verdict = assertClean(redacted);
  assert.equal(verdict.clean, false, 'and the independent verifier catches what redaction missed');
  assert.equal(verdict.found[0].type, 'email');
});

test('the verifier catches a digit run the phone pattern misses', () => {
  // No separators, so the redacting pattern's group structure does not match.
  const text = 'their desk line is 4155550132 if you need it';
  const { redacted, hits } = redact(text, { allow: [] });
  assert.deepEqual(hits, [], 'redaction genuinely missed it');

  const verdict = assertClean(redacted);
  assert.equal(verdict.clean, false);
  assert.equal(verdict.found[0].type, 'phone');
});

test('the verifier does not fire on ordinary small numbers in prose', () => {
  assert.deepEqual(assertClean('At around 240 people, across 3 regions.'), { clean: true, found: [] });
});

test('the verifier does not fire on the placeholders redaction leaves behind', () => {
  const { redacted } = redact('mail a@one.test or call 415-555-0132', { allow: [] });
  assert.equal(assertClean(redacted).clean, true, 'a placeholder is not itself a finding');
});

test('verification reports what it found, so a refusal can name it', () => {
  const verdict = assertClean('reach ops@internal');
  assert.ok(verdict.found.length > 0);
  assert.ok(typeof verdict.found[0].value === 'string' && verdict.found[0].value.length > 0);
});

test('verification is deterministic', () => {
  assert.deepEqual(assertClean('reach ops@internal'), assertClean('reach ops@internal'));
});

// --- the character-set boundary, tested rather than assumed -----------------------------
//
// Both detectors are built from ASCII character classes, so anything that LOOKS like an
// address or a number to a human while not being ASCII slips past. Probed before writing this:
// a fullwidth ＠ and fullwidth digits passed redaction AND verification, silently.
//
// Compatibility forms are closed below by normalising before detection. Homoglyphs are NOT,
// and that boundary is documented in src/redaction.mjs rather than left for someone to discover.

test('a fullwidth at-sign is still an address', () => {
  const { hits } = redact('forward to ops＠leak.test please', { allow: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'email');
});

test('fullwidth digits are still a phone number', () => {
  const text = 'call ４１５-５５５-０１４２ if you must';
  const { hits } = redact(text, { allow: [] });
  assert.deepEqual(hits.map((h) => h.type), ['phone']);
});

test('the verifier normalises too, so a compatibility form cannot slip past it either', () => {
  assert.equal(assertClean('reach ops＠internal').clean, false);
  assert.equal(assertClean('call ４１５５５５０１４２').clean, false);
});

test('normalisation does not change what a clean body reports', () => {
  const text = 'Hi Dana,\n\nAt around 240 people, who owns the handoff?';
  const { hits } = redact(text, { allow: [] });
  assert.deepEqual(hits, []);
  assert.equal(assertClean(text).clean, true);
});

test('a recipient written in a compatibility form is still recognised as the recipient', () => {
  const { hits } = redact('writing to dana＠acme.test about your visit', { allow: ['dana@acme.test'] });
  assert.deepEqual(hits, [], 'the allow list survives normalisation');
});

test('KNOWN BOUNDARY: a homoglyph ADJACENT to the @ defeats both detectors', () => {
  // Asserted rather than hidden, the same way the M1 gap was. Closing this needs a confusables
  // table, which is different work from normalisation and is not in this milestone. If someone
  // closes it later, this test fails and tells them to delete it.
  //
  // The boundary is narrower than it first looks, and the narrowness is the useful part. A
  // homoglyph in the MIDDLE of a local part changes nothing, because the ASCII run either side
  // of it still matches: "аbc@one.test" is caught on "bc@one.test". Only a non-ASCII character
  // sitting immediately against the @ breaks the pattern.
  const caught = 'mail аbc@one.test';      // Cyrillic а, but ASCII "bc" still abuts the @
  assert.equal(redact(caught, { allow: [] }).hits.length, 1, 'still caught');

  const missed = 'mail aа@one.test';       // Cyrillic а sits directly against the @
  assert.deepEqual(redact(missed, { allow: [] }).hits, [], 'redaction does not catch it');
  assert.equal(assertClean(missed).clean, true, 'and neither does verification');
});
