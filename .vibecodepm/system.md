---
name: System map
phase: architect
status: confirmed 2026-09-27 (derived by system-map, walked with the orchestrator; all judgement answers signed by Jason)
read_by: system-map reconcile (/weekly check K); anyone changing where signal-desk writes, what it reaches in live mode, or how a failed lead is found
derived_from: signal-desk
---

# System map

Derived from the code by `system-map derive` on 2026-09-27, then confirmed question by question. Every
line is either cited to the code or a signed decision. Convention: a backticked name in section 5 is a
surface reconcile will look for in the code, so commands are written in plain words there.

## 1. The map

- **bin** — 1 file, the CLI entry point (bin/signal-desk.mjs:1)
- **scripts** — 6 files, development-time tooling: fixture recording, golden updates, corpus drafting (scripts/draft-corpus.mjs:1)
- **src** — 33 files: the eight fail-closed stages, adapters, decisions ledger, live capture and DLQ, cli (src/adapters.mjs:1)
- bin → src (bin/signal-desk.mjs:2)
- scripts → src (scripts/draft-corpus.mjs:10)
- tests: 40 files, excluded from the map (`--include-tests` to include) (test/adapter-conformance.test.mjs:1)

## 2. Where state lives

- state lives in local files: `target`, written with writeFileSync (scripts/make-fixtures.mjs:20)
- state lives in local files: `join(FIXTURES_DIR, 'approvals.json')`, written with writeFileSync (scripts/record-approvals.mjs:69)
- state lives in local files: `path`, written with writeFileSync (scripts/record-rubric.mjs:99)
- state lives in local files: `goldenPath`, written with writeFileSync (scripts/update-golden.mjs:20)
- state lives in local files: `path`, written with writeFileSync, and also at src/cli.mjs:179, src/cli.mjs:184, src/cli.mjs:227, src/cli.mjs:848 (src/cli.mjs:145)
- state lives in local files: `path`, written with writeFileSync (src/decisions.mjs:114)
- Decision: the four scripts writes are development-time fixtures and goldens, committed to this repo, not runtime state. The runtime state is three things under the runs directory (`SIGNAL_DESK_RUNS_DIR`, default inside the checkout): per-run outputs and exports written by the cli, the sealed decisions ledger (JSONL, tamper-evident, src/decisions.mjs:114), and the dead-letter queue for leads that failed a stage (src/live/dlq.mjs:52).
- Decision: fixtures and goldens are backed up by git. The runs directory, the ledger and the DLQ are not in git. Decision (Jason, 2026-09-27): no live motion points at signal-desk today, so the runs directory holds demo output only and needs no backup; the ledger and the DLQ move to a backed-up path the day a live run exists.

## 3. Doors and keys

- Unknown: no credential-shaped environment variable was found, so either this system holds no key or a key is arriving by a route the scan cannot see
- `SIGNAL_DESK_RUNS_DIR` is configuration rather than a key, read via an injected env object (src/cli.mjs:92)
- Decision: the demo is keyless by design and the reference sender adapter writes dry-run JSON; the pipeline never sends mail. Live mode reads its ingest secret from SIGNAL_DESK_SIGNAL_SECRET, its Anthropic key from SIGNAL_DESK_ANTHROPIC_KEY or ANTHROPIC_API_KEY, and its model from SIGNAL_DESK_MODEL, through variable names held in constants (src/live/config.mjs:28, src/live/keys.mjs:17, src/live/keys.mjs:116), which is why the scan reports no credential: it cannot resolve a name held in a constant. Known scan limit, recorded for the tool. No live run exists today, so neither variable is set anywhere.
- Decision: there is no HTTP route and no authorization check, and that is correct: the doors are the operator's shell, and the approval queue is the only place a human decision enters, bound to the draft's hash so an approval cannot be replayed against a changed draft.

## 4. What bills per use

- Unknown: nothing in this repo matched a metered client or an external host, so as far as the scan can tell nothing here bills per use. A vendor the registry does not know would look exactly the same
- Decision: in demo mode nothing bills. In live mode the enrichment adapters and the LLM rubric bill per lead through calls the scan cannot attribute to a host (src/stages/enrich.mjs, src/rubric.mjs, src/live/capture.mjs use fetch with computed URLs). Decision (Jason, 2026-09-27): a per-run lead ceiling IS required before any live run, so things do not get out of hand. Not yet built; build-queue row 68 (maintenance track, an improvement to this gate, not a new repo). Until it exists, live mode is not to be run.

## 5. How you find out it broke

- Unknown: nothing was found that records a failure, which means a failure leaves no trace this scan can see
- Decision: a lead that fails any stage lands in the dead-letter queue as a file, replayable (src/live/dlq.mjs:52); the sealed ledger records every decision including refusals. Neither pushes. Today nothing reads either on a schedule because there is no live motion. Decision (Jason, 2026-09-27): when a live run exists, a non-zero DLQ count is paged the same way landed's contradictions are; until then nothing reads it, by design.

## 6. Blast radius per piece

- **bin** — nothing in this repo imports it, so breaking it breaks only itself, unless it is an entry point (bin/signal-desk.mjs:1)
- **scripts** — nothing in this repo imports it, so breaking it breaks only itself, unless it is an entry point (scripts/draft-corpus.mjs:1)
- **src** — 2 other pieces import it (bin, scripts), so breaking it breaks those too (bin/signal-desk.mjs:2)
- Decision: bin is the entry point, so breaking bin breaks every run; breaking scripts breaks only fixture regeneration, never a run.

## What the scan could not see

Nothing was refused or unreadable on this run. The structural limits of text extraction still apply: dynamic imports, reflection, generated code, and anything configured outside the repository. Known and accepted: live-mode network calls use computed hosts, so section 4 cannot name the vendors from the code.
