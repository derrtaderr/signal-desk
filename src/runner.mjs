// The fixture runner. Loads the corpus, derives the run id from the inputs, builds the
// context, and executes the pipeline.
//
// This module reads files. Stages do not. Keeping the I/O here is what lets every stage be
// tested with a plain object and what lets the whole run be reproduced from the corpus.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { canonical } from './canonical.mjs';
import { Ledger } from './ledger.mjs';
import { createContext, fixtureClock, recordedFetcher } from './context.mjs';
import { runPipeline } from './kernel.mjs';
import { defaultConfig, pipeline } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadFixtures(dir = FIXTURES_DIR) {
  // Sorted, because filesystem order is not a specification and a run that depends on it
  // is a run that replays differently on a different machine.
  const signalFiles = readdirSync(join(dir, 'signals'))
    .filter((name) => name.endsWith('.json'))
    .sort();

  return {
    signals: signalFiles.map((name) => readJson(join(dir, 'signals', name))),
    recordings: readJson(join(dir, 'recordings.json')),
    approvals: readJson(join(dir, 'approvals.json')),
  };
}

// Derived, never random. Two runs over the same corpus and the same wiring share a run id,
// which is precisely what lets their ledgers be compared byte for byte.
export function computeRunId({ pipeline: stages, config, signals }) {
  const digest = createHash('sha256')
    .update(
      canonical({
        stages: stages.map((stage) => stage.name),
        config,
        signals,
      }),
    )
    .digest('hex');
  return `run-${digest.slice(0, 12)}`;
}

export function buildRun({ fixtures = loadFixtures(), config = defaultConfig, stages = pipeline } = {}) {
  // The recorded approvals are folded into the config the queue stage reads. They are an M1
  // stand-in for the approval workflow, and they are part of the run's inputs, so they are
  // part of what the run id covers.
  const runConfig = {
    ...config,
    queue: { ...config.queue, approvals: fixtures.approvals },
  };

  const run_id = computeRunId({ pipeline: stages, config: runConfig, signals: fixtures.signals });
  const ledger = new Ledger();
  const ctx = createContext({
    ledger,
    clock: fixtureClock(runConfig.clock),
    fetch: recordedFetcher(fixtures.recordings),
    config: runConfig,
    run_id,
  });

  return { run_id, ledger, ctx, stages, signals: fixtures.signals };
}

export async function executeFixtureRun(options = {}) {
  const { run_id, ledger, ctx, stages, signals } = buildRun(options);
  const report = await runPipeline({ stages, signals, ctx, ledger });
  return { run_id, ledger, report };
}
