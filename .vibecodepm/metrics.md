---
name: signal-desk metrics
read_by: vibecodepm:ship-check before any signal-desk release, and any session changing the CLI's first-run output
milestone: M1
date: 2026-09-13
---

# Metrics — signal-desk M1

## The activation event

**A stranger runs `signal-desk run` in a fresh clone and sees a completed fixture run with
its per-lead verdicts.**

That is the moment the repo stops being a claim and becomes a thing that did something. It is
one command after clone, with no install, no key and no config, which is why M1 spent its
budget on fixture mode rather than on live mode.

Not the activation event, and worth saying why. Cloning proves nothing about whether it runs.
A green `npm test` proves the tests pass, which is the author's claim rather than the user's
experience. Reading the README is not activation, and a build whose success metric is "someone
read it" has already lost.

### How it is measured

M1 has no telemetry, no hosted component and no accounts, by design. So activation is not
measured by instrumenting the user. It is measured by making it impossible to ship a build
where activation would fail, and the instrumentation lives in the test suite.

| What has to be true for activation | What proves it | Where |
|---|---|---|
| The command runs with no install | Zero dependencies declared | `test/repo-hygiene.test.mjs` |
| It runs with no key and no network | The run executes under a bare environment carrying only PATH and HOME | `test/cli.test.mjs` |
| It produces a completed run | Every signal reaches a terminal state, and all eight stages execute | `test/runner.test.mjs` |
| It shows verdicts worth reading | The run exercises all three verdicts | `test/runner.test.mjs` |
| It produces the same result for them as for us | Two runs are byte-identical; the golden file pins the decisions | `test/determinism.test.mjs`, `test/golden-ledger.test.mjs` |
| The output the README promises is the output they get | The README blocks are executed and compared | `test/readme-examples.test.mjs` |
| It carries no machine-specific state | No absolute path appears in the ledger or the run output | `test/determinism.test.mjs` |

A failure in any of those rows is an activation failure caught before release rather than a
support conversation afterwards. That is the whole instrumentation strategy for a distributed,
unhosted tool. Distribute, do not host, which means the check has to run in CI rather than in
production.

## The number that matters after activation

**Refusals per run that a reader can trace to a named rule.**

In the M1 fixture run that number is four out of six signals, and each one names its reason
code and leaves a trail `explain` can print. This is the metric because it is the product
claim. Anyone can build a pipeline that passes things through. The interesting question is
whether it stops, whether it says why, and whether you can check.

Measured by the golden ledger, which pins the exact set of refusals. A change that quietly
relaxes a rule shows up as a diff on that file rather than as silence.

## Week-one signals, if this goes public

M1 is private. If Jason gives publishing its own yes, these are the leading indicators worth
watching, in the order they mean something.

1. **Someone ran it.** A cloner who reports output, files an issue with a run id in it, or
   quotes a reason code. One of these beats a hundred stars.
2. **Someone replayed something.** Evidence that the inspection surface, rather than the
   pipeline, is what they found interesting. That is the differentiator.
3. **Someone swapped a stage.** The stage contract is the extensibility claim, and a fork that
   replaces one module is the only real test of it.
4. **A hiring conversation cites the ledger.** The design names a Head of GTM Engineering as
   the reader. A conversation that references a specific decision trail is the intended
   outcome landing.

Stars, forks without commits, and traffic are not on this list.

## Kill criterion

If a stranger cannot get from clone to a completed run in under two minutes without reading
source, M1 failed at the thing it exists to do, and the fix is the first-run path rather than
another milestone.
