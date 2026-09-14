---
name: signal-desk design spec
date: 2026-09-12
status: shipped — all four milestones (M1-M4) built against this document
---

# signal-desk — design spec

## What this is

A signal-to-outreach pipeline where every decision can be inspected, replayed, or refused. Open, stranger-installable, generic by construction. The design bet is one thesis made structural: the edge is the judgment you construct, not the capability you buy.

## Ambition ladder

1. **First step (M1):** a stranger can install it, run one complete GTM workflow keylessly, and inspect every decision and safeguard.
2. **Flagship:** the system handles messy inputs, catches consequential mistakes, and shows where human judgment belongs.
3. **Earned option:** an extensible foundation for reliable GTM automation that other teams adapt. Adoption and payment are possible next steps, never the immediate test of success.

## Decisions already made (do not re-litigate)

- **Workflow:** the full inbound intent motion — signal in → enrich → score → route → draft → gate → human queue → handoff.
- **Send boundary:** gated handoff. The pipeline ends at an approval queue; survivors export through a pluggable sender interface with one reference adapter (writes `.eml` / dry-run JSON). The open-source tool never sends mail itself. An earned-autonomy hook exists in code but ships disabled.
- **Inspection surface:** CLI + append-only ledger + self-contained HTML dashboard.
- **Approach:** composed system (Approach A). One repo, uniform stage contract, existing primitives adapted in. No plugin framework — the stage contract IS the extensibility story.
- **Modes:** fixture mode (recorded, keyless, deterministic — the default first run) and live mode (bring-your-own keys via env). Distribute, don't host.
- **House style:** zero-dependency Node, built-in test runner, TDD throughout.

## Repo and location

- New repo `derrtaderr/signal-desk`, born private.
- Local checkout at `~/Projects/signal-desk` (2026-09-12 rule: code never in ~/Desktop or ~/Documents).
- Working name `signal-desk`; alternates parked: `intent-line`, `outreach-gate`.
- One-liner: "A signal-to-outreach pipeline where every decision can be inspected, replayed, or refused."

## Architecture

A small **pipeline kernel** executes an ordered sequence of stages under one contract. The sequence is wired in a config file. The clock and all I/O are injected through a context object, so a fixture run is byte-for-byte reproducible.

### Stage contract

```js
stage(input, ctx) -> { status: PASS | REFUSE | NEEDS_HUMAN, output, entries }
```

- `ctx` carries: ledger appender, config, injected clock, fetcher (recorded or live).
- `REFUSE` must carry a machine-readable reason code.
- Stages perform no I/O except through `ctx`.
- Adapting the system = replacing one module + re-wiring the config sequence. That is the whole extension mechanism.

### The eight stages, with the prior-art system inside each

| # | Stage | Discipline it enforces | Prior art adapted in |
|---|-------|------------------------|----------------------|
| 1 | ingest | HMAC over raw bytes, replay window, atomic idempotency, DLQ | webhook-engine |
| 2 | enrich | every claim binds to a citation fetched in the same run; uncited claims are marked and barred from drafts | account-scout |
| 3 | score | every score decomposes into named factors with evidence refs; no black-box number anywhere | (new, explainable-only) |
| 4 | route | deterministic, replayable, reasons attached | (new) |
| 5 | draft | LLM in live mode, recorded in fixture mode; every factual claim must trace to an enrichment citation | business-brain grounding gate |
| 6 | gate | fail-closed PII redaction + deterministic rules + fail-closed LLM rubric + claim-grounding check; any failure is REFUSE with a named reason | redaction-gate, gtm-agent-evals |
| 7 | queue | everything parks for a human by default; approve/reject via CLI; earned-autonomy hook ships disabled | ship-check pattern, earn-autonomy |
| 8 | handoff | pluggable sender interface; reference adapter writes `.eml` / dry-run JSON; never sends | (new; c1-sender is private prior art, not vendored) |

## Decision ledger

- Append-only JSONL per run, hash-chained (tamper-evident).
- Entry shape: `{ ts, run_id, lead_id, stage, verdict, reason_codes[], evidence_refs[], actor }` where actor is `system` or `human`.
- The ledger is the artifact a hiring manager inspects. Crashed runs resume from it.

## Surfaces

- **CLI verbs:** `run` (fixture demo), `run --live`, `queue`, `approve <id>`, `reject <id>`, `explain <lead>`, `replay <run>`, `why <decision-id>`, `dashboard`.
- **Dashboard:** one self-contained HTML file rendering any ledger — funnel view, per-lead decision trail, refusal breakdown, gate stats (gtm-agent-evals dashboard pattern).
- **Exhibit:** demo-agent produces the video from a real fixture run, making the README claim literal: the systems this pipeline composes are themselves real, separately published tools.

## Messy-input fixture suite (the flagship rung)

Hostile fixtures ship in the repo; each must end in a visible catch with a ledger trail (mistake → gate that caught it → where the human came in):

- malformed webhook payload
- duplicate/replayed signal
- wrong-person match
- decayed enrichment data
- prompt injection embedded in a scraped page
- PII surfacing mid-enrichment
- hallucination-bait lead (a company that does not exist)

## Error handling

- **Fail-closed is the invariant.** A gate that errors REFUSES; it never passes.
- Ingestion failures → DLQ. Live fetchers retry with backoff and jitter.
- Partial runs resume from the ledger.

## Testing

TDD, node built-in test runner, zero dev-deps. Four families:

1. **Stage-contract conformance** — every stage passes the same harness.
2. **Golden-ledger regression** — the fixture run's ledger is a golden file; any behavior drift fails CI.
3. **Adversarial gate tests** — every hostile fixture must REFUSE with the expected reason code.
4. **Determinism** — two fixture runs produce identical bytes.

## Milestones, riskiest first

- **M1** — kernel, stage contract, ledger, fixture pipeline end to end, `explain`/`replay`. This alone is ladder rung 1.
- **M2** — the gate stage (all three parts), approval queue, handoff adapter.
- **M3** — dashboard, hostile fixture suite, demo-agent exhibit.
- **M4** — live mode: enrichment fetchers, LLM drafting, real keys.

## Non-scope

- No sending. No SMTP/HeyReach adapters in the open repo.
- No plugin framework, registry, or marketplace.
- No hosted version, no telemetry, no accounts.
- No company operating data anywhere in the repo; fixtures are synthetic (.test domains only).
- Dashboard is read-only over the ledger; approvals happen in the CLI only.

## How it was built against this document

Each milestone ran as its own branch and PR, built test-first, and passed an independent adversarial review before merging. The per-milestone specs (docs/M1-SPEC.md through docs/M4-SPEC.md) record what was actually built, including every argued divergence from this design. The PR trail carries the full review records.
