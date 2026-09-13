---
name: signal-desk flow map
read_by: vibecodepm:ship-check and the user-advocate walk before any signal-desk release, and any session adding a CLI verb or a stage
milestone: M4
status: current — matches the build at lane/signal-desk-m4
date: 2026-09-13
supersedes: the M3 flow map, whose "cannot run against live data" line this milestone removes
---

# Flow map — signal-desk M4

What a first-time user does, what they see, and what happens when it goes wrong. The
ship-check walks the build against this document, so a gap between this file and the build is
a finding rather than a detail.

**Status field, added in M2.** The M1 review noted that this file and `metrics.md` carried no
way to tell a current map from a stale one. `status` is now in the frontmatter of both, and
`supersedes` says what changed. A map with no freshness marker is the same class of problem as
a README with no freshness test.

**What M3 changed here.** One new surface, the HTML dashboard, which is a new state rather than
a new path: it shows a run that already happened and cannot alter one. Four new refusal paths,
all of them in the hostile corpus, three owned by enrich and one by the gate. And one line moved
out of "what the user cannot do", which is the only kind of edit to that list worth making.

**What M4 changed here.** A SECOND ENTRY POINT, `run --live`, and the important thing about it is
how little of this map it alters: it joins the same happy path at the same stage sequence, parks at
the same approval queue, and renders through the same dashboard. What is new is the setup a user
has to get right BEFORE the first command works, so the new recovery paths are configuration
refusals rather than pipeline refusals — and they are the paths a first-time live user will
actually hit. Two new verbs' worth of surface (`run --live`, `dlq`), one new artifact
(`inputs.json`), and the "cannot run against live data" line leaves the list.

## Who walks this

Someone evaluating the repo. Most likely they were sent a link, they have Node installed, and
they will give it about five minutes before deciding whether it is real. They are not going to
create an account, export an API key, or read the source first.

That audience sets the whole shape. The first command has to work with no setup and has to
produce something worth looking at.

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
responses — **including the LLM rubric's judge responses** — and the recorded fetcher refuses to
fall back to a live call.

`node bin/signal-desk.mjs` with no verb prints usage and exits non-zero, so a user who guesses
wrong is told what the verbs are rather than left with a blank screen.

Because there is no install step, **every instruction in this repo names `node
bin/signal-desk.mjs`**, never a bare `signal-desk`. The bare form is not on PATH in a fresh
clone, and M1 shipped a next-step hint that used it.

## Happy path

1. **Orient.** The README one-liner says what the thing is. The user scrolls to "Try it".
2. **Verify it is alive.** `npm test` goes green. Zero install, so this takes seconds.
3. **Run the demo.** `node bin/signal-desk.mjs run` executes fourteen fixture signals through
   eight stages.
4. **Read the summary.** One lead passed to handoff, one waits for a human, twelve were refused,
   each refusal naming its reason code. The interesting number is that most of the corpus did
   not get through, and that the refusals come from five different stages rather than one.
5. **Inspect one decision.** `explain <lead>` prints that lead's whole trail, stage by stage,
   with the evidence each stage stood on and the human approval recorded as `actor: human`,
   naming the draft hash it authorised.
6. **Inspect a refusal.** `explain sig-9001` shows the malformed webhook stopping at ingest.
   `explain <lead>` on the orbital lead shows the gate refusing an ungrounded prose claim and
   naming the assertion it could not ground.
7. **Act on what is parked.** `queue` lists the waiting draft with its content hash.
   `approve <id>` records a decision. `run` again, and that lead reaches handoff.
8. **Prove it is reproducible.** `replay <run>` verifies the hash chain, checks the terminal
   seal, and re-executes the run, reporting all three checks separately.
9. **See it all at once.** `dashboard` writes one self-contained HTML file beside the ledger.
   Opening it shows the funnel, the refusals by reason code, which part of the gate produced
   each one, the human decisions with their draft hashes, and every lead's trail. It is the
   same information `explain` prints, arranged so a reader can see the shape of the run before
   deciding which lead to look at.

Step 4 is the activation moment. Everything before it is setup and everything after it is
depth. See `.vibecodepm/metrics.md`.

## States

### Per lead, inside a run

Exactly the three contract verdicts. There is no fourth outcome and no silent one, because the
kernel writes a verdict entry for every stage execution.

| State | What the user sees | How they got here |
|---|---|---|
| Delivered | A trail ending `PASS at handoff`, including a `human` actor line | Approved, and every gate passed |
| Parked | A trail ending `NEEDS_HUMAN at queue` | No decision covers this draft |
| Refused | A trail ending `REFUSE at <stage>` with a reason code and detail | Any stage refused |

### The approval workflow, new in M2

| State | What the user sees | How they got here | How they leave it |
|---|---|---|---|
| Nothing run yet | "no runs found. Run `node bin/signal-desk.mjs run` first." | `queue` in a fresh clone | Run the pipeline |
| Drafts parked | `queue` lists each draft's hash, recipient, subject, owner and status | A run left survivors undecided | `approve` or `reject` |
| Nothing parked | "nothing is parked for a human." | Every lead was decided, delivered or refused | Nothing to do |
| Decision recorded | "approved `<hash>`", naming the lead, recipient and who decided | `approve` / `reject` | `run` again to act on it |
| Decision acted on | That lead reaches handoff, or refuses `REJECTED_BY_HUMAN` | The next `run` | — |
| Approval stale | `NEEDS_HUMAN` with `APPROVAL_STALE`, naming both draft hashes | The draft changed after the decision | Decide again on the new draft |
| Mind changed | The latest decision binds; the superseded one stays in the store | A second `approve`/`reject` on one draft | — |

**The rule under all of it: an approval binds to the draft's content hash, never to the lead.**
Editing a draft leaves the old decision covering nothing.

### Gate refusal reasons, new in M2

Three parts, each with its own codes. Rule order is the reported order, so the same broken
draft always refuses for the same named reason.

| Code | Part | What happened |
|---|---|---|
| `PLACEHOLDER_UNRESOLVED` | rules | A template placeholder never filled in |
| `UNGROUNDED_CLAIM` | grounding | A structured claim reference no cited claim backs |
| `UNGROUNDED_PROSE_CLAIM` | grounding | A factual assertion in prose that no cited claim of the right FIELD supports |
| `PII_IN_BODY` | redaction | Redaction found a third-party address or a phone number. Everything worked |
| `REDACTION_INCOMPLETE` | redaction | Verification still found something after redaction. The gate cannot characterise what it holds, which is worse |
| `BANNED_PHRASE` | rules | A configured phrase appears in the draft |
| `DRAFT_TOO_SHORT` / `DRAFT_TOO_LONG` | rules | Outside configured length bounds |
| `RUBRIC_UNAVAILABLE` | rubric | The judge could not be reached, or did not answer 200. Silence is not a pass |
| `RUBRIC_MISMATCH` | rubric | The verdict names a different draft |
| `RUBRIC_MALFORMED` | rubric | No verdict, an unreadable verdict, no criteria, or a REQUIRED CRITERION UNANSWERED |
| `RUBRIC_FAILED` | rubric | An actual rejection, overall or on one criterion |
| `PROMPT_INJECTION` | injection | Instruction-shaped text, or markup, in a message composed as plain prose. It arrived from a source rather than a template |
| `DRAFT_HASH_MISMATCH` | all | The draft changed between stages |
| `GATE_ERROR` | all | The gate could not form an opinion. That is not permission |

### The dashboard, new in M3

| State | What the user sees | How they got here | How they leave it |
|---|---|---|---|
| Nothing run yet | "no runs found. Run `node bin/signal-desk.mjs run` first." | `dashboard` in a fresh clone | Run the pipeline |
| Rendered | The path to `runs/<run-id>/dashboard.html`, plus the counts it contains | `dashboard`, with or without a run id | Open the file |
| Chain broken | A refusal naming the entry that broke, and "nothing was written" | The ledger was edited after it was written | Fix the ledger, or stop trusting it |
| Unsealed run | The page renders, and says the run did not finish rather than implying it did | A truncated ledger | Re-run, or read it knowing it is partial |

**The dashboard is a pure function of the ledger and nothing else.** It cannot show what the
ledger does not record, which is deliberate: if it could, it would quietly become the more
trusted artifact and the ledger's completeness would stop being checkable.

**It is read-only, and it does not pretend otherwise.** No approve control, and no
disabled-looking one either. A button that advertises a capability at the wrong surface invites
somebody to wire it up. The page says where decisions are actually made.

### Enrichment refusal reasons, new in M3

Three of M3's four hostile catches are evidence problems, and enrich is the evidence stage.

| Code | What happened |
|---|---|
| `IDENTITY_CONTRADICTED` | The person-level source puts this contact at a different company, or names a different person at this address. The signal is valid in every checkable way and still names the wrong human |
| `EVIDENCE_DECAYED` | Every source that answered carried a record outside the freshness window, or a record that would not say how old it was. The sources are reachable; what they know is expired |
| `NO_CITED_CLAIMS` | Nothing answered at all. What the pipeline observed is an absence of evidence, which it reports as exactly that rather than as a conclusion about the company |

Two supplementary entries that are not refusals and are worth reading anyway. `IDENTITY_CONFIRMED`
says a person-level source agrees with the signal. `IDENTITY_UNVERIFIED` says no source could
answer, which is the state every lead was in before M3 and is reported out loud so that absence
never reads as confirmation.

`INJECTION_MARKED` is the third. It is also not a refusal: it names a source whose claim carried
instruction-shaped or markup-shaped text, at the moment those bytes entered, so a reader asking
where a payload came from has somewhere to look.

## Live mode, new in M4

**The setup, and it is the whole difference for a walker.** Fixture mode's promise is that the
first command works with no setup. Live mode cannot make that promise, so what it owes instead is
that every way of getting the setup wrong fails IMMEDIATELY, NAMES THE VARIABLE, and leaves
nothing behind. A half-run that then complains about its configuration would already have
contacted a stranger's server on the strength of a run it could not finish.

| State | What the user sees | Exit |
|---|---|---|
| No model key | `LIVE_KEY_MISSING`, naming both accepted variables and which wins | 2 |
| No signal secret | `LIVE_SECRET_MISSING`, naming the variable and why it is not optional | 2 |
| No signals directory | the path it looked for, plus `--signals <dir>` and a pointer to the README | 2 |
| Empty signals directory | "holds no .json payload files, so there is nothing to run" | 2 |
| Live run completes | the same run summary as fixture mode, plus a replay line and a dlq line if anything was dead-lettered | 0 |

Both credential checks run BEFORE any file is read or any directory is created, and a test asserts
the runs directory is still empty after a keyless invocation.

### New per-lead states

Every one is a refusal with its own code, and NONE of them falls back to a template or a fixture.
That is the state a walker should try hardest to provoke, because a silent fallback would look
like success: a plausible message nobody chose, on a path the operator believes is running a model,
with the ledger recording PASS.

| Code | What happened |
|---|---|
| `MODEL_UNAVAILABLE` | no model seam, an outage, a timeout, or a provider refusing the request |
| `MODEL_REFUSED` | the model declined to write this message — a fact about the input, not an outage |
| `MODEL_UNPARSEABLE` | something answered, in a shape this code cannot read |
| `RUBRIC_UNAVAILABLE` | the judge could not be reached, and silence is not a pass |
| `SOURCE_TIMEOUT` | a cited source did not answer in time |
| `SOURCE_OVERSIZED` | a cited source answered past the byte cap |
| `SOURCE_UNPARSEABLE` | a cited source answered 200 with something that is not a claim record |
| `SOURCE_INSECURE` | a payload cited a plaintext URL |
| `EVIDENCE_FUTURE_DATED` | a source claimed a record from the future |

### The DLQ recovery path

This is the one genuinely new LOOP in M4, and it is the live counterpart of the approval loop:

```
run --live   refuses a payload at ingest and retains its exact bytes
dlq          lists what is retained, with the reason and the source file
(fix)        the operator corrects their sender, or re-signs the retained bytes
dlq --replay re-feeds the same message and the run proceeds
```

The recovery is proven against the SAME BYTES rather than a reconstruction of them, which is the
only version of this loop that demonstrates the fix worked. A walker should check that the queue
does NOT fill with downstream refusals: a gate refusal is a decision the ledger holds, and offering
to replay it would invite somebody to retry it until it passed.

### Replay, as a live user experiences it

`replay <run>` on a live run needs no key and opens no socket, because the run captured what it
observed into `inputs.json`. The user-visible promise is that handing somebody the run directory
hands them the ability to re-derive every decision in it without your credentials. A walker should
check the wording carefully: a fixture run is REPRODUCIBLE and a live run is REPLAYABLE FROM ITS
CAPTURE, and the README says which is which rather than letting one word carry both.

## Recovery paths

**Wrong verb.** `unknown verb: <x>` plus the usage text, exit 2.

**`explain` with no argument.** "explain needs a lead id", exit 2.

**`explain` before any run.** "no runs found. Run `node bin/signal-desk.mjs run` first.", exit 2.

**`explain` on an id that is not in the ledger.** Names the id and says it was not found, exit 2.

**`approve` / `reject` with no id.** Says what is needed and points at `queue`, exit 2.

**`approve` on an id matching nothing.** `nothing parked matches "<id>"`, exit 2.

**`approve` on an AMBIGUOUS prefix.** Names every draft it matched and asks for more characters,
exit 2. It never guesses, because approving the wrong draft is the failure the whole design
exists to prevent.

**`replay` on an unknown run.** Names the path it looked for, exit 2.

**`dashboard` on an unknown run.** The same: names the path it looked for, exit 2.

**`dashboard` over a ledger whose chain is broken, new in M3.** Refuses, names the broken entry,
and says nothing was written. A confident picture of an untrustworthy record is the false-clean
reading this build exists to prevent, and it is worse than the raw file because it looks
authoritative.

**Tampered ledger.** `replay` reports which entry broke the chain and that the file was edited
after it was written, exit 1.

**Truncated or unsealed ledger, new in M2.** `replay` reports that the chain verified, that
lines were removed from the end or the run never finished, and that a hash chain proves order
rather than completeness. Exit 1. This is deliberately a DIFFERENT message from tampering,
because it leads somewhere different: nothing was edited, something is missing.

**Empty ledger.** `replay` refuses rather than treating zero entries as trivially valid, exit 1.

**Tampered decision store, new in M2.** Any command that reads decisions refuses with a broken
hash chain and says the store was edited after it was written. No decision in it is trusted,
because rewriting which draft a decision covers is exactly the attack the content hash exists
to stop.

**An export would clobber a different artifact, new in M2.** `run` refuses, names the path, and
leaves the existing file untouched. Identical bytes are an idempotent re-run and are allowed.

**Behaviour changed since the run.** `replay` reports that the re-execution differs, or that the
run id no longer matches. The chain is intact and the code moved, which is a different problem
from tampering and gets a different message.

**A stage fails mid-run.** The lead refuses with `STAGE_ERROR` and the run continues to the next
lead. A run always reaches the end, so the ledger always carries the full picture.

**A gate cannot evaluate.** It refuses with `GATE_ERROR`. A gate that cannot form an opinion has
not granted permission. This is the fail-closed invariant and it is asserted by a test.

## What the user cannot do in M4

Named here so the ship-check does not report them as gaps.

Approve anything from the dashboard. Deliberate and permanent, per DESIGN.md's non-scope, not a
milestone away. The page is a view of the ledger; decisions are made at the command line.

Send anything, ever. Non-scope by design, in every milestone. The adapters render files, and live
mode changed nothing about that: a live draft parks at the same approval queue.

Receive a webhook. There is no HTTP server, and its absence is argued rather than deferred — see
src/live/signals.mjs. Live ingest reads files, which exercises every ingest discipline the design
names. A user who wants an endpoint already has one and can write its body to a file.

Turn on earned autonomy. The hook exists so the code path is reviewable and it ships off, in live
mode exactly as in fixture mode.

**The boundary M3 named here, now closed.** M3 said the prompt-injection fixture influenced
nothing, for a structural reason rather than a defensive one: fixture drafting is a template fill,
so there was no interpreter for an instruction to instruct, and it said M4 would end that and that
the gate's injection rule was the part that would survive the transition.

It did survive, and the transition is done. Enrichment text now enters a real prompt, wrapped in a
fence whose delimiter is derived from the claim content itself. The fence is defence in depth. The
ENFORCEMENT is still the injection rule plus the gate, both of which run on the output, which is
the same arrangement M3 described and now has something real to defend.

## The M2 gap, closed

M2's map said, in its own words, that the user could not view the HTML dashboard. That was the
one honest gap in an otherwise complete inspection surface: a reader could ask about any single
lead and had no way to see the shape of a run.

They can now, and the fix did not add a second source of truth. The dashboard reads the ledger
and nothing else, so everything it shows is something `explain` would have told you one lead at
a time.

## The M1 dead end, closed

The M1 map recorded a real rough edge: a user who saw `1 awaiting a human` had nowhere to go,
because the verbs that would unpark it did not exist.

They exist now. `queue`, `approve` and `reject` are the whole path, the run output points at
them when anything is parked, and a test walks the loop end to end as a subprocess.
