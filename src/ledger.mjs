// The decision ledger. Append-only JSONL, hash-chained so that editing or dropping a
// line is detectable. This is the artifact a reader inspects, so its integrity is the
// product, not a nicety.

import { createHash } from 'node:crypto';

import { canonical } from './canonical.mjs';
import { VERDICTS } from './contract.mjs';

export const GENESIS_PREV = '0'.repeat(64);

const REQUIRED_FIELDS = [
  'ts',
  'run_id',
  'lead_id',
  'stage',
  'verdict',
  'reason_codes',
  'evidence_refs',
  'actor',
];

const ACTORS = ['system', 'human'];

// The payload is every field except the chain links. Hashing the payload rather than
// the whole line keeps `hash` out of its own preimage.
function payloadOf(entry) {
  const { hash, prev, ...payload } = entry;
  return payload;
}

export function hashEntry(prev, payload) {
  return createHash('sha256').update(prev).update(canonical(payload)).digest('hex');
}

function validate(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('ledger entry must be an object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (entry[field] === undefined) {
      throw new TypeError(`ledger entry is missing required field: ${field}`);
    }
  }
  if (!VERDICTS.includes(entry.verdict)) {
    throw new TypeError(
      `ledger entry has verdict ${JSON.stringify(entry.verdict)}, expected one of ${VERDICTS.join(', ')}`,
    );
  }
  if (!ACTORS.includes(entry.actor)) {
    throw new TypeError(
      `ledger entry has actor ${JSON.stringify(entry.actor)}, expected one of ${ACTORS.join(', ')}`,
    );
  }
  if (!Array.isArray(entry.reason_codes)) {
    throw new TypeError('ledger entry field reason_codes must be an array');
  }
  if (!Array.isArray(entry.evidence_refs)) {
    throw new TypeError('ledger entry field evidence_refs must be an array');
  }
}

export class Ledger {
  #entries = [];

  append(entry) {
    validate(entry);
    const prev = this.head();
    const payload = payloadOf(entry);
    const written = Object.freeze({ ...payload, prev, hash: hashEntry(prev, payload) });
    this.#entries.push(written);
    return written;
  }

  head() {
    if (this.#entries.length === 0) return GENESIS_PREV;
    return this.#entries[this.#entries.length - 1].hash;
  }

  entries() {
    return [...this.#entries];
  }

  entriesFor(leadId) {
    return this.#entries.filter((e) => e.lead_id === leadId);
  }

  toJSONL() {
    if (this.#entries.length === 0) return '';
    return `${this.#entries.map((e) => canonical(e)).join('\n')}\n`;
  }
}

export function verifyChain(entries) {
  let prev = GENESIS_PREV;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.prev !== prev) {
      return {
        ok: false,
        index,
        reason: `entry ${index} declares prev ${entry.prev}, but the chain is at ${prev}`,
      };
    }
    const expected = hashEntry(entry.prev, payloadOf(entry));
    if (entry.hash !== expected) {
      return {
        ok: false,
        index,
        reason: `entry ${index} declares hash ${entry.hash}, but its payload hashes to ${expected}`,
      };
    }
    prev = entry.hash;
  }
  return { ok: true };
}

export function parseLedger(text) {
  if (text.trim() === '') return [];
  return text
    .trimEnd()
    .split('\n')
    .map((line) => Object.freeze(JSON.parse(line)));
}
