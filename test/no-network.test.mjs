// The no-socket gate. M4 spec §10.
//
// M1 through M3 were offline by construction: nothing in the repo could open a socket because
// nothing in the repo knew how. M4 changes that, and the promise "a fresh clone's suite needs no
// key and no network" stops being structural the moment a real transport exists.
//
// So it is asserted instead. These checks are STATIC — they read the source rather than watching
// the runtime — which is deliberate: a runtime socket guard only fires on the paths a test
// happened to walk, and the property being protected is about every path, including the ones
// nobody wrote a test for yet.
//
// A test that genuinely needs a socket has to edit this file to get one. That is the mechanism.
// It cannot be satisfied by remembering, and it fails in the same commit as the mistake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// This file names the forbidden module and the forbidden global in order to forbid them, so it
// excludes itself. A gate that trips on its own text is a gate nobody can write.
const SELF = fileURLToPath(import.meta.url);

const testFiles = walk(join(ROOT, 'test')).filter((file) => file.endsWith('.mjs') && file !== SELF);
const srcFiles = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.mjs'));

// The keyed smoke test is the one deliberate exception, and it is double-gated at runtime
// (SIGNAL_DESK_LIVE_SMOKE plus a key) rather than exempted from the rule in spirit.
const SMOKE = 'live-smoke.test.mjs';

test('no test imports the module that builds a real transport', () => {
  const offenders = [];
  for (const file of testFiles) {
    if (file.endsWith(SMOKE)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('node-transport')) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(
    offenders,
    [],
    'src/live/node-transport.mjs is the only thing that reaches the network, and no test may import it',
  );
});

test('no test hands a live transport the real global fetch', () => {
  // The other way to get a socket: pass globalThis.fetch into createLiveFetcher or createLiveModel
  // directly, bypassing node-transport.mjs entirely.
  const offenders = [];
  for (const file of testFiles) {
    if (file.endsWith(SMOKE)) continue;
    const text = readFileSync(file, 'utf8');
    if (/transport\s*:\s*(globalThis\.)?fetch\b/.test(text)) offenders.push(relative(ROOT, file));
    if (/createLive(Fetcher|Model)\s*\(\s*\{\s*\}\s*\)/.test(text) === false && /globalThis\.fetch/.test(text)) {
      offenders.push(`${relative(ROOT, file)} names globalThis.fetch`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no test names a real provider host, so nothing can resolve by accident', () => {
  // Every fixture and every fake in this repo uses a reserved test domain. A real hostname in a
  // test file is either a live call or a test that would become one after a small edit.
  const forbidden = [/\bapi\.anthropic\.com\b/, /\bapi\.openai\.com\b/];
  const offenders = [];
  for (const file of testFiles) {
    if (file.endsWith(SMOKE)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) offenders.push(`${relative(ROOT, file)} names ${pattern.source}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('both live transports refuse to be constructed without an injected transport', async () => {
  // The runtime half of the same property, asserted here rather than only in each transport's own
  // file, because this is where a reader comes to find out whether the offline promise is real.
  const { createLiveFetcher } = await import('../src/live/http.mjs');
  const { createLiveModel } = await import('../src/live/anthropic.mjs');

  assert.throws(() => createLiveFetcher({ readClock: () => 'x' }), TypeError);
  assert.throws(() => createLiveModel({ key: 'k' }), TypeError);
});

test('only node-transport.mjs touches globalThis.fetch anywhere under src/', () => {
  const offenders = [];
  for (const file of srcFiles) {
    if (file.endsWith(join('live', 'node-transport.mjs'))) continue;
    const text = readFileSync(file, 'utf8');
    // Comments explaining the rule are fine; code calling it is not.
    for (const line of text.split('\n')) {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/globalThis\.fetch|\bnode:https?\b|\bnode:net\b/.test(code)) {
        offenders.push(`${relative(ROOT, file)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the CLI is the only module that imports node-transport', () => {
  // Deferred from the commit that created this gate, because the CLI had not yet been wired and a
  // commit should not end on a red test. It is asserted now that live mode exists: exactly one
  // module may reach the network, and this is the check that keeps the list at one.
  const importers = srcFiles.filter((file) => {
    if (file.endsWith(join('live', 'node-transport.mjs'))) return false;
    return /from\s+['"][^'"]*node-transport\.mjs['"]/.test(readFileSync(file, 'utf8'));
  });
  assert.deepEqual(
    importers.map((file) => relative(ROOT, file)),
    ['src/cli.mjs'],
  );
});
