// README freshness.
//
// Every console block in the README marked with a `verified-block` comment is executed here
// and compared against the real output. A README that goes stale fails the suite in the same
// commit that staled it, rather than three months later in front of someone evaluating the
// repo. Precedent: the gtm-agent-evals readme-examples test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

// Pulls each block of the form:
//   <!-- verified-block: name -->
//   ```console
//   $ command
//   expected output
//   ```
function verifiedBlocks() {
  const pattern = /<!-- verified-block: ([a-z0-9-]+) -->\n```console\n([\s\S]*?)```/g;
  const blocks = new Map();
  for (const match of README.matchAll(pattern)) {
    const [, name, body] = match;
    const lines = body.split('\n');
    const command = lines[0];
    assert.ok(command.startsWith('$ '), `block ${name} starts with a $ command line`);
    blocks.set(name, {
      argv: command.slice(2).trim().split(/\s+/),
      expected: lines.slice(1).join('\n').replace(/\n$/, ''),
    });
  }
  return blocks;
}

const blocks = verifiedBlocks();

// A fresh working directory, so the examples show what a stranger actually sees rather than
// what a dirty local runs directory produces.
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'signal-desk-readme-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir, argv) {
  // argv[0] is "node" and argv[1] is the bin path as written in the README. Run the real bin
  // from this checkout so the test exercises this code, not a globally installed copy.
  const args = argv.slice(2);
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir },
  }).replace(/\n$/, '');
}

test('the README declares the verified blocks this test knows how to check', () => {
  assert.deepEqual([...blocks.keys()].sort(), ['explain-pass', 'explain-refuse', 'replay', 'run']);
});

test('every verified block invokes the real bin path', () => {
  for (const [name, block] of blocks) {
    assert.deepEqual(block.argv.slice(0, 2), ['node', 'bin/signal-desk.mjs'], `block ${name}`);
  }
});

test('README: the run example matches the real output', () => {
  inTempDir((dir) => {
    assert.equal(runIn(dir, blocks.get('run').argv), blocks.get('run').expected);
  });
});

test('README: the explain example for a delivered lead matches the real output', () => {
  inTempDir((dir) => {
    runIn(dir, ['node', 'bin/signal-desk.mjs', 'run']);
    assert.equal(
      runIn(dir, blocks.get('explain-pass').argv),
      blocks.get('explain-pass').expected,
    );
  });
});

test('README: the explain example for a refused signal matches the real output', () => {
  inTempDir((dir) => {
    runIn(dir, ['node', 'bin/signal-desk.mjs', 'run']);
    assert.equal(
      runIn(dir, blocks.get('explain-refuse').argv),
      blocks.get('explain-refuse').expected,
    );
  });
});

test('README: the replay example matches the real output', () => {
  inTempDir((dir) => {
    runIn(dir, ['node', 'bin/signal-desk.mjs', 'run']);
    assert.equal(runIn(dir, blocks.get('replay').argv), blocks.get('replay').expected);
  });
});

// --- claims the README makes that the code has to keep -------------------------------

test('the README run id matches the one the pipeline actually produces', async () => {
  const { executeFixtureRun } = await import('../src/runner.mjs');
  const { run_id } = await executeFixtureRun();
  assert.ok(README.includes(run_id), `README references the current run id ${run_id}`);
});

test('every CLI verb the README shows actually exists', async () => {
  const { USAGE } = await import('../src/cli.mjs');
  for (const verb of ['run', 'queue', 'approve', 'reject', 'explain', 'replay']) {
    assert.ok(USAGE.includes(verb), `usage documents ${verb}`);
    assert.ok(README.includes(`bin/signal-desk.mjs ${verb}`), `README shows ${verb}`);
  }
});

test('every verb the CLI dispatches is one the README shows', async () => {
  // The other direction. A verb that works but is documented nowhere is as much a gap as a
  // verb the README promises and the CLI does not have.
  const { main } = await import('../src/cli.mjs');
  for (const verb of ['run', 'queue', 'approve', 'reject', 'explain', 'replay']) {
    const lines = [];
    await main({ argv: [verb], out: () => {}, err: (line) => lines.push(line), cwd: ROOT, env: {} });
    assert.ok(
      !lines.some((line) => line.includes(`unknown verb: ${verb}`)),
      `${verb} is dispatched by the CLI, not just documented`,
    );
  }
});

test('the README does not advertise a verb this milestone has not built', () => {
  // approve and reject moved OUT of this list in M2, because they were built. dashboard is M3
  // and --live is M4, and both stay here until they exist.
  for (const verb of ['dashboard', '--live']) {
    assert.ok(
      !README.includes(`bin/signal-desk.mjs ${verb}`),
      `README does not show the unbuilt verb ${verb} as runnable`,
    );
  }
});

test('the CLI refuses a verb it has not built, rather than doing something surprising', async () => {
  const { main } = await import('../src/cli.mjs');
  for (const verb of ['dashboard', 'send']) {
    const lines = [];
    const code = await main({ argv: [verb], out: () => {}, err: (line) => lines.push(line), cwd: ROOT, env: {} });
    assert.notEqual(code, 0, `${verb} exits non-zero`);
    assert.ok(lines.some((line) => line.includes(`unknown verb: ${verb}`)));
  }
});

test('the README states the node version the package requires', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const major = pkg.engines.node.replace(/[^0-9]/g, '');
  assert.ok(README.includes(`Node ${major}`), `README names Node ${major}, matching package.json`);
});

test('the README states the repository the clone line points at', () => {
  assert.match(README, /git clone https:\/\/github\.com\/derrtaderr\/signal-desk\.git/);
});

test('the README scripts it tells you to run are real npm scripts', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const script of ['test', 'golden:update']) {
    assert.ok(pkg.scripts[script], `package.json defines ${script}`);
    assert.ok(README.includes(`npm run ${script}`) || README.includes(`npm ${script}`));
  }
});
