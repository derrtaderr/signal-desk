---
date: 2026-09-13
status: draft
phase: ship-check
---

```yaml
goal: an inspectable, refusable signal-to-outreach pipeline that earns trust before autonomy
user: a GTM engineer evaluating the repo in five minutes, keyless
phase: ship-check
critical_assumption: the demo's own instructions never walk the user into a failure the tool blames on them
decision: BLOCK — replay cannot reproduce any run that consumed a human decision, which is the run the happy path produces
hard_gate: approve → run → replay <that run> exits 0 with an exact match, covered by a test; dry-run-json export carries real claim_refs bytes
success_window: carried from metrics.md — clone to completed run under two minutes, every refusal interpretable without reading source
```

# Ship-check — signal-desk M2 (lane/signal-desk-m2, PR #2, base ce0b9de)

Reviewer: lane-signal-desk-m2-reviewer (independent; builder was lane-signal-desk-m2-builder).
flow.md and metrics.md both carried `status: current` — the map walked was confirmed, not draft.
Walked: entry point, happy path steps 1–8, the approval-workflow state table, all recovery
paths, plus hostile probes (stale approval, seal truncation/forgery, ambiguous prefix, PII
variants, missing rubric recording). Full suite 520/520 green keyless; approval-workflow test
file stable across 10 consecutive runs.

## Verdict: BLOCK

### Blocking finding

1. **`replay` fails on any run that consumed a recorded human decision, and blames the user.**
   `src/cli.mjs` verbReplay re-executes with `buildRun({ fixtures: loadFixtures() })` and never
   passes `decisions: loadDecisions(...)`, while `run` does. Reproduced: fresh clone → `run` →
   `approve draft-b140…` → `run` (run-b316140e22d4) → `replay run-b316140e22d4` → exit 1,
   "replay produced run-130ed5b0a32e … the inputs or the wiring have changed since that run."
   Nothing changed. This is flow.md happy-path step 8 failing on the exact run steps 1–7
   produce, at the climax of the demo, with a message that misdiagnoses. No test covers
   replay-after-approve (test/approval-workflow.test.mjs stops at handoff; test/cli.test.mjs
   replays only the decision-free run). To clear: replay layers the decision store exactly as
   `run` does, and a test walks run → approve → run → replay end to end.

### Important (non-blocking, fix before flip)

2. **The reference export drops its grounding content.** `src/adapters.mjs` `stableJson` uses
   `JSON.stringify(value, Object.keys(value).sort(), 2)`; an array replacer filters keys at
   every depth, so nested claim_ref objects serialize as `{}`. Every dry-run-json artifact
   ships `"claim_refs": [{}]`. ADAPTERS.md promises "every fact the pipeline decided."
3. **Rubric ignores a FAIL on a non-required criterion.** M2-SPEC's table says "overall FAIL,
   or ANY single criterion FAIL" refuses; `src/rubric.mjs` filters `failing` from
   `required` only. Probed: extra criterion FAIL + overall PASS → `ok: true`. Fix code or spec.

### Minor (on record)

4. README "Design" section still names only docs/M1-SPEC.md as "what this milestone built."
5. A seal forged with fully recomputed hashes passes chain + seal checks (caught only by
   replay's re-execution); the unkeyed-chain limitation is stated nowhere.
6. Detected PII is written verbatim into ledger `detail` lines and the committed golden ledger.
7. Unicode-confusable PII (fullwidth @, unicode digits) passes both redaction detectors
   silently; the ASCII boundary of the detectors is unstated.
8. Approvals never expire: a later run whose draft is byte-identical silently re-consumes a
   months-old approval. Undocumented, unlike the cross-run-dedup deferral.
9. Reject-after-delivery reuses the garbage-id message; flow.md's "Mind changed" row states no
   window. 10. `approve b140` near-miss gives no hint ids start with `draft-`. 11. Addendum
   says 519 tests; suite is 520. 12. Enrich PASS entries carrying SOURCE_UNAVAILABLE read
   momentarily as contradictions.

### What passed

Axes: invocation, comprehension, persistence, recovery all strong (advocate walk + own runs);
recovery messaging is the best surface of the build. Instrumentation: every metrics.md row
traced to its named test; regeneration procedures (golden, fixtures, rubric, approvals) are
byte-stable against the committed files; no weakened assertions found in any test diff — the
adversarial flip strengthened the M1-gap test. Hostile probes passed: stale approval parks
APPROVAL_STALE naming both hashes and never exports; truncated/seal-stripped/empty ledgers all
refuse distinctly; ambiguous prefix errors with all matches; double-approve idempotent;
reject-after-approve latest-binds; missing rubric recording refuses RUBRIC_UNAVAILABLE.
Security surface: keyless proven under env -i; zero egress; fail-closed verified by probe.
Package audit deferred: repo is private and the public flip is out of scope; re-run at flip.

Builder's four open questions, judged: cross-run suppression absent — coherent, documented;
recordings outside the run id — acceptable, replay's byte comparison still catches edits;
APPROVAL_STALE parks — correct call; eml omits Date — correct for determinism, limitation
documented in ADAPTERS.md.
