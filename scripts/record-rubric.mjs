#!/usr/bin/env node
// Regenerates fixtures/rubric.json, the recorded judge responses the gate's LLM rubric reads
// in fixture mode. Run with `node scripts/record-rubric.mjs`.
//
// WHY THIS IS GENERATED RATHER THAN HAND-WRITTEN, and why it lives beside recordings.json
// instead of inside it.
//
// A rubric recording is addressed BY DRAFT HASH, so that a recorded verdict cannot authorise a
// draft it was never about. That makes the file DERIVED from whatever drafts the pipeline
// currently composes, exactly like test/golden/fixture-run.jsonl is derived from the decisions
// it currently makes. Change a template by one character and every hash moves, which is the
// property that makes the binding worth having and also the property that makes hand-editing
// this file hopeless. fixtures/recordings.json stays hand-authored source data; this file is
// output, regenerated in the same commit as whatever moved it, and a test compares the two.
//
// The chicken-and-egg is resolved by running only the stages BEFORE the gate. The gate is what
// needs the recordings, so the recorder never runs it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, buildRun, FIXTURES_DIR } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { ingest } from '../src/stages/ingest.mjs';
import { enrich } from '../src/stages/enrich.mjs';
import { score } from '../src/stages/score.mjs';
import { route } from '../src/stages/route.mjs';
import { draft } from '../src/stages/draft.mjs';
import { defaultConfig } from '../src/config.mjs';

// Everything up to, but not including, the gate.
const UP_TO_DRAFT = [ingest, enrich, score, route, draft];

// What the recorded judge says about each lead, keyed by the contact it is written to. A lead
// absent from this table is judged clean. This table is the ONLY place a fixture's rubric
// outcome is decided, so a reader can see at a glance which hostile fixture exists to exercise
// which refusal.
const JUDGMENTS = {
  'dana@acme.test': { verdict: 'PASS' },
  'sam@northwind.test': { verdict: 'PASS' },
  'robin@globex.test': { verdict: 'PASS' },
};

const CLEAN_NOTES = {
  claim_grounding: 'every factual assertion in the body traces to a source fetched this run',
  audience_fit: 'the message addresses the operator who owns the problem it names',
  tone: 'a question rather than a pitch, and no manufactured urgency',
};

function criteriaFor(judgment) {
  return defaultConfig.gate.rubric.requiredCriteria.map((name) => {
    const failing = judgment.fails?.[name];
    return failing === undefined
      ? { name, verdict: 'PASS', note: CLEAN_NOTES[name] }
      : { name, verdict: 'FAIL', note: failing };
  });
}

export async function recordRubric() {
  const fixtures = loadFixtures();
  // Build with the real config but the truncated stage list, so drafts are composed exactly as
  // the full pipeline composes them.
  const built = buildRun({ fixtures, stages: UP_TO_DRAFT });
  const report = await runPipeline({
    stages: UP_TO_DRAFT,
    signals: built.signals,
    ctx: built.ctx,
    ledger: built.ledger,
  });

  const endpoint = defaultConfig.gate.rubric.endpoint;
  const recordings = {};

  for (const lead of report.leads) {
    if (lead.final_status !== 'PASS' || lead.output?.draft_hash === undefined) continue;

    const judgment = JUDGMENTS[lead.output.draft.to] ?? { verdict: 'PASS' };
    const criteria = criteriaFor(judgment);
    // The overall line agrees with the criteria rather than being stated independently, so a
    // recording can never be internally inconsistent by accident.
    const verdict = criteria.some((c) => c.verdict === 'FAIL') ? 'FAIL' : judgment.verdict;

    recordings[`${endpoint}/${lead.output.draft_hash}`] = {
      status: 200,
      body: { draft_hash: lead.output.draft_hash, verdict, criteria },
    };
  }

  return recordings;
}

// Sorted keys and a trailing newline, so regenerating produces a stable diff.
export function serializeRubric(recordings) {
  const sorted = {};
  for (const key of Object.keys(recordings).sort()) sorted[key] = recordings[key];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const recordings = await recordRubric();
  const path = join(FIXTURES_DIR, 'rubric.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRubric(recordings));

  console.log('wrote fixtures/rubric.json');
  for (const [url, recording] of Object.entries(recordings)) {
    console.log(`  ${recording.body.verdict.padEnd(4)} ${url}`);
  }
}
