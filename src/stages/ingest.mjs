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

// --- HMAC over raw bytes, new in M4 --------------------------------------------------------
//
// M1's divergence register named this gap and said live mode should close it: "the design says
// HMAC over raw bytes; M1 computes the HMAC over the canonical serialisation of the already-parsed
// payload... Live mode (M4) receives real request bodies and should verify over the raw bytes it
// was handed."
//
// These are two THREAT MODELS, not two spellings of one idea.
//
//   canonical  Binds the signature to the payload's MEANING. Survives a reserialisation, and
//              trusts the parser. Correct for a corpus of formatted JSON files a formatter would
//              otherwise invalidate, which is exactly what fixture mode is.
//   raw        Binds it to what the sender actually transmitted. A parser disagreement cannot move
//              the signature, because the signature never went near a parser.
//
// THE SECOND HALF IS WHERE THE VALUE IS, and skipping it would keep the threat model's name
// without its content. Verifying bytes and then acting on a parse nobody compared against those
// bytes leaves the whole attack open: somebody who can make one parser read the bytes one way and
// this pipeline act on another reading has defeated a byte-exact signature that still verifies
// perfectly. So raw mode also asserts that the parse it was handed agrees with a fresh parse of
// the same bytes.
//
// A raw-mode run with no bytes attached REFUSES. It does not fall back to canonical hashing,
// because a loader that forgot to attach the bytes would then get a signature check that passes
// for a weaker reason than the one the operator configured, and say nothing about it.

export function signRaw(secret, raw) {
  return createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

// The fields a live loader attaches beside the parse: the bytes, the out-of-band signature, and
// which file they came from. They are TRANSPORT material rather than anything the sender signed, so
// they are excluded from the bytes-versus-parse comparison and stripped before the lead travels.
//
// Getting this list wrong fails CLOSED, which is worth noting because it is the good direction. A
// field left off is a field the comparison sees on one side only, so every correctly signed signal
// refuses as SIGNATURE_INVALID — loud, immediate, and caught by the first live run rather than by
// a quiet acceptance of something unverified.
const TRANSPORT_FIELDS = ['raw', 'signature', 'source_file'];

function verifyRawBytes(signal, secret) {
  const { raw } = signal;
  if (typeof raw !== 'string' || raw === '') {
    return {
      reason: 'SIGNATURE_MISSING',
      detail:
        'ingest is configured to verify over raw bytes and this signal carries none. Falling back ' +
        'to hashing the parse would verify a weaker thing than the one configured, silently',
    };
  }
  if (!isNonEmptyString(signal.signature)) {
    return { reason: 'SIGNATURE_MISSING', detail: 'a secret is configured but the signal carries no signature' };
  }
  if (!equalSignatures(signal.signature, signRaw(secret, raw))) {
    return { reason: 'SIGNATURE_INVALID', detail: 'the signature does not cover these bytes' };
  }

  let reparsed;
  try {
    reparsed = JSON.parse(raw);
  } catch (error) {
    return {
      reason: 'SIGNATURE_INVALID',
      detail: `the signed bytes are not parseable JSON, so what was signed and what would be acted on cannot be the same: ${error.message}`,
    };
  }

  const acted = { ...signal };
  for (const field of TRANSPORT_FIELDS) delete acted[field];
  if (canonical(reparsed) !== canonical(acted)) {
    return {
      reason: 'SIGNATURE_INVALID',
      detail:
        'the signature covers these bytes and the parse this run was handed says something else. ' +
        'A byte-exact signature over bytes nobody re-read is a signature over a different message ' +
        'than the one about to be acted on',
    };
  }

  return null;
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
      if ((config.signatureOver ?? 'canonical') === 'raw') {
        const problem = verifyRawBytes(signal, config.secret);
        if (problem !== null) {
          return refuse({ ...problem, evidence_refs: [`signal:${signal.id}`] });
        }
      } else {
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
        // Where the SIGNAL says the evidence is, kept deliberately distinct from `citations`,
        // which is what enrich actually fetched. Collapsing the two names would let a URL nobody
        // fetched read as a citation, which is the one thing the enrichment discipline forbids.
        // Live mode reads these; fixture mode's configured templates ignore them. See M4 spec §6.
        sources: Array.isArray(signal.payload.sources) ? [...signal.payload.sources] : [],
        // The person-level source, also named by the signal in live mode, for the same reason the
        // claim sources are. See M4 spec §6.
        ...(isNonEmptyString(signal.payload.identity_source)
          ? { identity_source: signal.payload.identity_source }
          : {}),
      },
      evidence_refs: [`signal:${signal.id}`],
    });
  },
};
