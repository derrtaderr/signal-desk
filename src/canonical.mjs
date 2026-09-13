// Canonical JSON. One serialiser, sorted keys, used for every byte the ledger writes
// and every byte the hash chain covers. Key order is the difference between a ledger
// that replays byte-for-byte and one that only looks like it does.

function encode(value) {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`value ${value} cannot be canonicalised`);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // Array order is meaningful and is preserved. An undefined slot becomes null,
    // matching JSON.stringify, because dropping it would change the length.
    return `[${value.map((item) => (item === undefined ? 'null' : encode(item))).join(',')}]`;
  }

  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${encode(value[key])}`);
    return `{${pairs.join(',')}}`;
  }

  throw new TypeError(`value of type ${type} cannot be canonicalised`);
}

export function canonical(value) {
  if (value === undefined) {
    throw new TypeError('value of type undefined cannot be canonicalised');
  }
  return encode(value);
}
