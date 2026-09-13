---
name: signal-desk M1 implementation spec
read_by: the reviewer grading lane/signal-desk-m1, and any session resuming M1 or opening M2
date: 2026-09-13
status: implementation spec for M1
parent: docs/DESIGN.md (approved 2026-09-12)
---

# signal-desk M1 — implementation spec

This is the lane spec for milestone M1 of `docs/DESIGN.md`. It states scope, the design
decisions taken inside the approved design's degrees of freedom, the M1/M2 boundary
interpretation, divergences from the design spec, the prior-art findings, and the gates
this lane runs on every commit.

## Prior-art findings (recorded verbatim from the orchestrator's gate run)

> Prior-art gate run 2026-09-12/13 by the orchestrator: builds/, gh repo list derrtaderr,
> build-ledger.md, gtm-resources/ checked. No full-motion pipeline exists; account-scout and
> business-brain are single-motion compositions. webhook-engine, redaction-gate,
> gtm-agent-evals are public prior art whose PATTERNS this build adapts (HMAC/idempotency/DLQ,
> fail-closed redaction, fail-closed rubric); they are not vendored in M1. gtm-resources/ parts
> bin available as parts only, never for resume or content claims.

## M1 scope

In scope, per design §"Milestones, riskiest first":

- The pipeline kernel.
- The uniform stage contract `stage(input, ctx) -> { status, output, entries }`.
- The hash-chained, append-only JSONL decision ledger.
- All eight stages, running end to end in keyless deterministic fixture mode.
- CLI verbs `run`, `explain <lead>`, `replay <run>`.
- Zero runtime and dev dependencies; node built-in test runner; clock and fetcher injected
  through `ctx`; no direct I/O inside stages.

Out of scope and untouched: the dashboard (M3), the full hostile fixture suite beyond the two
named below (M3), live mode and real keys (M4), and everything in design §Non-scope.

## M1/M2 boundary interpretation

The design lists M1 as "kernel, stage contract, ledger, fixture pipeline end to end,
`explain`/`replay`" and M2 as "the gate stage (all three parts), approval queue, handoff
adapter". Read literally that leaves stages 6, 7 and 8 with no M1 existence, which contradicts
"fixture pipeline end to end". The interpretation this lane builds to, and the one the task
dispatch confirmed:

**All eight stages exist in M1 as minimal implementations honoring the contract.** Depth, not
existence, is what M2 adds.

| Stage | M1 (this lane) | M2 (not this lane) |
|---|---|---|
| 6 gate | A deterministic rule check that can genuinely REFUSE, fail-closed on its own errors | The full three-part gate: PII redaction pass, LLM rubric, claim-grounding check |
| 7 queue | Parks every lead for a human by default; consults a recorded approval decision so the fixture run can reach stage 8; earned-autonomy hook present and disabled | The approval workflow itself: `queue`, `approve <id>`, `reject <id>` CLI verbs and their state machine |
| 8 handoff | Reference adapter builds a dry-run JSON handoff artifact and returns it; never writes, never sends | Adapter depth, `.eml` rendering, the pluggable sender registry |

Two consequences worth naming because a reviewer will look for them:

1. **Recorded approvals are an M1 stand-in, not the approval queue.** `fixtures/approvals.json`
   carries human decisions that were made outside this system. Stage 7 reads them so stage 8
   executes in the fixture run. It writes nothing, and it is not a workflow. When M2 lands the
   real queue, this file is what it replaces.
2. **The earned-autonomy hook ships disabled and is asserted disabled by a test.** Design §
   Send boundary requires the hook to exist in code and ship off. A test pins the default.

## Design decisions taken inside the design's degrees of freedom

**Determinism is engineered, not hoped for.** Byte-identical ledgers across runs require four
things to be deterministic, and each is handled explicitly:

- **Clock.** `ctx.clock.now()` in fixture mode starts at a fixed ISO instant from the run config
  and advances a fixed step per call. No wall clock is read anywhere in `src/`.
- **Run id.** Derived by hashing the pipeline wiring plus the sorted fixture inputs, never
  randomly generated. Two runs over the same fixtures produce the same `run_id`, which is what
  lets the ledger bytes match.
- **Key order.** Every ledger line is serialised through one canonical JSON function with sorted
  keys, so object construction order cannot leak into the bytes.
- **Lead order.** Leads are processed in a sorted, stable order rather than filesystem order.

**The kernel is the only ledger writer.** Stages return `entries`; the kernel stamps `ts`,
`run_id` and `lead_id` onto each and appends them. `ctx.ledger` is still handed to stages as the
design requires, and it does expose `append`, but the returned-entries path is the one every
stage uses. Centralising the stamping is what makes the `ts` sequence a function of pipeline
position rather than of how many times a stage happened to call the appender.

**REFUSE halts that lead, never the run.** A refused lead stops advancing and the kernel moves
to the next lead. A run therefore always reaches the end, and the ledger always carries the
full picture. NEEDS_HUMAN parks the lead at that stage with the same effect on advancement.

**Fail-closed is enforced by the kernel, not trusted to stages.** A stage that throws is
converted by the kernel into a REFUSE carrying reason code `STAGE_ERROR`. A stage that returns
a malformed result is converted into a REFUSE carrying `CONTRACT_VIOLATION`. There is no path
through the kernel where an error becomes a PASS.

**Hash chain.** Each line carries `prev` and `hash`, where `hash = sha256(prev + canonical(payload))`
and the genesis `prev` is 64 zeroes. `node:crypto` is a built-in, so this costs no dependency.
Verification is exposed as `verifyChain` and is what `replay` uses.

## Divergences from docs/DESIGN.md

1. **`fixtures/approvals.json` is new and is not in the design spec.** It exists only to let the
   fixture run reach stage 8 while the approval workflow is still M2. Justified above; it is the
   single addition this lane makes to the design's surface area.
2. **The design's `ctx` bullet says "ledger appender" without saying who calls it.** This lane
   resolves that to kernel-appends-returned-entries, for the determinism reason above. The
   appender is still on `ctx`.
3. **The design says "HMAC over raw bytes"; M1 computes the HMAC over the canonical
   serialisation of the already-parsed payload.** These are different threat models and the
   difference is worth stating rather than eliding. Hashing raw bytes binds the signature to
   exactly what the sender transmitted, so a parser disagreement cannot move the signature.
   Hashing the canonicalised parse binds it to the payload's meaning, which survives a
   reserialisation but trusts the parser. M1 took the second because fixture signals are
   committed as formatted JSON files that a formatter would otherwise invalidate. Live mode
   (M4) receives real request bodies and should verify over the raw bytes it was handed.
4. **The design's ingest row names a DLQ; M1 ships none.** A refused signal is recorded in the
   ledger with its reason code and is not retained anywhere a replay could pick it up. The
   ledger carries the full picture of what was refused and why, so nothing is lost, but the
   design's "ingestion failures → DLQ" is not implemented and no code stands in for it.
5. Nothing else. The stage list, the contract shape, the ledger entry shape, the CLI verb names,
   the modes, and the non-scope list are implemented as written.

## Gates this lane runs on every commit

- **Test suite:** `npm test`, which is `node --test test/`. Zero dev dependencies.
- **Freshness check:** `test/readme-examples.test.mjs` is part of that suite. It executes the
  CLI and asserts the README's example blocks match the real output, so a README that goes stale
  fails the suite in the same commit that staled it. The golden ledger is regenerated through
  `npm run golden:update` and is committed alongside the behaviour change that moved it.
- **Zero-dependency check:** `test/repo-hygiene.test.mjs` asserts `dependencies` and
  `devDependencies` are both empty, so the house rule cannot erode quietly. The same file
  asserts that nothing under `src/` imports a non-builtin, and that no stage touches the
  filesystem, the network, the wall clock or `process.env`.

## Ship criteria this lane is graded against (design §3)

A stranger clones the repo, runs `npm test` green, and runs the fixture demo keylessly from the
README with no machine-specific state. Four test families present: stage-contract conformance
applied to every stage, golden-ledger regression, adversarial tests where the malformed-webhook
and duplicate-signal fixtures REFUSE with expected reason codes, and a determinism test proving
two fixture runs produce identical ledger bytes.
