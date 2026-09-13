#!/usr/bin/env node
// Writes the fixture corpus to disk. The data itself lives in scripts/fixture-data.mjs, so
// a test can compare the committed files against it without triggering a write.
//
// Run with `node scripts/make-fixtures.mjs`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureFiles } from './fixture-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

const written = [];
for (const [relativePath, value] of fixtureFiles()) {
  const target = join(fixturesDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  written.push(relativePath);
}

console.log(`wrote ${written.length} fixture files:`);
for (const path of written) console.log(`  fixtures/${path}`);
