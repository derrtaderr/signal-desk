import test from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../src/stages/route.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from '../src/context.mjs';

function lead(total) {
  return {
    lead_id: 'lead-abc123456789',
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    claims: [],
    citations: [],
    score: { total, factors: [{ name: 'title_seniority', points: total, reason: 'x', evidence_refs: [] }] },
  };
}

function makeCtx() {
  return createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: {
      mode: 'fixture',
      route: {
        floor: 40,
        // Ordered high to low; the first band the score clears wins.
        bands: [
          { name: 'priority', min: 80, owner: 'ae-round-robin', play: 'executive-intro' },
          { name: 'standard', min: 40, owner: 'sdr-queue', play: 'problem-first' },
        ],
      },
    },
    run_id: 'run-test',
  });
}

test('a high score routes to the priority band', async () => {
  const result = await route.run(lead(95), makeCtx());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.route.band, 'priority');
  assert.equal(result.output.route.owner, 'ae-round-robin');
  assert.equal(result.output.route.play, 'executive-intro');
});

test('a middling score routes to the standard band', async () => {
  const { output } = await route.run(lead(55), makeCtx());
  assert.equal(output.route.band, 'standard');
  assert.equal(output.route.play, 'problem-first');
});

test('a score below the floor REFUSES with BELOW_ROUTING_FLOOR', async () => {
  const result = await route.run(lead(12), makeCtx());
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['BELOW_ROUTING_FLOOR']);
});

test('the refusal says what the score was and what the floor is', async () => {
  const result = await route.run(lead(12), makeCtx());
  assert.match(result.detail, /12/);
  assert.match(result.detail, /40/);
});

test('a score exactly at a band minimum clears it, so the boundary is not ambiguous', async () => {
  const { output } = await route.run(lead(80), makeCtx());
  assert.equal(output.route.band, 'priority');
});

test('a score exactly at the floor is routed, not refused', async () => {
  const result = await route.run(lead(40), makeCtx());
  assert.equal(result.status, 'PASS');
  assert.equal(result.output.route.band, 'standard');
});

test('the routing decision carries the reason it was made', async () => {
  const { output } = await route.run(lead(95), makeCtx());
  assert.match(output.route.reason, /95/);
  assert.match(output.route.reason, /priority/);
});

test('routing is deterministic: the same score routes the same way twice', async () => {
  const a = await route.run(lead(55), makeCtx());
  const b = await route.run(lead(55), makeCtx());
  assert.deepEqual(a.output.route, b.output.route);
});

test('a lead that clears the floor but matches no band REFUSES rather than guessing an owner', async () => {
  const ctx = createContext({
    ledger: new Ledger(),
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: recordedFetcher({}),
    config: { mode: 'fixture', route: { floor: 10, bands: [{ name: 'top', min: 900, owner: 'x', play: 'y' }] } },
    run_id: 'run-test',
  });
  const result = await route.run(lead(50), ctx);
  assert.equal(result.status, 'REFUSE');
  assert.deepEqual(result.reason_codes, ['NO_MATCHING_BAND']);
});
