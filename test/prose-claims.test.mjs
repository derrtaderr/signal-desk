// Claim grounding extended to free prose.
//
// M1 verified structured claim_refs and could not see a factual assertion written as ordinary
// sentence text. test/adversarial.test.mjs asserted that gap deliberately. This is the check
// that closes it.
//
// The check is TYPED, and the typing is what makes it correct rather than merely strict. An
// assertion of a given kind grounds only against a claim field that can carry that kind of
// fact, never against any string that happens to contain the token. Untyped support would let
// a poisoned `industry` value reading "logistics, now scaling after their Series C" ground a
// Series C assertion, which is precisely the failure this rule exists to catch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectProseClaims, groundProseClaims, PROSE_CLAIM_FIELDS } from '../src/prose-claims.mjs';

const DIRECTORY = 'https://directory.test/company/acme.test';
const NEWSROOM = 'https://newsroom.test/acme.test';

function cited(field, value, citation = DIRECTORY) {
  return { field, value, citation, cited: true };
}

// --- detection --------------------------------------------------------------------------

test('a funding stage written as prose is detected', () => {
  const found = detectProseClaims('Your Series C raise last month suggests you are scaling.');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'funding_stage');
  assert.match(found[0].text, /Series C/i);
});

test('a headcount written as prose is detected, with its number', () => {
  const found = detectProseClaims('At around 240 people, the constraint is rarely the tooling.');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'employee_count');
  assert.equal(found[0].value, 240);
});

test('employees and staff count as headcount too, not just people', () => {
  assert.equal(detectProseClaims('a team of 310 employees')[0].kind, 'employee_count');
  assert.equal(detectProseClaims('all 55 staff')[0].kind, 'employee_count');
});

test('a money figure is detected', () => {
  const found = detectProseClaims('after their $40 million round');
  assert.equal(found[0].kind, 'money');
});

test('ordinary prose with no factual assertion detects nothing', () => {
  assert.deepEqual(
    detectProseClaims('Hi Dana,\n\nWho decides which inbound signals are worth a human reply?'),
    [],
  );
});

test('a number that is not a headcount is not a headcount', () => {
  // The phone-shaped string the redaction rule handles must not also read as a claim.
  assert.deepEqual(detectProseClaims('reach them on 415-555-0132'), []);
});

test('detection is deterministic', () => {
  const text = 'Your Series C raise, and all 240 people.';
  assert.deepEqual(detectProseClaims(text), detectProseClaims(text));
});

// --- grounding --------------------------------------------------------------------------

test('a headcount matching a cited employee_count claim is grounded', () => {
  const ungrounded = groundProseClaims('At around 240 people, who owns this?', [
    cited('employee_count', 240),
  ]);
  assert.deepEqual(ungrounded, []);
});

test('a headcount contradicting the cited claim is NOT grounded', () => {
  const ungrounded = groundProseClaims('At around 900 people, who owns this?', [
    cited('employee_count', 240),
  ]);
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].kind, 'employee_count');
});

test('a headcount with no employee_count claim at all is NOT grounded', () => {
  assert.equal(groundProseClaims('At around 240 people.', []).length, 1);
});

test('a funding stage matching a cited funding_stage claim is grounded', () => {
  assert.deepEqual(
    groundProseClaims('fresh from your Series B', [cited('funding_stage', 'series B', NEWSROOM)]),
    [],
  );
});

test('a funding stage CONTRADICTING the cited funding_stage claim is not grounded', () => {
  // The case that matters most: a claim of the right type exists and does not support it.
  const ungrounded = groundProseClaims('Your Series C raise last month', [
    cited('funding_stage', 'series B', NEWSROOM),
  ]);
  assert.equal(ungrounded.length, 1);
  assert.match(ungrounded[0].detail ?? ungrounded[0].text, /Series C/i);
});

test('an UNCITED claim of the right field does not ground an assertion', () => {
  const ungrounded = groundProseClaims('At around 240 people.', [
    { field: 'employee_count', value: 240, citation: null, cited: false },
  ]);
  assert.equal(ungrounded.length, 1, 'self-asserted is not evidence');
});

// --- the typing, which is the whole reason this is correct ------------------------------

test('a claim of the WRONG field does not ground an assertion, even containing the words', () => {
  // The poisoned-enrichment case. An industry string carrying "Series C" must not ground a
  // Series C assertion, because industry is not a field that can carry a funding fact.
  const ungrounded = groundProseClaims('now scaling after their Series C', [
    cited('industry', 'logistics software, now scaling after their Series C'),
  ]);
  assert.equal(ungrounded.length, 1, 'an industry string cannot vouch for a funding round');
});

test('the field each assertion kind may ground against is named, not implied', () => {
  assert.deepEqual(PROSE_CLAIM_FIELDS.funding_stage, ['funding_stage']);
  assert.deepEqual(PROSE_CLAIM_FIELDS.employee_count, ['employee_count']);
  assert.ok(PROSE_CLAIM_FIELDS.money.includes('revenue'));
});

test('grounding is deterministic', () => {
  const claims = [cited('employee_count', 240)];
  const text = 'At around 900 people.';
  assert.deepEqual(groundProseClaims(text, claims), groundProseClaims(text, claims));
});
