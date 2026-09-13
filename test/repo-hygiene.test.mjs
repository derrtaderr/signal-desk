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

const sourceFiles = ['src', 'test', 'scripts', 'bin'].flatMap((dir) => {
  try {
    return walk(join(ROOT, dir));
  } catch {
    return [];
  }
});

// This test exists because of a real bug. A NUL byte landed inside a template literal in
// src/stages/ingest.mjs, silently changing a hash separator from a space to a byte no
// editor renders. Two identical-looking functions produced different digests, and grep refused
// to search the file at all because it looked binary. Invisible characters cost an hour
// once; they cost one test run from now on.
test('no source file contains a control character outside tab and newline', () => {
  const offenders = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      const isAllowed = code === 9 || code === 10 || code === 13;
      if (code < 32 && !isAllowed) {
        offenders.push(`${relative(ROOT, file)} contains U+${code.toString(16).padStart(4, '0')}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the repo declares no runtime and no dev dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {}, 'zero runtime dependencies');
  assert.deepEqual(pkg.devDependencies, {}, 'zero dev dependencies');
});

test('nothing is installed into node_modules that the tests depend on', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});

test('no module under src/ imports a package outside node builtins', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      const isRelative = specifier.startsWith('.');
      const isBuiltin = specifier.startsWith('node:');
      if (!isRelative && !isBuiltin) offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Stages reach the outside world through ctx and nowhere else. That is what makes a fixture
// run reproducible, and it is easier to assert than to remember.
test('no stage imports a filesystem, network or process module', () => {
  const forbidden = ['node:fs', 'node:http', 'node:https', 'node:net', 'node:child_process'];
  const offenders = [];
  for (const file of walk(join(ROOT, 'src', 'stages'))) {
    const text = readFileSync(file, 'utf8');
    for (const specifier of forbidden) {
      if (text.includes(`'${specifier}'`)) offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no stage reads the wall clock or calls global fetch directly', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src', 'stages'))) {
    const text = readFileSync(file, 'utf8');
    if (/\bDate\.now\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} calls Date.now()`);
    if (/\bnew Date\s*\(\s*\)/.test(text)) offenders.push(`${relative(ROOT, file)} calls new Date()`);
    if (/(?<!ctx\.)\bfetch\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} calls fetch() directly`);
  }
  assert.deepEqual(offenders, []);
});

test('no stage reads process.env, so fixture mode cannot depend on machine state', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src', 'stages'))) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('process.env')) offenders.push(`${relative(ROOT, file)} reads process.env`);
  }
  assert.deepEqual(offenders, []);
});
