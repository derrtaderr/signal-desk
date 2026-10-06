---
name: signal-desk lead ceiling spec
read_by: the lane that implements the per-run lead ceiling, and any later session touching run --live, dlq --replay, src/kernel.mjs or src/live/config.mjs. The system map (.vibecodepm/system.md §4) is the decision this implements; read it first.
date: 2026-10-05
status: spec — written before the ceiling existed
---

# A per-run lead ceiling for live mode

The system map, section 4, records a decision: in live mode the enrichment adapters and the LLM
rubric bill per lead, nothing in the code refuses the N+1th lead, and a per-run lead ceiling is
required before any live run. A mis-sized signals folder is a bill. This spec is that ceiling.

## What was read first

- `src/cli.mjs`: `run --live` resolves both credentials, loads the signals directory once with
  `loadLiveSignals`, and hands the whole array to `executeLive`. `dlq --replay` also reaches
  `executeLive`, so it bills the same way and is covered by the same ceiling.
- `src/kernel.mjs`: `runPipeline` walks the sorted signals one lead at a time, stage by stage. It is
  the only ledger writer and the only place that can refuse a lead before a stage runs.
- `src/live/http.mjs` and `src/live/anthropic.mjs`: the existing cost controls are all PER REQUEST.
  A 10 s source timeout, a 256 KiB response cap and a bounded retry with backoff on each evidence
  fetch; a 60 s timeout and `max_tokens` 2048 on each model call. Nothing bounds the number of
  requests a run makes, and the number of requests is a multiple of the number of leads. There is
  no batching and no concurrency: leads run sequentially.

## Scope

**In.**

1. `--max-leads <n>` on `run --live` and on `dlq --replay`.
2. A config default, `DEFAULT_MAX_LEADS`, in `src/live/config.mjs`, carried in the live config as
   `limits: { maxLeads, countedFrom: 'enrich' }`.
3. **The start-time refusal.** After the credentials resolve and the signals load, and before any
   URL is fetched, any model is called or any directory is created: when the run holds more signals
   than the ceiling, refuse with `LEAD_CEILING_EXCEEDED`, naming the count, the ceiling and how to
   raise it. Exit 2. Nothing is written.
4. **The mid-run stop, in the kernel.** The kernel counts leads admitted to the first billing stage
   (`countedFrom`, which is `enrich`). A lead that would be admitted past the ceiling does not run
   that stage or any later one: the kernel writes one `REFUSE` entry for it, at that stage, with
   reason `LEAD_CEILING_REACHED` and a detail naming the ceiling and saying the stage was not run.
   The run still seals, so the summary counts the refusal and the dashboard, `explain` and `replay`
   see it like any other decision. Never a silent truncation: every lead over the ceiling has its
   own ledger line and its own row in the run report.
5. Same-commit freshness: README, CLI usage text, the system map §4, flow.md and metrics.md.

**Not in.**

- A dry-run mode for live. See the decision below.
- A ceiling on fixture runs, on requests, on tokens or on spend in currency.
- An environment variable for the ceiling. The default lives in config, like every other threshold
  in this repo; the flag is the per-run override.
- Changing any per-request control above.

## Decisions

**The default is 10.** A first live run is a check that the wiring works, and ten leads is enough
to see every path (park, refuse, DLQ) while bounding the bill to ten leads' worth of fetches and
two model calls each. Raising it is one flag on the command line, typed on purpose.

**The config default lives in `src/live/config.mjs`**, as the exported `DEFAULT_MAX_LEADS`, and the
live config carries it under `limits`. It does NOT go into `defaultConfig` in `src/config.mjs`:
fixture mode bills nothing, and a key added there would move every fixture run id and the
committed golden ledger for a control that has nothing to guard in that mode.

**The ceiling is part of the run's config, so it is part of the run id and of the capture.** A
replay of a live run re-executes the kernel with the same ceiling and reproduces any
`LEAD_CEILING_REACHED` line byte for byte. Running the same signals under a different ceiling is a
different run, and its id says so.

**What the start check counts.** Parsed payloads, `signals.length`. Files that never parsed go to
the DLQ and never reach a stage, so they are not counted. Signals that ingest will refuse ARE
counted, because the start check cannot know that without running ingest; the start check is
therefore a conservative upper bound, and the kernel's count (leads that cleared ingest) is the
exact one.

**What the kernel counts, and where the refusal is filed.** Leads that clear ingest and are about
to enter `enrich`, the first stage that reaches the network. Ingest still runs for every signal,
because it costs nothing and is what dead-letters a malformed or wrongly signed payload. The
refusal is filed under the stage that was refused entry (`enrich`), with a detail that says it was
not run, so the dashboard funnel and its refusal table show it without a new pseudo-stage.

**When the two checks can disagree.** Today they read the same in-memory array, so from the CLI the
start check always fires first and the kernel stop cannot be reached. The kernel stop exists because
the ceiling is the kernel's invariant rather than the CLI's courtesy: any caller of `runPipeline`
with a live config (a script, a future streamed source, a second entry point like the one that
broke the live approval loop in M4) is bounded at n whether or not it ran the start check. It is
proven by tests that drive the kernel directly with more signals than the ceiling.

**Exit codes.** The start refusal exits 2, like every other configuration refusal in this CLI.

**A dry run does not exist, and none is added.** There is no live dry-run mode to report through,
and the start refusal is already the preview: it runs before any network call, so typing the real
command with a ceiling that is too small costs nothing and prints the count. Adding a mode would be
a second way to invoke live that must stay in sync with the first, which is the class of bug this
repo has already paid for once.

**Bad values refuse.** `--max-leads` with no value, `0`, a negative number, a fraction, anything
that is not a plain positive decimal integer (`10abc`, `1e3`, `0x10`, ` 5`) refuses with
`LEAD_CEILING_INVALID` and exit 2, before the credentials are even read, the same place an unknown
flag refuses. `--max-leads` on a fixture `run` (no `--live`) also refuses: accepting it and ignoring
it would be the `--live=true` failure shape again, a flag that silently means nothing.

**Interaction with the existing controls.** They multiply. The per-request caps bound the cost of
one request; the ceiling bounds how many leads make requests. Worst case per run is roughly
`maxLeads × (evidence URLs per payload × (1 + retries) + 2 model calls of max_tokens)`. Nothing else
changes.

## Gate commands

```console
$ npm test
$ node <path-to-system-map>/bin/system-map.mjs reconcile .
```

Every commit runs `npm test` and records its exit code. The reconcile verdict is recorded once the
system map is updated.
