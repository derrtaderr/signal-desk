// Stage 1 — ingest.
//
// Discipline enforced: HMAC over the payload, replay window, idempotency, and a shape
// check strict enough that nothing downstream has to re-validate. Pattern adapted from
// webhook-engine; no code is vendored.
//
// Order matters and is deliberate: shape first, then signature, then window, then
// duplicate. A garbage body must be rejected before the verifier touches it, and there is
// no point asking whether we have seen a signal we have already refused to trust.

import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

import { canonical } from '../canonical.mjs';
import { pass, refuse } from '../contract.mjs';

export function signPayload(secret, payload) {
  return createHmac('sha256', secret).update(canonical(payload)).digest('hex');
}

function equalSignatures(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function leadIdFor(domain, email) {
  const digest = createHash('sha256').update(`${domain} ${email}`).digest('hex');
  return `lead-${digest.slice(0, 12)}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Returns the name of the first missing or malformed field, or null when the shape holds.
function shapeProblem(signal) {
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    return 'signal must be an object';
  }
  if (!isNonEmptyString(signal.id)) return 'id';
  if (!isNonEmptyString(signal.source)) return 'source';
  if (!isNonEmptyString(signal.received_at)) return 'received_at';
  if (Number.isNaN(Date.parse(signal.received_at))) return 'received_at is not a parseable instant';

  const { payload } = signal;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'payload';
  if (payload.company === null || typeof payload.company !== 'object') return 'payload.company';
  if (!isNonEmptyString(payload.company.domain)) return 'payload.company.domain';
  if (!isNonEmptyString(payload.company.name)) return 'payload.company.name';
  if (payload.contact === null || typeof payload.contact !== 'object') return 'payload.contact';
  if (!isNonEmptyString(payload.contact.email)) return 'payload.contact.email';
  if (!payload.contact.email.includes('@')) return 'payload.contact.email is not an address';

  return null;
}

export const ingest = {
  name: 'ingest',

  run(signal, ctx) {
    const config = ctx.config.ingest ?? {};

    const problem = shapeProblem(signal);
    if (problem !== null) {
      return refuse({ reason: 'MALFORMED_PAYLOAD', detail: `signal is malformed: ${problem}` });
    }

    if (isNonEmptyString(config.secret)) {
      if (!isNonEmptyString(signal.signature)) {
        return refuse({
          reason: 'SIGNATURE_MISSING',
          evidence_refs: [`signal:${signal.id}`],
          detail: 'a secret is configured but the signal carries no signature',
        });
      }
      const expected = signPayload(config.secret, signal.payload);
      if (!equalSignatures(signal.signature, expected)) {
        return refuse({
          reason: 'SIGNATURE_INVALID',
          evidence_refs: [`signal:${signal.id}`],
          detail: 'the signature does not cover this payload',
        });
      }
    }

    // peek() rather than now(), because a validation check must not advance the clock.
    // A ledger whose instants depend on how many branches a stage took is not replayable.
    const windowMs = config.replayWindowMs ?? 300000;
    const ageMs = Date.parse(ctx.clock.peek()) - Date.parse(signal.received_at);
    if (ageMs > windowMs) {
      return refuse({
        reason: 'REPLAY_WINDOW_EXCEEDED',
        evidence_refs: [`signal:${signal.id}`],
        detail: `signal is ${ageMs}ms old, outside the ${windowMs}ms replay window`,
      });
    }

    // The ledger is the idempotency store, and it is consulted at two levels because two
    // different things can arrive twice. See docs/M2-SPEC.md, "the identity model".
    //
    // Level one, the signal. A replayed webhook: the same signal id seen again. The lookup
    // keys on the evidence ref rather than on the entry's lead_id, because a passing ingest
    // entry files under the CANONICAL lead id it just assigned, not under the signal id.
    const marker = `signal:${signal.id}`;
    const entries = ctx.ledger.entries();
    const acceptedIngests = entries.filter(
      (entry) => entry.stage === 'ingest' && entry.verdict === 'PASS',
    );

    if (acceptedIngests.some((entry) => entry.evidence_refs.includes(marker))) {
      return refuse({
        reason: 'DUPLICATE_SIGNAL',
        evidence_refs: [marker],
        detail: `signal ${signal.id} has already been accepted by a passing ingest entry`,
      });
    }

    // Level two, the lead. A DIFFERENT signal about a person already in flight this run.
    //
    // This is not a redundant check. The HMAC covers `payload` and nothing else, so re-issuing
    // a signal under a fresh id leaves the signature valid and steps straight past level one.
    // M1 had only level one, and a second signal for one contact therefore ran the whole
    // pipeline again, consumed the same human approval a second time, and wrote its handoff
    // artifact over the first. One person, one motion: a second signal about someone already
    // accepted is corroborating evidence, never a second reason to write to them.
    const domain = signal.payload.company.domain.trim().toLowerCase();
    const email = signal.payload.contact.email.trim().toLowerCase();
    const leadId = leadIdFor(domain, email);

    const priorAcceptance = acceptedIngests.find((entry) => entry.lead_id === leadId);
    if (priorAcceptance !== undefined) {
      return refuse({
        reason: 'DUPLICATE_LEAD',
        evidence_refs: [marker, `lead:${leadId}`],
        detail:
          `signal ${signal.id} resolves to ${leadId}, which has already been accepted this ` +
          `run from ${priorAcceptance.evidence_refs.find((ref) => ref.startsWith('signal:')) ?? 'an earlier signal'}`,
      });
    }

    return pass({
      output: {
        lead_id: leadId,
        signal_id: signal.id,
        source: signal.source,
        received_at: signal.received_at,
        company: { ...signal.payload.company, domain },
        contact: { ...signal.payload.contact, email },
        intent: signal.payload.intent ?? {},
      },
      evidence_refs: [`signal:${signal.id}`],
    });
  },
};
