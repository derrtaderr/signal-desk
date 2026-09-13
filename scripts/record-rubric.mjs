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

import { FIXTURES_DIR } from '../src/runner.mjs';
import { defaultConfig } from '../src/config.mjs';
import { composeDrafts, serializeFixture } from './draft-corpus.mjs';

// What the recorded judge says about each lead, keyed by the contact it is written to. A lead
// absent from this table is judged clean. This table is the ONLY place a fixture's rubric
// outcome is decided, so a reader can see at a glance which hostile fixture exists to exercise
// which refusal.
const JUDGMENTS = {
  'dana@acme.test': { verdict: 'PASS' },
  'sam@northwind.test': { verdict: 'PASS' },
  'robin@globex.test': { verdict: 'PASS' },
  'morgan@vertex.test': { verdict: 'PASS' },
  'chris@orbital.test': { verdict: 'PASS' },

  // The rubric-failure fixture. Every deterministic rule passes this draft: it is grounded,
  // well formed, free of PII and within length. It is simply the wrong message for this reader,
  // and no regex is going to notice that. This is what the judge is for.
  'priya@halcyon.test': {
    verdict: 'FAIL',
    fails: {
      audience_fit:
        'the draft pitches a revenue-operations play to a VP Engineering, whose team is not the buyer for it',
    },
  },
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
  const drafts = await composeDrafts();
  const endpoint = defaultConfig.gate.rubric.endpoint;
  const recordings = {};

  for (const draft of drafts) {
    const judgment = JUDGMENTS[draft.to] ?? { verdict: 'PASS' };
    const criteria = criteriaFor(judgment);
    // The overall line agrees with the criteria rather than being stated independently, so a
    // recording can never be internally inconsistent by accident.
    const verdict = criteria.some((c) => c.verdict === 'FAIL') ? 'FAIL' : judgment.verdict;

    recordings[`${endpoint}/${draft.draft_hash}`] = {
      status: 200,
      body: { draft_hash: draft.draft_hash, verdict, criteria },
    };
  }

  return recordings;
}

// Sorted keys, so regenerating produces a stable diff.
export function serializeRubric(recordings) {
  const sorted = {};
  for (const key of Object.keys(recordings).sort()) sorted[key] = recordings[key];
  return serializeFixture(sorted);
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
