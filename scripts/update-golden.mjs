#!/usr/bin/env node
// Regenerates the golden ledger. Run with `npm run golden:update`.
//
// The golden file is committed in the SAME commit as the behaviour change that moved it.
// A diff on this file is the review surface for "what did that change actually do to the
// decisions", which is the whole reason it exists.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeFixtureRun } from '../src/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, '..', 'test', 'golden', 'fixture-run.jsonl');

const { ledger, run_id } = await executeFixtureRun();

mkdirSync(dirname(goldenPath), { recursive: true });
writeFileSync(goldenPath, ledger.toJSONL());

console.log(`wrote test/golden/fixture-run.jsonl`);
console.log(`  run id   ${run_id}`);
console.log(`  entries  ${ledger.entries().length}`);
console.log(`  head     ${ledger.head()}`);
