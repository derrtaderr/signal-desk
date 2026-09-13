# signal-desk

A signal-to-outreach pipeline where every decision can be inspected, replayed, or refused.

An inbound intent signal arrives. Something has to enrich it, score it, decide who owns it,
write to the person, check that what was written is true and safe, and then stop and wait for
a human. signal-desk is that path, built so you can ask of any lead, at any point afterwards,
what happened and why.

It never sends mail. The pipeline ends at an approval queue, and survivors export through a
pluggable sender interface whose only reference adapter writes dry-run JSON.

## Try it

You need Node 20 or newer. There is nothing to install, no API key, and no network call.

```console
$ git clone https://github.com/derrtaderr/signal-desk.git
$ cd signal-desk
$ npm test
$ node bin/signal-desk.mjs run
```

The demo runs against a recorded fixture corpus, so it produces the same result on your
machine as on anyone else's.

<!-- verified-block: run -->
```console
$ node bin/signal-desk.mjs run
run run-d8a14f177e03

  1 passed to handoff
  1 awaiting a human
  4 refused
  6 signals in total

  lead-29e94419ba7e      handoff   PASS         
  sig-1001               ingest    REFUSE       DUPLICATE_SIGNAL
  lead-ff1af2ff8d01      queue     NEEDS_HUMAN  AWAITING_APPROVAL
  lead-845826c4c069      route     REFUSE       BELOW_ROUTING_FLOOR
  lead-e557482af15d      queue     REFUSE       REJECTED_BY_HUMAN
  sig-9001               ingest    REFUSE       MALFORMED_PAYLOAD

  ledger    runs/run-d8a14f177e03/ledger.jsonl
  handoffs  1 dry run artifact(s) in runs/run-d8a14f177e03/handoffs

  Nothing was sent. This tool never sends mail.
  Inspect a decision with: signal-desk explain <lead>
```

Six signals went in and one came out the far end. That ratio is the point. Four were refused
and one is waiting for a person, and every one of those outcomes names the rule that produced
it.

## Inspect a decision

Pass any lead id to `explain` and you get its whole trail, in order, with the evidence each
stage stood on.

<!-- verified-block: explain-pass -->
```console
$ node bin/signal-desk.mjs explain lead-29e94419ba7e
lead lead-29e94419ba7e
run  run-d8a14f177e03

  2026-03-01T09:00:00.000Z  ingest    PASS         system
      evidence  signal:sig-1001
  2026-03-01T09:00:01.000Z  enrich    PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test
  2026-03-01T09:00:02.000Z  score     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:03.000Z  route     PASS         system
  2026-03-01T09:00:04.000Z  draft     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:05.000Z  gate      PASS         system
  2026-03-01T09:00:06.000Z  queue     PASS         human
      reasons   APPROVED_BY_HUMAN
      detail    dana.reviewer approved this draft at 2026-03-01T08:56:00.000Z
  2026-03-01T09:00:07.000Z  queue     PASS         system
  2026-03-01T09:00:08.000Z  handoff   PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test

  outcome: PASS at handoff
```

Note the `human` actor on the queue line. A person approved that draft, and the ledger records
who and when, alongside the machine decisions. A refusal reads the same way.

<!-- verified-block: explain-refuse -->
```console
$ node bin/signal-desk.mjs explain sig-9001
lead sig-9001
run  run-d8a14f177e03

  2026-03-01T09:00:31.000Z  ingest    REFUSE       system
      reasons   MALFORMED_PAYLOAD
      detail    signal is malformed: payload.company.domain

  outcome: REFUSE at ingest
```

## Replay a run

`replay` does two separate things, and reports them separately, because a ledger can pass one
and fail the other. It verifies the hash chain, which proves the file was not edited after it
was written. Then it re-executes the run from the same inputs and compares the bytes, which
proves the code still makes the same decisions.

<!-- verified-block: replay -->
```console
$ node bin/signal-desk.mjs replay run-d8a14f177e03
hash chain verified across 32 entries
replay of run-d8a14f177e03 is an exact match
32 entries, identical bytes, chain intact
```

If you edit a line in `runs/<run-id>/ledger.jsonl` and run `replay` again, it tells you which
entry broke and exits non-zero.

## The eight stages

The pipeline is an ordered list of stages in `src/config.mjs`. Order is the pipeline; nothing
else defines it.

| # | Stage | What it enforces |
|---|-------|------------------|
| 1 | ingest | HMAC over the payload, a replay window, an idempotency check, and a shape check strict enough that nothing downstream re-validates |
| 2 | enrich | Every claim binds to a citation fetched in this run. Claims the signal asserted about itself are kept and marked uncited |
| 3 | score | The total is exactly the sum of named factors, each carrying its points, its reason, and its evidence |
| 4 | route | A deterministic band decision with the reason attached |
| 5 | draft | Composes the message. A factual placeholder resolves only from a cited claim |
| 6 | gate | Deterministic rules that can refuse. Fails closed, so a gate that errors refuses |
| 7 | queue | Everything parks for a human by default. This is the send boundary |
| 8 | handoff | Builds a dry-run artifact through a pluggable adapter. Never sends |

## The stage contract

Every stage is the same shape, and that is the entire extension mechanism. There is no plugin
framework and there is not going to be one.

```js
stage(input, ctx) -> { status: PASS | REFUSE | NEEDS_HUMAN, output, entries }
```

`ctx` carries the ledger, the config, an injected clock, and an injected fetcher. Stages
perform no I/O of their own, which is what makes a fixture run reproducible and lets you test
any stage with a plain object.

Three rules the kernel enforces rather than trusting stages to remember.

A `REFUSE` or a `NEEDS_HUMAN` must carry a machine-readable reason code. A stage that throws
becomes a refusal, and a stage that returns something malformed becomes a refusal, so no error
can arrive at a later stage looking like a pass. And every stage execution writes a verdict
entry, so no stage can run silently.

To adapt the system, replace a module and re-wire the sequence in `src/config.mjs`.

## The decision ledger

Every run writes append-only JSONL, hash-chained so that editing or dropping a line is
detectable. Each entry carries `ts`, `run_id`, `lead_id`, `stage`, `verdict`, `reason_codes`,
`evidence_refs`, and `actor`, where actor is `system` or `human`.

Runs are byte-for-byte reproducible. Four things make that true, and each has a test. The
clock is injected and advances by pipeline position rather than elapsed time. The run id is
derived by hashing the wiring and the inputs rather than generated. Every line goes through
one canonical serialiser with sorted keys. And leads are processed in sorted order rather than
whatever order the filesystem listed them in.

## Fixture mode and live mode

Fixture mode is the default and the only mode in this milestone. It reads recorded responses
from `fixtures/recordings.json`, and the recorded fetcher throws on a URL it has no recording
for rather than falling back to a live call. The corpus signals carry real HMAC signatures, so
the signature path is genuinely exercised offline instead of skipped.

Live mode is M4. When it lands you bring your own keys through the environment. Nothing is
hosted, and there is no telemetry and no account.

## What this milestone is

M1 is the kernel, the stage contract, the ledger, all eight stages running end to end in
fixture mode, and the `run`, `explain` and `replay` verbs.

Deliberately not here yet. The full three-part gate with PII redaction, an LLM rubric and
claim grounding is M2, along with the approval workflow and its `queue`, `approve` and
`reject` verbs. The HTML dashboard and the rest of the hostile fixture suite are M3. Live mode
is M4.

One M1 limitation is worth naming because a test asserts it rather than hiding it. The gate
verifies structured claim references, so a forged citation is caught. It does not yet catch a
factual assertion written as free prose, because that needs the rubric. See
`test/adversarial.test.mjs`.

## Tests

```console
$ npm test
```

Zero runtime dependencies and zero dev dependencies. The suite is the node built-in test
runner, and it covers four families the design calls for.

Stage-contract conformance applies one harness to every stage, so a ninth stage is covered for
free. Golden-ledger regression pins the fixture run's ledger as a committed file, so any
behaviour drift shows up as a diff on the decisions. Adversarial tests prove the hostile
fixtures refuse with the expected reason codes. And a determinism test proves two runs produce
identical bytes.

If you change behaviour on purpose, regenerate the golden file in the same commit.

```console
$ npm run golden:update
```

The fixture corpus is generated too, and a test compares the committed files against the
generator, so a hand-edited signal with a stale signature fails the suite.

```console
$ node scripts/make-fixtures.mjs
```

## Design

`docs/DESIGN.md` is the approved design. `docs/M1-SPEC.md` is what this milestone built,
including where it interpreted the M1 and M2 boundary and where it diverged.
