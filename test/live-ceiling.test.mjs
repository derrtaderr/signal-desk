// The lead ceiling in the live config, and through the live run builder. docs/LEAD-CEILING-SPEC.md.
//
// Keyless: the fetcher and the model are stand-ins that count their calls, so "the ceiling stopped
// the billing" is a number asserted rather than a claim. No socket is opened.

import test from 'node:test';
import assert from 'node:assert/strict';

import { liveConfig, DEFAULT_MAX_LEADS, parseMaxLeads } from '../src/live/config.mjs';
import { buildLiveRun, buildReplayRun } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { recordingClock } from '../src/context.mjs';
import { publicConfig } from '../src/live/keys.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const SECRET = 'ceiling-test-secret';

test('the live config carries a ceiling by default, counted from the first billing stage', () => {
  assert.equal(DEFAULT_MAX_LEADS, 10);
  const config = liveConfig({ secret: SECRET, startedAt: '2026-10-05T09:00:00.000Z' });
  assert.deepEqual(config.limits, { maxLeads: 10, countedFrom: 'enrich' });
});

test('the live config takes a ceiling sized for this run', () => {
  const config = liveConfig({ secret: SECRET, startedAt: '2026-10-05T09:00:00.000Z', maxLeads: 3 });
  assert.equal(config.limits.maxLeads, 3);
});

test('a ceiling value is a plain positive integer or it is refused', () => {
  assert.equal(parseMaxLeads('1'), 1);
  assert.equal(parseMaxLeads('25'), 25);
  for (const bad of [undefined, '', '0', '-1', '1.5', '10abc', '1e3', '0x10', ' 5', 'ten', '--signals', '007x']) {
    assert.throws(
      () => parseMaxLeads(bad),
      (error) => error.code === 'LEAD_CEILING_INVALID' && /--max-leads/.test(error.message),
      `${JSON.stringify(bad)} should refuse`,
    );
  }
});

// --- through the live run builder, more leads than the ceiling ---------------------------------

function signed(id, domain) {
  const signal = {
    id,
    source: 'rb2b',
    received_at: '2026-10-05T08:59:00.000Z',
    payload: {
      company: { name: `Company ${id}`, domain },
      contact: { name: 'Pat Example', email: `pat@${domain}`, title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 3 },
      sources: [`https://${domain}/about`],
    },
  };
  const raw = JSON.stringify(signal);
  return { ...signal, raw, signature: signRaw(SECRET, raw), source_file: `${id}.json` };
}

async function overCeilingRun() {
  const fetched = [];
  const modelCalls = [];
  const signals = [signed('a1', 'one.example.com'), signed('a2', 'two.example.com'), signed('a3', 'three.example.com')];
  const config = liveConfig({ secret: SECRET, startedAt: '2026-10-05T09:00:00.000Z', maxLeads: 1 });

  let tick = 0;
  const clock = recordingClock({ read: () => new Date(Date.parse('2026-10-05T09:00:00.000Z') + 1000 * tick++).toISOString() });
  const { ledger, ctx, stages, capture, config: runConfig, recordingsSeed } = buildLiveRun({
    signals,
    config,
    clock,
    fetch: async (url) => {
      fetched.push(url);
      return { status: 404, body: {}, fetched_at: '2026-10-05T09:00:00.000Z' };
    },
    model: async (request) => {
      modelCalls.push(request);
      throw new Error('the model is not reached in this test');
    },
  });
  const report = await runPipeline({ stages, signals, ctx, ledger });
  const inputs = {
    config: publicConfig(runConfig),
    signals,
    recordings: capture,
    recordings_seed: recordingsSeed,
    clock: clock.readings(),
  };
  return { fetched, modelCalls, report, ledger, inputs, runConfig };
}

test('a live run handed more leads than its ceiling fetches nothing for the leads over it', async () => {
  const { fetched, report } = await overCeilingRun();
  assert.deepEqual(fetched, ['https://one.example.com/about'], 'only the admitted lead reached the network');

  const refused = report.leads.filter((lead) => lead.reason_codes.includes('LEAD_CEILING_REACHED'));
  assert.equal(refused.length, 2, 'both leads over the ceiling are refused, by name, in the report');
  assert.ok(refused.every((lead) => lead.final_stage === 'enrich'));
});

test('a ceiling refusal replays byte for byte, because the ceiling travels in the capture', async () => {
  const { ledger, inputs, runConfig } = await overCeilingRun();
  assert.equal(inputs.config.limits.maxLeads, 1, 'the capture records the ceiling the run executed under');

  // The CLI's replay resolves the signing secret back from the environment, because the capture
  // holds only its fingerprint. Done here by hand, with everything else taken from the capture.
  const replay = buildReplayRun({ ...inputs, config: { ...inputs.config, ingest: runConfig.ingest } });
  await runPipeline({ stages: replay.stages, signals: replay.signals, ctx: replay.ctx, ledger: replay.ledger });
  assert.equal(replay.ledger.toJSONL(), ledger.toJSONL());
});
