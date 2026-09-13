---
name: signal-desk flow map
read_by: vibecodepm:ship-check and the user-advocate walk before any signal-desk release, and any session adding a CLI verb or a stage
milestone: M1
date: 2026-09-13
---

# Flow map — signal-desk M1

What a first-time user does, what they see, and what happens when it goes wrong. The
ship-check walks the build against this document, so a gap between this file and the build is
a finding rather than a detail.

## Who walks this

Someone evaluating the repo. Most likely they were sent a link, they have Node installed, and
they will give it about five minutes before deciding whether it is real. They are not going to
create an account, export an API key, or read the source first.

That audience sets the whole shape of M1. The first command has to work with no setup and has
to produce something worth looking at.

## Entry point

One entry point. A terminal in a fresh clone.

```
git clone https://github.com/derrtaderr/signal-desk.git
cd signal-desk
npm test
node bin/signal-desk.mjs run
```

There is no install step, because there are no dependencies. There is no configuration step,
because fixture mode is the default. There is no key, because fixture mode reads recorded
responses and the recorded fetcher refuses to fall back to a live call.

`node bin/signal-desk.mjs` with no verb prints usage and exits non-zero, so a user who guesses
wrong is told what the verbs are rather than left with a blank screen.

## Happy path

1. **Orient.** The README one-liner says what the thing is. The user scrolls to "Try it".
2. **Verify it is alive.** `npm test` goes green. Zero install, so this takes seconds.
3. **Run the demo.** `node bin/signal-desk.mjs run` executes six fixture signals through
   eight stages.
4. **Read the summary.** One lead passed to handoff, one waits for a human, four were
   refused, each refusal naming its reason code. The interesting number is that most of the
   corpus did not get through.
5. **Inspect one decision.** `explain <lead>` prints that lead's whole trail, stage by stage,
   with the evidence each stage stood on and the human approval recorded as `actor: human`.
6. **Inspect a refusal.** `explain sig-9001` shows the malformed webhook stopping at ingest
   with `MALFORMED_PAYLOAD` and the field that was missing.
7. **Prove it is reproducible.** `replay <run>` verifies the hash chain and re-executes the
   run, reporting both checks separately.

Step 4 is the activation moment. Everything before it is setup and everything after it is
depth. See `.vibecodepm/metrics.md`.

## States

| State | What the user sees | How they got here |
|---|---|---|
| No run yet | Usage text, or "no runs found. Run `signal-desk run` first." | Fresh clone, or `explain` before `run` |
| Run complete | Summary, per-lead outcomes, paths to the ledger and the handoff artifacts | `run` |
| Lead delivered | A trail ending `PASS at handoff`, including a `human` actor line | `explain` on an approved lead |
| Lead parked | A trail ending `NEEDS_HUMAN at queue` with `AWAITING_APPROVAL` | `explain` on a lead with no recorded decision |
| Lead refused | A trail ending `REFUSE at <stage>` with a reason code and detail | `explain` on a refused lead or signal |
| Replay matched | Chain verified, byte-identical, exit 0 | `replay` on an untouched run |
| Replay mismatched | Which entry broke and why, exit non-zero | `replay` after editing the ledger, or after changing behaviour |

Per-lead states inside a run are exactly the three contract verdicts. A lead is delivered
(PASS through all eight stages), parked (NEEDS_HUMAN, waiting on a person), or refused
(REFUSE, with a named reason). There is no fourth outcome and no silent one, because the
kernel writes a verdict entry for every stage execution.

## Recovery paths

**Wrong verb.** `unknown verb: <x>` plus the usage text, exit 2.

**`explain` with no argument.** "explain needs a lead id", exit 2.

**`explain` before any run.** "no runs found. Run `signal-desk run` first.", exit 2.

**`explain` on an id that is not in the ledger.** Names the id and says it was not found in
the latest ledger, exit 2. This is the likely typo case, since lead ids are hashes.

**`replay` on an unknown run.** Names the path it looked for, exit 2.

**Tampered ledger.** `replay` reports which entry broke the chain and that the file was edited
after it was written, exit 1. This is distinct from the next case on purpose.

**Behaviour changed since the run.** `replay` reports that the re-execution differs from the
recorded ledger, or that the run id no longer matches, exit 1. The chain is intact and the
code moved, which is a different problem from tampering and gets a different message.

**A stage fails mid-run.** The lead refuses with `STAGE_ERROR` and the run continues to the
next lead. A run always reaches the end, so the ledger always carries the full picture.

**A gate cannot evaluate.** It refuses with `GATE_ERROR`. A gate that cannot form an opinion
has not granted permission. This is the fail-closed invariant and it is asserted by a test.

## What the user cannot do in M1

Named here so the ship-check does not report them as gaps.

Approve or reject from the CLI. That workflow is M2; M1 reads decisions recorded in
`fixtures/approvals.json`. See the dead end below.

View the HTML dashboard. M3.

Run against live data with real keys. M4.

Send anything, ever. Non-scope by design, in every milestone.

## Known dead end

A user who reads the summary, sees `1 awaiting a human`, and wants to act on it has nowhere to
go in M1. The lead is parked and the verbs that would unpark it do not exist yet.

This is a real rough edge rather than a hidden one. The README names the approval workflow as
M2 under "What this milestone is", and the CLI does not advertise `approve` or `reject` in its
usage, so the user is not invited to try something that will fail. A test asserts the README
does not show unbuilt verbs as runnable.
