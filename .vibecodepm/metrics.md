---
name: signal-desk metrics
read_by: vibecodepm:ship-check before any signal-desk release, and any session changing the CLI's first-run output
milestone: M3
status: current — matches the build at lane/signal-desk-m3
date: 2026-09-13
supersedes: the M2 metrics, whose instrumentation table this extends rather than replaces
---

# Metrics — signal-desk M3

**Status field, added in M2.** The M1 review noted that this file and `flow.md` carried no way
to tell a current document from a stale one. Both now declare `status` and `supersedes`.

## The activation event

**A stranger runs `signal-desk run` in a fresh clone and sees a completed fixture run with
its per-lead verdicts.**

Unchanged from M1, and deliberately so. That is the moment the repo stops being a claim and
becomes a thing that did something. It is one command after clone, with no install, no key and
no config.

M2 did not move the activation event, but it did raise what the moment shows. The same single
command now demonstrates three different parts of the gate refusing three different hostile
fixtures, and a lead parked with somewhere to go.

**M3 does not move it either, and the dashboard deliberately does not become it.** A second
command that produces a prettier artifact is not the moment the repo stops being a claim; the
run is. The dashboard is depth, and depth that competes with activation for the first ninety
seconds makes the first ninety seconds worse. It is named at the end of the run output and in
the README after `explain` and `replay`, not before them.

Not the activation event, and worth saying why. Cloning proves nothing about whether it runs. A
green `npm test` proves the tests pass, which is the author's claim rather than the user's
experience. Reading the README is not activation, and a build whose success metric is "someone
read it" has already lost.

### How it is measured

M2 has no telemetry, no hosted component and no accounts, by design. So activation is not
measured by instrumenting the user. It is measured by making it impossible to ship a build
where activation would fail, and the instrumentation lives in the test suite.

| What has to be true for activation | What proves it | Where |
|---|---|---|
| The command runs with no install | Zero dependencies declared | `test/repo-hygiene.test.mjs` |
| It runs with no key and no network | The run executes under a bare environment carrying only PATH and HOME | `test/cli.test.mjs` |
| **The rubric did not quietly acquire a key** | The same bare-environment run reaches the gate and the judge answers | `test/cli.test.mjs`, `test/runner.test.mjs` |
| It produces a completed run | Every signal reaches a terminal state, and all eight stages execute | `test/runner.test.mjs` |
| It shows verdicts worth reading | The run exercises all three verdicts | `test/runner.test.mjs` |
| It produces the same result for them as for us | Two runs are byte-identical; the golden file pins the decisions | `test/determinism.test.mjs`, `test/golden-ledger.test.mjs` |
| The output the README promises is the output they get | The README blocks are executed and compared | `test/readme-examples.test.mjs` |
| It carries no machine-specific state | No absolute path appears in the ledger or the run output | `test/determinism.test.mjs` |
| **A clone on Windows compares the same bytes** | LF pinned for every file type the byte-comparing tests read | `test/repo-hygiene.test.mjs` |
| **Every instruction printed is runnable in a fresh clone** | No bare `signal-desk` invocation is advertised | `test/approval-workflow.test.mjs` |
| **The dashboard needs no key either** | `dashboard` runs under the same bare environment carrying only PATH and HOME | `test/cli.test.mjs` |
| **The dashboard needs no network once written** | No emitted tag carries a `src`, and every emitted `href` is a fragment | `test/dashboard.test.mjs`, `test/cli.test.mjs` |

### New in M2: the safeguards have to be demonstrable, not merely present

A gate nobody can see working is indistinguishable from no gate. These rows exist so that
"the three-part gate ships" is a checkable claim.

| What has to be true | What proves it | Where |
|---|---|---|
| All three gate parts refuse in the demo run | The golden refusal set contains `PII_IN_BODY`, `RUBRIC_FAILED` and `UNGROUNDED_PROSE_CLAIM` | `test/golden-ledger.test.mjs` |
| Redaction is asymmetric, not one pass | PII the redacting pattern genuinely misses is caught by the verifier, asserted missed BEFORE asserted caught | `test/redaction.test.mjs` |
| The rubric is genuinely required | A clean draft with no judge available REFUSES | `test/stage-gate.test.mjs` |
| An unanswered rubric criterion is not a pass | A judgment with an overall PASS and a missing criterion refuses | `test/rubric.test.mjs` |
| Prose grounding is typed, not lexical soup | A wrong-field claim containing the words does not ground the assertion | `test/prose-claims.test.mjs` |
| An approval cannot release a draft nobody read | Same lead, rewritten body, does not pass | `test/stage-queue.test.mjs` |
| Only approved draft hashes are exportable | A draft edited after approval refuses at handoff | `test/stage-handoff.test.mjs` |
| One person gets one motion per run | A second signal for one contact refuses `DUPLICATE_LEAD` | `test/identity.test.mjs` |
| A truncated ledger is detectable | The chain verifies AND the seal is absent | `test/seal.test.mjs`, `test/cli.test.mjs` |
| A decision cannot be rewritten | A tampered decision store refuses at the next run | `test/approval-workflow.test.mjs` |
| An export cannot destroy a prior one | A differing artifact at the same path refuses | `test/cli.test.mjs` |
| The approval loop works across invocations | `run` → `queue` → `approve` → `run` as subprocesses | `test/approval-workflow.test.mjs` |
| Every adapter obeys the contract | One harness applied to every registered adapter | `test/adapter-conformance.test.mjs` |

### New in M3: the hostile suite is complete, and the surface that renders it is safe

DESIGN.md §7 names the hostile inputs this corpus must ship. M2 covered five of them and the
list lived in prose, which is the condition under which a list quietly stops being complete.

| What has to be true | What proves it | Where |
|---|---|---|
| **Every hostile input the design names is exercised** | The demo run's refusal codes are checked against the design's list, by code | `test/adversarial.test.mjs` |
| A valid signal naming the wrong human is caught before a draft exists | `IDENTITY_CONTRADICTED` at enrich, and no draft entry for that lead | `test/adversarial.test.mjs` |
| Absence of identity evidence never reads as confirmation | An unverified identity emits `IDENTITY_UNVERIFIED` and never `IDENTITY_CONFIRMED` | `test/stage-enrich.test.mjs` |
| A 200 is not freshness | A stale record is dropped and named; an UNDATED record is dropped too | `test/stage-enrich.test.mjs` |
| The corpus cannot hide behind undated evidence | No 200 recording in the corpus lacks an `as_of` | `test/adversarial.test.mjs` |
| An injection influences nothing | Identical score factors against a cleaned lead; unchanged routing; no human entry; no handoff | `test/adversarial.test.mjs` |
| An injection is visible in the trail | Enrich's flag precedes the gate's refusal, and both name the source | `test/adversarial.test.mjs` |
| A company with no sources invents nothing | No cited claim, no draft, and a refusal that does not claim non-existence | `test/adversarial.test.mjs` |
| **The dashboard cannot be made to execute injected markup** | The real renderer over the real hostile run, four named payloads, both directions each | `test/dashboard.test.mjs` |
| The dashboard offers no way to approve anything | No `<form>`, `<button>`, `<input>` or handler attribute is emitted | `test/dashboard.test.mjs` |
| The dashboard's counts are the ledger, not a second tally | The funnel's terminal counts equal the seal the kernel computed | `test/dashboard.test.mjs` |
| The dashboard refuses an untrustworthy ledger | A tampered chain refuses and writes nothing | `test/cli.test.mjs` |
| **The approval non-expiry deferral cannot be closed silently** | A years-old decision still binds, and the queue stage holds no clock | `test/stage-queue.test.mjs` |

A failure in any of those rows is a safeguard failure caught before release rather than a
support conversation afterwards. Distribute, do not host, which means the check has to run in
CI rather than in production.

## The number that matters after activation

**Refusals per run that a reader can trace to a named rule.**

In the M3 fixture run that number is **twelve out of fourteen** signals, and each one names its
reason code and leaves a trail `explain` can print. This is the metric because it is the product
claim. Anyone can build a pipeline that passes things through. The interesting question is
whether it stops, whether it says why, and whether you can check.

M1's number was four out of six and M2's was eight out of ten. The increase is not the point, and
a bigger ratio is not automatically a better build. **What M3 changed is the SPREAD.** Refusals
now come from five different stages rather than concentrating at the gate, which is the honest
shape: most bad outreach is stopped by knowing something is wrong with the evidence, not by
catching a bad sentence after writing one.

Measured by the golden ledger, which pins the exact set of refusals. A change that quietly
relaxes a rule shows up as a diff on that file rather than as silence.

### The third number, new in M3

**Hostile inputs from the design that the demo run actually exercises.**

Seven of seven, and it is asserted by code rather than counted by hand. M2 shipped five and
tracked the remaining list in prose, which is exactly the condition under which a list stops
being complete without anybody noticing. `test/adversarial.test.mjs` now checks the design's
list against the reason codes the demo run produces, so adding a fixture stays cheap and
forgetting one stops being silent.

### The second number, new in M2

**Decisions that bind to content rather than to identity.**

All of them, and it is checkable: every record in `fixtures/approvals.json` carries a
`draft_hash`, every one names a draft the run actually composed, and the queue stage has no code
path that releases a draft on a lead id. This is the number M1 got wrong, and the M1 review
demonstrated the cost with a live repro.

## Week-one signals, if this goes public

M2 is private. If Jason gives publishing its own yes, these are the leading indicators worth
watching, in the order they mean something.

1. **Someone ran it.** A cloner who reports output, files an issue with a run id in it, or
   quotes a reason code. One of these beats a hundred stars.
2. **Someone replayed something.** Evidence that the inspection surface, rather than the
   pipeline, is what they found interesting. That is the differentiator.
3. **Someone approved something.** The send boundary is the opinionated part of the design, and
   a person who walked `queue` → `approve` → `run` has engaged with the actual argument.
4. **Someone swapped a stage or wrote an adapter.** Both contracts are the extensibility claim,
   and an implementation somebody else wrote is the only real test of either.
5. **A hiring conversation cites the ledger.** The design names a Head of GTM Engineering as the
   reader. A conversation that references a specific decision trail is the intended outcome
   landing.

Stars, forks without commits, and traffic are not on this list.

## Kill criterion

If a stranger cannot get from clone to a completed run in under two minutes without reading
source, the build failed at the thing it exists to do, and the fix is the first-run path rather
than another milestone.

**Added in M2:** if a stranger cannot tell WHY a lead was refused without reading source, the
inspection surface failed, and the fix is the reason codes and `explain` rather than more gates.
A refusal nobody can interpret is a worse outcome than a pass, because it teaches the reader the
tool is arbitrary.

**Added in M3:** if the dashboard shows anything the ledger does not record, the inspection
surface has acquired a second source of truth and the ledger has stopped being the artifact. The
fix is to delete the view, or to make the stage record what the view needed. It is never to let
the renderer work it out.
