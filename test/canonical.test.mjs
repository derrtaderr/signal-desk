import test from 'node:test';
import assert from 'node:assert/strict';

import { canonical } from '../src/canonical.mjs';

test('canonical sorts object keys so construction order cannot leak into bytes', () => {
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(canonical(a), '{"a":2,"b":1}');
});

test('canonical sorts nested object keys too', () => {
  assert.equal(
    canonical({ outer: { z: 1, a: { y: 2, b: 3 } } }),
    '{"outer":{"a":{"b":3,"y":2},"z":1}}',
  );
});

test('canonical preserves array order, which is meaningful', () => {
  assert.equal(canonical({ xs: [3, 1, 2] }), '{"xs":[3,1,2]}');
});

test('canonical sorts keys of objects inside arrays', () => {
  assert.equal(canonical([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});

test('canonical drops undefined-valued keys rather than emitting them', () => {
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
});

test('canonical emits null, which is a real value and not a missing one', () => {
  assert.equal(canonical({ a: null }), '{"a":null}');
});

test('canonical refuses a value it cannot represent deterministically', () => {
  assert.throws(() => canonical({ a: 1n }), /cannot be canonicalised/);
});
