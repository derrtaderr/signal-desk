import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PASS,
  REFUSE,
  NEEDS_HUMAN,
  VERDICTS,
  pass,
  refuse,
  needsHuman,
  assertStageResult,
} from '../src/contract.mjs';

test('the contract names exactly three verdicts', () => {
  assert.deepEqual(VERDICTS, ['PASS', 'REFUSE', 'NEEDS_HUMAN']);
  assert.equal(PASS, 'PASS');
  assert.equal(REFUSE, 'REFUSE');
  assert.equal(NEEDS_HUMAN, 'NEEDS_HUMAN');
});

test('pass builds a well-formed result carrying its output', () => {
  const result = pass({ output: { lead_id: 'a' } });
  assert.equal(result.status, PASS);
  assert.deepEqual(result.output, { lead_id: 'a' });
  assert.deepEqual(result.entries, []);
});

test('refuse requires a machine-readable reason code', () => {
  assert.throws(() => refuse({}), /reason/);
  assert.throws(() => refuse({ reason: '' }), /reason/);
});

test('refuse carries its reason code onto the result and its entry', () => {
  const result = refuse({ reason: 'MALFORMED_PAYLOAD', detail: 'no id' });
  assert.equal(result.status, REFUSE);
  assert.deepEqual(result.reason_codes, ['MALFORMED_PAYLOAD']);
  assert.equal(result.detail, 'no id');
});

test('needsHuman requires a reason code too, because parking is also a decision', () => {
  assert.throws(() => needsHuman({}), /reason/);
  const result = needsHuman({ reason: 'AWAITING_APPROVAL' });
  assert.equal(result.status, NEEDS_HUMAN);
  assert.deepEqual(result.reason_codes, ['AWAITING_APPROVAL']);
});

test('a result may carry ledger entries for the kernel to stamp and append', () => {
  const result = pass({
    output: {},
    entries: [{ verdict: 'PASS', reason_codes: [], evidence_refs: [], actor: 'system' }],
  });
  assert.equal(result.entries.length, 1);
});

test('assertStageResult accepts each of the three verdicts', () => {
  for (const status of VERDICTS) {
    // PASS needs no reason code; the other two carry one by contract.
    const reason_codes = status === PASS ? [] : ['SOME_REASON'];
    assertStageResult({ status, output: {}, entries: [], reason_codes }, 'someStage');
  }
});

test('assertStageResult rejects a missing status', () => {
  assert.throws(() => assertStageResult({ output: {}, entries: [] }, 'someStage'), /status/);
});

test('assertStageResult rejects a status outside the contract', () => {
  assert.throws(
    () => assertStageResult({ status: 'OK', output: {}, entries: [] }, 'someStage'),
    /status/,
  );
});

test('assertStageResult rejects entries that are not an array', () => {
  assert.throws(
    () => assertStageResult({ status: PASS, output: {}, entries: 'nope' }, 'someStage'),
    /entries/,
  );
});

test('assertStageResult rejects a REFUSE carrying no reason code', () => {
  assert.throws(
    () => assertStageResult({ status: REFUSE, output: {}, entries: [], reason_codes: [] }, 's'),
    /reason/,
  );
});

test('assertStageResult names the offending stage, so a failure points somewhere', () => {
  assert.throws(() => assertStageResult({}, 'enrich'), /enrich/);
});

test('assertStageResult rejects a non-object result, including null', () => {
  assert.throws(() => assertStageResult(null, 'enrich'), /enrich/);
  assert.throws(() => assertStageResult(undefined, 'enrich'), /enrich/);
});
