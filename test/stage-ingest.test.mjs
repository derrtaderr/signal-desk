import test from 'node:test';
import assert from 'node:assert/strict';

import { ingest, signPayload } from '../src/stages/ingest.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

const SECRET = 'fixture-secret';

function validPayload() {
  return {
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    intent: { page: '/pricing', visits: 4 },
  };
}

function validSignal(overrides = {}) {
  const payload = overrides.payload ?? validPayload();
  return {
    id: 'sig-1',
    source: 'rb2b',
    received_at: '2026-03-01T08:59:00.000Z',
    payload,
    signature: signPayload(SECRET, payload),
    ...overrides,
  };
}

function makeCtx({ ledger = new Ledger() } = {}) {
  return {
    ledger,
    ctx: createContext({
      ledger,
      clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
      fetch: recordedFetcher({}),
      config: { mode: 'fixture', ingest: { secret: SECRET, replayWindowMs: 300000 } },
      run_id: 'run-test',
    }),
  };
}

test('a well-formed, correctly signed, in-window signal passes', async () => {
  const { ctx } = makeCtx();
  const result = await ingest.run(validSignal(), ctx);
  assert.equal(result.status, 'PASS');
});

test('ingest assigns a deterministic canonical lead_id derived from the identity fields', async () => {
  const { ctx } = makeCtx();
  const a = await ingest.run(validSignal(), ctx);
  const { ctx: ctx2 } = makeCtx();
  const b = await ingest.run(validSignal({ id: 'sig-different' }), ctx2);
  assert.match(a.output.lead_id, /^lead-[0-9a-f]{12}$/);
  assert.equal(a.output.lead_id, b.output.lead_id, 'same company and contact means the same lead');
});

test('ingest normalises the signal into a lead carrying company, contact and intent', async () => {
  const { ctx } = makeCtx();
  const { output } = await ingest.run(validSignal(), ctx);
  assert.equal(output.company.domain, 'acme.test');
  assert.equal(output.contact.email, 'dana@acme.test');
  assert.equal(output.intent.page, '/pricing');
  assert.equal(output.signal_id, 'sig-1');
  assert.equal(output.source, 'rb2b');
});

test('ingest lowercases the domain and email, so casing cannot split one lead into two', async () => {
  const { ctx } = makeCtx();
  const payload = validPayload();
  payload.company.domain = 'ACME.test';
  payload.contact.email = 'Dana@ACME.test';
  const signal = { ...validSignal({ payload }), signature: signPayload(SECRET, payload) };
  const { output } = await ingest.run(signal, ctx);
  assert.equal(output.company.domain, 'acme.test');
  assert.equal(output.contact.email, 'dana@acme.test');
});

// --- the malformed-webhook hostile fixture -----------------------------------------

test('a signal that is not an object REFUSES with MALFORMED_PAYLOAD', async () => {
  const { ctx } = makeCtx();
  const result = await ingest.run('not-an-object', ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MALFORMED_PAYLOAD']);
});

test('a signal with no payload REFUSES with MALFORMED_PAYLOAD', async () => {
  const { ctx } = makeCtx();
  const signal = validSignal();
  delete signal.payload;
  const result = await ingest.run(signal, ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MALFORMED_PAYLOAD']);
});

test('a payload missing the company domain REFUSES with MALFORMED_PAYLOAD naming the field', async () => {
  const { ctx } = makeCtx();
  const payload = validPayload();
  delete payload.company.domain;
  const result = await ingest.run(
    { ...validSignal({ payload }), signature: signPayload(SECRET, payload) },
    ctx,
  );
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['MALFORMED_PAYLOAD']);
  assert.match(result.detail, /company\.domain/);
});

test('a payload missing the contact email REFUSES with MALFORMED_PAYLOAD', async () => {
  const { ctx } = makeCtx();
  const payload = validPayload();
  delete payload.contact.email;
  const result = await ingest.run(
    { ...validSignal({ payload }), signature: signPayload(SECRET, payload) },
    ctx,
  );
  assert.equal(result.status, 'REFUSE');
  assert.match(result.detail, /contact\.email/);
});

test('malformed input is rejected before the signature is checked, so a garbage body cannot crash the verifier', async () => {
  const { ctx } = makeCtx();
  const result = await ingest.run({ id: 'sig-x', source: 'rb2b', payload: null }, ctx);
  assert.deepEqual(result.reason_codes, ['MALFORMED_PAYLOAD']);
});

// --- HMAC over the payload ----------------------------------------------------------

test('a tampered payload REFUSES with SIGNATURE_INVALID, because the signature no longer covers it', async () => {
  const { ctx } = makeCtx();
  const signal = validSignal();
  signal.payload.company.name = 'Tampered Inc';
  const result = await ingest.run(signal, ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_INVALID']);
});

test('a missing signature REFUSES with SIGNATURE_MISSING when a secret is configured', async () => {
  const { ctx } = makeCtx();
  const signal = validSignal();
  delete signal.signature;
  const result = await ingest.run(signal, ctx);
  assert.deepEqual(result.reason_codes, ['SIGNATURE_MISSING']);
});

test('signPayload is stable across key order, because it signs the canonical form', () => {
  const a = signPayload(SECRET, { b: 1, a: 2 });
  const b = signPayload(SECRET, { a: 2, b: 1 });
  assert.equal(a, b);
});

// --- replay window ------------------------------------------------------------------

test('a signal older than the replay window REFUSES with REPLAY_WINDOW_EXCEEDED', async () => {
  const { ctx } = makeCtx();
  const payload = validPayload();
  const signal = {
    ...validSignal({ payload, received_at: '2026-03-01T08:00:00.000Z' }),
    signature: signPayload(SECRET, payload),
  };
  const result = await ingest.run(signal, ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['REPLAY_WINDOW_EXCEEDED']);
});

test('the replay window check does not consume clock ticks, so it cannot shift the ledger', async () => {
  const { ctx } = makeCtx();
  await ingest.run(validSignal(), ctx);
  assert.equal(ctx.clock.now(), '2026-03-01T09:00:00.000Z');
});

// --- the duplicate-signal hostile fixture -------------------------------------------

test('a signal whose id already passed ingest in the ledger REFUSES with DUPLICATE_SIGNAL', async () => {
  const { ledger, ctx } = makeCtx();
  // A passing ingest entry files under the canonical lead id, not the signal id, so the
  // idempotency lookup keys on the evidence ref that names the signal.
  ledger.append({
    ts: '2026-03-01T08:59:59.000Z',
    run_id: 'run-test',
    lead_id: 'lead-000000000000',
    stage: 'ingest',
    verdict: 'PASS',
    reason_codes: [],
    evidence_refs: ['signal:sig-1'],
    actor: 'system',
  });
  const result = await ingest.run(validSignal(), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['DUPLICATE_SIGNAL']);
});

test('a prior REFUSED ingest for the same id does not count as a duplicate', async () => {
  const { ledger, ctx } = makeCtx();
  ledger.append({
    ts: '2026-03-01T08:59:59.000Z',
    run_id: 'run-test',
    lead_id: 'sig-1',
    stage: 'ingest',
    verdict: 'REFUSE',
    reason_codes: ['SIGNATURE_INVALID'],
    evidence_refs: ['signal:sig-1'],
    actor: 'system',
  });
  const result = await ingest.run(validSignal(), ctx);
  assert.equal(result.status, 'PASS');
});

test('ingest records the signal id as evidence, so the trail names what it read', async () => {
  const { ctx } = makeCtx();
  const result = await ingest.run(validSignal(), ctx);
  assert.deepEqual(result.evidence_refs, ['signal:sig-1']);
});

// --- HMAC over raw bytes, new in M4 -----------------------------------------------------------
//
// M1's divergence register: "the design says HMAC over raw bytes; M1 computes the HMAC over the
// canonical serialisation of the already-parsed payload", and it said live mode "receives real
// request bodies and should verify over the raw bytes it was handed". This is that.
//
// The two are DIFFERENT THREAT MODELS rather than two spellings of one. Hashing the canonical
// parse binds the signature to the payload's MEANING, which survives a reserialisation and trusts
// the parser. Hashing raw bytes binds it to exactly what the sender transmitted, so a parser
// disagreement cannot move the signature. M1 took the first because fixture signals are committed
// as formatted JSON a formatter would otherwise invalidate. Live receives bytes off the wire.
//
// AND THE SECOND HALF IS THE POINT. Verifying bytes and then acting on a parse nobody compared
// against those bytes keeps the threat model's name without its content. Raw mode asserts that the
// parse it was handed agrees with a fresh parse of the same bytes.

import { signRaw } from '../src/stages/ingest.mjs';

function rawCtx(overrides = {}) {
  const ledger = new Ledger();
  return createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: {
      mode: 'live',
      ingest: { secret: SECRET, replayWindowMs: 300000, signatureOver: 'raw', ...overrides },
    },
    run_id: 'run-test',
  });
}

// What a live loader hands the stage: the exact bytes it read, plus the signature that came
// alongside them, plus the parse those bytes produced.
function rawSignal(bytes, signature) {
  const raw = bytes ?? JSON.stringify({
    id: 'sig-1',
    source: 'rb2b',
    received_at: '2026-03-01T08:59:00.000Z',
    payload: validPayload(),
  });
  return { ...JSON.parse(raw), raw, signature: signature ?? signRaw(SECRET, raw) };
}

test('raw mode verifies the HMAC over the exact bytes the sender transmitted', async () => {
  const result = await ingest.run(rawSignal(), rawCtx());
  assert.equal(result.status, 'PASS');
});

test('whitespace anywhere in the bytes changes the signature, which is the whole point', async () => {
  // Under canonical hashing this reserialisation is invisible. Under raw hashing it is a different
  // message, because it IS a different message: the sender sent these bytes and not those.
  const bytes = JSON.stringify(
    { id: 'sig-1', source: 'rb2b', received_at: '2026-03-01T08:59:00.000Z', payload: validPayload() },
    null,
    2,
  );
  const compact = JSON.stringify(JSON.parse(bytes));
  const result = await ingest.run(rawSignal(bytes, signRaw(SECRET, compact)), rawCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_INVALID']);
});

test('a signature valid over the CANONICAL payload is refused in raw mode', async () => {
  const signal = rawSignal();
  signal.signature = signPayload(SECRET, signal.payload);
  const result = await ingest.run(signal, rawCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_INVALID']);
});

test('a parse that disagrees with the bytes it claims to come from is REFUSED', async () => {
  // The second half of the threat model. An attacker who can get one parser to read the bytes one
  // way and this pipeline to act on another reading has defeated a byte-exact signature while
  // leaving it perfectly valid.
  const signal = rawSignal();
  signal.payload = { ...signal.payload, company: { name: 'Harborline', domain: 'harborline.test' } };
  const result = await ingest.run(signal, rawCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_INVALID']);
  assert.match(result.detail, /bytes|parse/i);
});

test('raw mode with no bytes attached REFUSES rather than falling back to canonical hashing', async () => {
  // The silent downgrade this must never become. A loader that forgot to attach the bytes would
  // otherwise get a signature check that passes for a weaker reason than the one configured.
  const signal = rawSignal();
  delete signal.raw;
  const result = await ingest.run(signal, rawCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['SIGNATURE_MISSING']);
  assert.match(result.detail, /raw/i);
});

test('canonical remains the default, so the fixture corpus verifies exactly as it did', async () => {
  const { ctx } = makeCtx();
  assert.equal((await ingest.run(validSignal(), ctx)).status, 'PASS');
});

test('the raw bytes do not travel into the lead, so nothing downstream re-parses them', async () => {
  const result = await ingest.run(rawSignal(), rawCtx());
  assert.equal(result.output.raw, undefined);
  assert.equal(result.output.signature, undefined);
});

test('sources named by the payload travel onto the lead, kept distinct from fetched citations', async () => {
  // Two different things that must not share a name. `sources` is where the signal SAYS the
  // evidence is. `citations` is what enrich actually fetched. Collapsing them would let an
  // unfetched URL read as a citation.
  const { ctx } = makeCtx();
  const payload = { ...validPayload(), sources: ['https://a.test/acme', 'https://b.test/acme'] };
  const result = await ingest.run(validSignal({ payload, signature: signPayload(SECRET, payload) }), ctx);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.output.sources, payload.sources);
  assert.equal(result.output.citations, undefined);
});

test('a payload naming no sources yields an empty list rather than an absent one', async () => {
  const { ctx } = makeCtx();
  const result = await ingest.run(validSignal(), ctx);
  assert.deepEqual(result.output.sources, []);
});
