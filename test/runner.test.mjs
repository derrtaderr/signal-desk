import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadFixtures, computeRunId, executeFixtureRun, FIXTURES_DIR } from '../src/runner.mjs';
import { defaultConfig, pipeline } from '../src/config.mjs';

test('loadFixtures reads every signal file in the corpus', () => {
  const { signals } = loadFixtures();
  const onDisk = readdirSync(join(FIXTURES_DIR, 'signals')).filter((f) => f.endsWith('.json'));
  assert.equal(signals.length, onDisk.length);
  assert.ok(signals.length >= 6, 'the corpus carries the happy path and the hostile fixtures');
});

test('loadFixtures reads signals in sorted filename order, not filesystem order', () => {
  const { signals } = loadFixtures();
  const ids = signals.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 4), ['sig-1001', 'sig-1002', 'sig-1003', 'sig-1004']);
});

test('loadFixtures reads the recordings and the recorded approvals', () => {
  const { recordings, approvals } = loadFixtures();
  assert.ok(Object.keys(recordings).length > 0);
  assert.ok(approvals.length > 0);
});

test('the run id is derived from the inputs, never generated randomly', () => {
  const fixtures = loadFixtures();
  const a = computeRunId({ pipeline, config: defaultConfig, signals: fixtures.signals });
  const b = computeRunId({ pipeline, config: defaultConfig, signals: fixtures.signals });
  assert.equal(a, b);
  assert.match(a, /^run-[0-9a-f]{12}$/);
});

test('changing a signal changes the run id, so a run names its own inputs', () => {
  const fixtures = loadFixtures();
  const changed = fixtures.signals.map((s, i) => (i === 0 ? { ...s, id: 'different' } : s));
  assert.notEqual(
    computeRunId({ pipeline, config: defaultConfig, signals: fixtures.signals }),
    computeRunId({ pipeline, config: defaultConfig, signals: changed }),
  );
});

test('changing the stage sequence changes the run id', () => {
  const fixtures = loadFixtures();
  assert.notEqual(
    computeRunId({ pipeline, config: defaultConfig, signals: fixtures.signals }),
    computeRunId({ pipeline: pipeline.slice(0, 4), config: defaultConfig, signals: fixtures.signals }),
  );
});

test('the fixture run reaches a terminal state for every signal in the corpus', async () => {
  const { report } = await executeFixtureRun();
  const { signals } = loadFixtures();
  assert.equal(report.summary.total, signals.length);
});

test('the fixture run exercises all three verdicts, so the demo shows the whole contract', async () => {
  const { report } = await executeFixtureRun();
  assert.ok(report.summary.PASS >= 1, 'at least one lead reaches handoff');
  assert.ok(report.summary.REFUSE >= 1, 'at least one lead is refused');
  assert.ok(report.summary.NEEDS_HUMAN >= 1, 'at least one lead parks for a human');
});

test('every one of the eight stages executes at least once in the fixture run', async () => {
  const { ledger } = await executeFixtureRun();
  const stagesSeen = new Set(ledger.entries().map((e) => e.stage));
  for (const stage of pipeline) {
    assert.ok(stagesSeen.has(stage.name), `stage ${stage.name} ran in the fixture demo`);
  }
});

test('the fixture run is keyless: nothing reads an environment variable for a credential', async () => {
  const before = { ...process.env };
  await executeFixtureRun();
  assert.deepEqual({ ...process.env }, before);
});

test('the ledger the run produced verifies as an unbroken chain', async () => {
  const { ledger } = await executeFixtureRun();
  const { verifyChain } = await import('../src/ledger.mjs');
  assert.deepEqual(verifyChain(ledger.entries()), { ok: true });
});

test('a lead that reaches handoff carries a dry-run artifact that was not sent', async () => {
  const { report } = await executeFixtureRun();
  const delivered = report.leads.filter((l) => l.final_status === 'PASS');
  assert.ok(delivered.length >= 1);
  for (const lead of delivered) {
    assert.equal(lead.output.handoff.sent, false);
    assert.equal(lead.output.handoff.artifact.dry_run, true);
  }
});

test('the committed fixtures match what the generator produces', async () => {
  // Freshness. Editing a signal by hand without re-signing it, or editing the generator
  // without regenerating, fails here in the commit that caused it.
  const { fixtureFiles } = await import('../scripts/fixture-data.mjs');
  for (const [relativePath, expected] of fixtureFiles()) {
    const onDisk = JSON.parse(readFileSync(join(FIXTURES_DIR, relativePath), 'utf8'));
    assert.deepEqual(onDisk, expected, `fixtures/${relativePath} is up to date`);
  }
});

test('the generator accounts for every file in the fixture corpus', async () => {
  const { fixtureFiles } = await import('../scripts/fixture-data.mjs');
  const generated = new Set(fixtureFiles().map(([path]) => path));
  const onDisk = readdirSync(join(FIXTURES_DIR, 'signals'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => `signals/${f}`);
  for (const path of onDisk) {
    assert.ok(generated.has(path), `fixtures/${path} is accounted for by the generator`);
  }
});

test('every committed signal carries a signature that covers its payload', async () => {
  const { signals } = loadFixtures();
  const { signPayload } = await import('../src/stages/ingest.mjs');
  const { FIXTURE_SECRET } = await import('../src/config.mjs');
  for (const signal of signals) {
    assert.equal(
      signal.signature,
      signPayload(FIXTURE_SECRET, signal.payload),
      `signal ${signal.id} is correctly signed`,
    );
  }
});

test('every recorded approval binds to a draft hash, never to a lead id', async () => {
  // The M2 shape. M1's lead-keyed map is what let one decision release a draft nobody read.
  const { approvals } = loadFixtures();
  assert.ok(Array.isArray(approvals), 'the decision store is a list of records');
  assert.ok(approvals.length > 0);
  for (const record of approvals) {
    assert.match(record.draft_hash, /^draft-[0-9a-f]{16}$/, 'bound to content');
    assert.match(record.lead_id, /^lead-[0-9a-f]{12}$/, 'and recording the lead it was about');
    assert.ok(['approve', 'reject'].includes(record.decision));
    assert.ok(typeof record.by === 'string' && record.by !== '');
  }
});

test('every recorded decision names a draft this run actually composed', async () => {
  const { approvals } = loadFixtures();
  const { report } = await executeFixtureRun();
  const composed = new Map(
    report.leads
      .filter((l) => l.output?.draft_hash !== undefined)
      .map((l) => [l.output.draft_hash, l.lead_id]),
  );
  for (const record of approvals) {
    assert.ok(composed.has(record.draft_hash), `decision ${record.draft_hash} matches a real draft`);
    assert.equal(composed.get(record.draft_hash), record.lead_id, 'and the lead it names');
  }
});

test('the committed approvals match what the recorder produces', async () => {
  // Freshness. Decisions are bound to draft hashes, so a template edit strands every one of
  // them. Regenerate with `node scripts/record-approvals.mjs` in the same commit.
  const { recordApprovals } = await import('../scripts/record-approvals.mjs');
  const { serializeFixture } = await import('../scripts/draft-corpus.mjs');
  assert.equal(
    readFileSync(join(FIXTURES_DIR, 'approvals.json'), 'utf8'),
    serializeFixture(await recordApprovals()),
    'fixtures/approvals.json is stale. Run `node scripts/record-approvals.mjs`.',
  );
});

test('the fixture corpus files are valid JSON with a trailing newline', () => {
  const dir = join(FIXTURES_DIR, 'signals');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.ok(text.endsWith('\n'), `${name} ends with a newline`);
    JSON.parse(text);
  }
});

test('the committed rubric recordings match what the recorder produces', async () => {
  // Freshness, the same discipline as the golden ledger. A rubric recording is addressed by
  // draft hash, so changing a template by one character moves every hash and strands every
  // recording. Regenerate with `node scripts/record-rubric.mjs` in the same commit.
  const { recordRubric, serializeRubric } = await import('../scripts/record-rubric.mjs');
  const onDisk = readFileSync(join(FIXTURES_DIR, 'rubric.json'), 'utf8');
  assert.equal(
    onDisk,
    serializeRubric(await recordRubric()),
    'fixtures/rubric.json is stale. Run `node scripts/record-rubric.mjs` in the commit that staled it.',
  );
});

test('every draft that reaches the gate has a rubric recording addressed to its own hash', async () => {
  // The property that makes the rubric meaningful rather than decorative: a recorded verdict
  // exists for this exact draft, not for the lead that happens to carry it.
  const { ledger, report } = await executeFixtureRun();
  const { recordings } = loadFixtures();
  const endpoint = defaultConfig.gate.rubric.endpoint;

  const reachedGate = ledger.entries().filter((e) => e.stage === 'gate');
  assert.ok(reachedGate.length > 0, 'the demo exercises the gate');

  for (const lead of report.leads) {
    if (lead.output?.draft_hash === undefined) continue;
    const url = `${endpoint}/${lead.output.draft_hash}`;
    assert.ok(recordings[url], `a judge response is recorded for ${url}`);
    assert.equal(
      recordings[url].body.draft_hash,
      lead.output.draft_hash,
      'and it names the draft it judged',
    );
  }
});
