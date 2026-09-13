// The draft-content hash. This is the value a human approval binds to.
//
// M1 bound approvals to a lead id, and the M1 review demonstrated what that buys you: one
// recorded approval authorising a second draft the human had never seen. "Approved" has to
// mean "approved THIS", and the only way to say THIS in a way a later stage can check is to
// hash the message.
//
// The hash covers exactly the message and nothing else. Not the lead it belongs to, not the
// score that produced it, not the gate report that followed it. A decoration added downstream
// must not invalidate an approval, and a change to a single character of what gets sent must.

import { createHash } from 'node:crypto';

import { canonical } from './canonical.mjs';

// Every field that changes what the recipient would read, named rather than implied. A field
// added to a draft in future is NOT covered until it is added here, which is deliberate: the
// list is the specification of what "the same message" means.
export const DRAFT_HASH_FIELDS = Object.freeze(['to', 'subject', 'body', 'template', 'claim_refs']);

export function computeDraftHash(draft) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new TypeError('a draft hash requires a draft object');
  }

  // Fail closed. Hashing a draft with a missing field would produce a perfectly stable hash
  // of something that is not a message, and an approval could then bind to a hole.
  const message = {};
  for (const field of DRAFT_HASH_FIELDS) {
    if (draft[field] === undefined) {
      throw new TypeError(`a draft hash requires the field ${field}, which is missing`);
    }
    message[field] = draft[field];
  }

  // Canonical serialisation, so key order cannot move the hash. Same reason the ledger uses it.
  return `draft-${createHash('sha256').update(canonical(message)).digest('hex').slice(0, 16)}`;
}
