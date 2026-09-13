---
name: signal-desk M2 implementation spec
read_by: the reviewer grading lane/signal-desk-m2, and any session resuming M2 or opening M3
date: 2026-09-13
status: implementation spec for M2
parent: docs/DESIGN.md (approved 2026-09-12), docs/M1-SPEC.md (shipped 2026-09-13)
---

# signal-desk M2 — implementation spec

This is the lane spec for milestone M2 of `docs/DESIGN.md`. It states scope, the design
decisions taken inside the approved design's degrees of freedom, the identity model M1 left
unowned, the approval-hash design, the NEEDS_HUMAN vs REFUSE routing argument, divergences
from the design spec, the prior-art findings, and the gates this lane runs on every commit.

## Prior-art findings (recorded verbatim from the orchestrator's gate run)

> Prior-art gate run 2026-09-13 by the orchestrator: signal-desk repo has no branches beyond
> merged M1; build-ledger.md has no competing approval-queue or gate-stage build;
> redaction-gate and gtm-agent-evals (public repos) are the donor patterns by design, adapted
> not vendored; gtm-resources/ parts bin available as parts only.

## M2 scope

Per design §"Milestones, riskiest first": **the gate stage (all three parts), the approval
queue, and the handoff adapter.** Plus one item the M1 review surfaced as a missing question
that M2 cannot avoid, because M2 rewrites ledger semantics: the sealed terminal entry.

In scope:

1. The three-part gate, replacing M1's deterministic-rules-only gate.
2. The approval queue workflow: `queue`, `approve <id>`, `reject <id>`, and a decision store.
3. Handoff adapter depth: a documented adapter contract, a second conforming adapter, and
   export naming that cannot clobber.
4. A sealed terminal ledger entry, and a `replay` that refuses an unsealed or truncated chain.
5. The identity model, decided and documented, with dedup behaviour made consistent with it.
6. Four first-touch fixes carried from the M1 review.

Out of scope and untouched: the dashboard and the rest of the hostile fixture suite (M3), live
mode and real fetchers (M4), any real sending, and everything in design §Non-scope. The
earned-autonomy hook stays present and disabled. Everything stays keyless in fixture mode,
zero dependencies, node built-in test runner.

## The identity model — what "one person, one motion" means here

**This is the decision M1 left unowned, and it is the root of the M1 review's finding 1.**

M1 carried three keys and never said which one was the identity:

| Key | Derived from | Used for |
|---|---|---|
| signal id | the sender's own `id` field | ingest idempotency |
| lead id | `sha256(domain + " " + email)` | ledger filing, approvals, artifact naming |
| approval key | lead id | releasing a draft to handoff |

Because idempotency keyed on the signal id and everything downstream keyed on the lead id, a
**second, validly signed signal carrying a different signal id for the same contact** passed
ingest, ran the whole pipeline again, consumed the same recorded approval a second time, and
wrote its handoff artifact over the first one. One person, two motions, one surviving artifact.

### The decision

**The lead is the identity. The motion is per lead, per run.**

A lead is one person at one company, named by `lead-<sha256(domain + " " + email)[0:12]>`.
Within a run, a lead receives at most one motion: at most one draft, at most one approval
consumption, at most one exported artifact. A second signal naming the same person is
corroborating evidence about a lead already in flight, never a second reason to write to them.

Three consequences, each enforced rather than documented:

1. **Ingest gains a second idempotency check, at the lead level.** The signal-level check
   stays exactly as it was, because a replayed webhook and a second distinct signal are
   different events and a reader deserves to be told which one happened. They get different
   reason codes:

   | Case | Reason code |
   |---|---|
   | This signal id was already accepted this run | `DUPLICATE_SIGNAL` |
   | A different signal for this lead id was already accepted this run | `DUPLICATE_LEAD` |

   The lead id is therefore derived immediately after the shape check rather than at the end
   of the stage, because it is now something ingest decides with, not just something it emits.

2. **Approvals no longer key on the lead id.** See the next section. A lead-keyed approval is
   what let one human decision authorize a draft nobody read.

3. **Export naming carries the draft hash and refuses to clobber.** Even with dedup closed, an
   export path that silently overwrites is a data-loss bug waiting for the next identity
   mistake. Covered under the handoff section.

### What this model is not

It is not cross-run deduplication. A lead accepted in Monday's run may legitimately be
processed again in Friday's, because the signal, the enrichment, and the human's judgement may
all have moved. Suppression across runs is a policy question with a retention window attached,
and inventing one here would be scope this milestone did not earn. The ledger makes the prior
motion visible; deciding how long it suppresses the next one is deferred, and named here so a
reader does not mistake the silence for an oversight.

## The approval-hash design

**An approval binds to a draft-content hash, never to a lead id.**

```
draft_hash = "draft-" + sha256(canonical({ to, subject, body, template, claim_refs }))[0:16]
```

The draft stage computes it and attaches it to the lead as `draft_hash`, a sibling of `draft`
rather than a field inside it, so the hash is never part of its own preimage. Gate, queue and
handoff each **recompute it from the draft they are holding and compare**. A mismatch is
`DRAFT_HASH_MISMATCH`, a refusal, because a draft that changed between stages is a draft
nobody approved.

The decision store is a list of records, not a map keyed by lead:

```json
{ "draft_hash": "draft-...", "lead_id": "lead-...", "decision": "approve",
  "by": "dana.reviewer", "at": "2026-03-01T08:56:00.000Z", "note": "optional" }
```

The queue stage resolves a decision in this order, and the order is the whole safety property:

| Lookup result | Verdict | Reason code |
|---|---|---|
| A record whose `draft_hash` equals this draft's, `decision: approve` | PASS | `APPROVED_BY_HUMAN` |
| A record whose `draft_hash` equals this draft's, `decision: reject` | REFUSE | `REJECTED_BY_HUMAN` |
| A record whose `draft_hash` matches but whose `lead_id` does not | REFUSE | `APPROVAL_LEAD_MISMATCH` |
| No hash match, but a record exists for this `lead_id` | NEEDS_HUMAN | `APPROVAL_STALE` |
| A record with an uninterpretable `decision` | NEEDS_HUMAN | `AWAITING_APPROVAL` |
| Nothing on record | NEEDS_HUMAN | `AWAITING_APPROVAL` |

The fourth row is the M1 review's demo, closed. The human approved a draft; the draft changed;
the old decision no longer covers it and the lead parks for a fresh look.

The third row is belt and braces. Keying on content makes cross-lead reuse structurally
unlikely, since two leads have different recipients and therefore different hashes. It does not
make a hand-edited decision store harmless, so the lead binding is checked as well as recorded.

### Why APPROVAL_STALE parks rather than refuses

**NEEDS_HUMAN, argued rather than assumed.** The three verdicts mean different things, and a
stale approval is precisely the state NEEDS_HUMAN exists to name. Nothing is wrong with the
draft; the gate passed it. What is missing is authorization, which is the same thing that is
missing on a draft no one has looked at yet. Refusing would file "a human needs to look at
this" under the same verdict as "this draft asserts a fact no source supports," and a reader
grading refusals by reason code would be reading two different problems as one.

The safety property does not depend on the choice. A parked lead does not advance, so the
second draft reaches handoff in neither routing. The choice is about whether the ledger tells
the truth about why it stopped.

## The three-part gate

M1's gate was the deterministic rule layer. M2 keeps every M1 rule and adds three parts. Rule
order is stable and meaningful, because the reported reason code is the first violation in this
order:

| # | Rule | Added in | Refuses with |
|---|---|---|---|
| 1 | `placeholder_resolution` | M1 | `PLACEHOLDER_UNRESOLVED` |
| 2 | `claim_grounding` | M1 | `UNGROUNDED_CLAIM` |
| 3 | `prose_grounding` | **M2 (c)** | `UNGROUNDED_PROSE_CLAIM` |
| 4 | `pii_redaction` | **M2 (a)**, replacing M1's `pii_leakage` | `PII_IN_BODY`, `REDACTION_INCOMPLETE` |
| 5 | `banned_phrases` | M1 | `BANNED_PHRASE` |
| 6 | `length_bounds` | M1 | `DRAFT_TOO_SHORT`, `DRAFT_TOO_LONG` |
| 7 | `llm_rubric` | **M2 (b)** | `RUBRIC_UNAVAILABLE`, `RUBRIC_MISMATCH`, `RUBRIC_MALFORMED`, `RUBRIC_FAILED` |

### (a) Fail-closed PII redaction

redaction-gate's public pattern is asymmetric: redaction and verification are **two different
passes with two different detectors**, and the write is refused when the second pass still
finds something. A single-pass regex that reports what it found cannot tell "there was no PII"
apart from "my pattern did not match," and those are the two cases that matter.

Implemented as `redact(text)` followed by `assertClean(redacted)`:

- `redact` replaces each recognised pattern with a typed placeholder and returns what it hit.
- `assertClean` runs an **independent, broader** structural detector over the redacted text.
- Redaction found something → `PII_IN_BODY`. This is outbound mail, so PII in the body is the
  violation itself. Nothing is ever sent in redacted form; redaction here is the mechanism that
  produces a checkable proof of completeness, not a repair.
- `assertClean` still finds something after redaction → `REDACTION_INCOMPLETE`, a strictly
  more severe refusal, because the gate cannot even characterise what is in the draft.

The recipient's own address remains exempt, as in M1. Writing to someone is not leaking them.

### (b) Deterministic rules plus a fail-closed LLM rubric

gtm-agent-evals' public pattern: **silence is not a pass.** Every way the rubric can fail to
deliver a clean verdict is a refusal.

In fixture mode the rubric runs on recorded judge responses through `ctx.fetch`, which is
keyless and deterministic. The request URL is `<gate.rubric.endpoint>/<draft_hash>`, so the
recording binds to the content judged. The live-key path is M4 and out of scope; what M2 owes
is the seam, and the seam is that the rubric's only contact with the outside world is
`ctx.fetch`, exactly like enrichment's.

| Condition | Reason code |
|---|---|
| The fetch throws, or the response is not 200 | `RUBRIC_UNAVAILABLE` |
| `body.draft_hash` is not this draft's hash | `RUBRIC_MISMATCH` |
| Verdict absent or unrecognised; criteria missing, not a list, or missing a required name; any criterion verdict unrecognised | `RUBRIC_MALFORMED` |
| Overall verdict FAIL, or any single criterion FAIL | `RUBRIC_FAILED` |

`RUBRIC_MISMATCH` is the same lesson as the approval hash, applied to the judge. A recorded
verdict that was not made about this exact draft is a verdict about something else, and reusing
it would repeat the M1 approval bug one layer down.

The rubric runs only after the deterministic rules come back clean. A draft already known to be
broken does not need a judge's opinion, and in live mode it would not deserve the spend. This
short-circuit never weakens fail-closed, because a short-circuit only ever happens on the path
that was already refusing.

### (c) The claim-grounding check, extended to prose

M1 verified structured `claim_refs` and could not see a factual assertion written as free
prose. `test/adversarial.test.mjs` asserts that gap deliberately, with a comment instructing
whoever lands M2 to flip it. **Flipping it is part of this milestone's definition of done.**

The check is lexical and deterministic, in the business-brain tradition, and it is **typed**:
an assertion of a given kind grounds only against a claim field that can carry that kind of
fact, never against any string that happens to contain the token.

| Assertion detected in the body | Grounds only against |
|---|---|
| A funding stage (`Series A`–`Series F`, `seed round`, `IPO`, `raised …`) | a cited `funding_stage` claim |
| A headcount (`N people`, `N employees`, `N staff`) | a cited `employee_count` claim |
| A revenue or valuation figure (`$N`, `$Nm`, `$N million`) | a cited `revenue` or `valuation` claim |

Typing is what makes the check correct rather than merely strict. Untyped support would let a
poisoned `industry` string containing the words "Series C" ground a Series C assertion, which
is precisely the failure mode the rule exists to catch. It also makes a *contradiction*
refusable: a body asserting Series C against a cited `funding_stage` of "series B" has a claim
of the right type that does not support it, and that refuses.

The rubric's `claim_grounding` criterion is the second layer, for what lexical rules miss. Two
layers rather than one, because the deterministic layer is the one that still works with no key.

## Handoff adapter depth

**The adapter contract, documented in `docs/ADAPTERS.md` and enforced by a conformance test**
in the same family as the stage-contract conformance harness:

```js
{
  name: string,              // equals its registry key
  extension: string,         // the file extension its serialised form takes
  render(lead, ctx) -> artifact,     // pure, deterministic, no I/O, never marks anything sent
  serialize(artifact) -> string      // the bytes the CLI writes
}
```

Two adapters ship. `dry-run-json` is the M1 reference adapter, refitted to the contract.
`eml` renders RFC-5322-shaped message bytes to a file that no client is wired to send. Neither
performs I/O; the stage returns the artifact and the CLI writes it, exactly as in M1. SMTP,
HeyReach and every other real sender remain non-scope in the open repo, in every milestone.

**Only approved draft hashes are exportable.** Handoff recomputes the draft hash and refuses
unless `lead.approval.draft_hash` equals it (`APPROVAL_HASH_MISMATCH`), on top of M1's check
that an approval exists at all (`NOT_APPROVED`).

**Export naming cannot overwrite a prior run's export.** Artifacts are written to
`runs/<run-id>/handoffs/<lead-id>-<draft-hash>.<ext>`. Run scoping separates runs, the draft
hash separates two different messages to one person, and the writer refuses when a path exists
whose bytes differ from what is about to be written. Identical bytes are an idempotent re-run
and are allowed, which is what keeps `run` safe to invoke twice into the same directory.

## The sealed terminal ledger entry

The M1 review's missing question 1: a hash chain proves order and integrity, **not
completeness**. Truncating the last lines of a ledger leaves a chain that verifies clean, and
the review demonstrated it. In scope now because M2 rewrites ledger semantics anyway.

Every completed run appends one terminal entry, written by the kernel, which remains the only
ledger writer:

```
stage: "seal", verdict: PASS, actor: "system", lead_id: "-", sealed: true,
summary: { PASS, NEEDS_HUMAN, REFUSE, total }, head: <hash of the entry before the seal>
```

`head` duplicates what the seal's own `prev` link says, deliberately. It is inside the hashed
payload, so editing the summary or the head breaks the seal's own hash rather than merely
disagreeing with it.

`replay` gains two refusals ahead of its existing two:

| Condition | Reason |
|---|---|
| The ledger has no entries | `LEDGER_EMPTY` |
| The last entry is not a seal | `LEDGER_UNSEALED` |

Truncation is caught as `LEDGER_UNSEALED`, because the seal is the last line and removing any
suffix removes it. `lead_id: "-"` is a sentinel no derived lead id can collide with, so
`explain` never surfaces the seal as a lead.

## First-touch fixes, each its own commit

1. **`docs/M1-SPEC.md` cites a file that does not exist.** Its gates section names
   `test/package.test.mjs`; the zero-dependency checks live in `test/repo-hygiene.test.mjs`.
   Corrected, and the divergence register made honest: M1 claimed "nothing else" while in fact
   diverging twice more. The design says "HMAC over raw bytes" and M1 implements HMAC over the
   canonical serialisation of the parsed payload, which is a different threat model and worth
   naming. The design lists a DLQ in the ingest row and M1 ships none.
2. **`.gitattributes` forcing LF** on every text file the tests read. The golden ledger is
   compared byte for byte and the README examples are compared line by line, so a clone with
   `core.autocrlf=true` fails a suite that has nothing wrong with it.
3. **The CLI's next-step hint says `signal-desk explain`,** which is not on PATH in a fresh
   clone with no install step. Changed to `node bin/signal-desk.mjs explain`, matching the form
   every other instruction in the repo uses. The README's verified block moves in the same
   commit, which is the freshness test doing its job.
4. **The gate's PHONE regex comment claims a false cost.** It justified a deliberately loose
   pattern with "the cost of a false positive here is a human glance," but a gate refusal is
   terminal for that lead in that run. Nobody glances at anything.

   **The call: fix the comment, keep the gate terminal.** Routing PII to NEEDS_HUMAN was the
   alternative and it is the wrong trade. It would open a second parking path competing with
   the queue's send boundary, and it would make the gate's one job — being a hard stop —
   conditional. The loose pattern is still correct, for a better reason than the one that was
   written down: the costs are asymmetric. A falsely refused draft is recoverable by editing
   and re-running. A leaked phone number is not recoverable at all.

## Divergences from docs/DESIGN.md

1. **`fixtures/approvals.json` changes shape, from a lead-keyed map to a list of
   hash-bound records.** M1 introduced this file as a stand-in and named it as its one
   divergence. M2 keeps the file and rebuilds it around the identity decision above, so the
   divergence persists in a corrected form rather than being retired.
2. **`fixtures/rubric.json` is new.** Recorded judge responses, kept separate from
   `fixtures/recordings.json` because they are *derived* from the drafts the pipeline produces
   rather than hand-authored, and are regenerated by a script like the golden file. The runner
   merges both into one recordings map, so `ctx.fetch` is unchanged and stages cannot tell the
   difference. Justified by (b) above: a recording keyed on the draft hash is what stops a
   stale verdict authorising a draft it was not about.
3. **A local decision store, `runs/approvals.jsonl`.** The design's CLI verbs mutate state and
   the design does not say where that state lives. Decisions recorded by `approve`/`reject`
   append here; the runner layers them over the shipped fixture corpus. It sits under the runs
   directory because it is run output rather than repo content, so a fresh clone behaves
   identically for everyone and the demo corpus stays pristine.
4. **`seal` is a ninth stage name in the ledger, not a ninth pipeline stage.** The pipeline is
   still the eight stages in `src/config.mjs`. The seal is a kernel-written record of the run
   itself, which is why it files under the `-` sentinel rather than a lead.
5. Nothing else. The stage list, the contract shape, the ledger entry shape, the CLI verb
   names, the modes, and the non-scope list are implemented as written.

## Gates this lane runs on every commit

Named here per the lane rules, and run on every commit rather than at the end.

- **Test suite:** `npm test` (`node --test test/**/*.test.mjs`). Zero dev dependencies.
- **Freshness, three surfaces that must move in the same commit as the code that staled them:**
  `test/readme-examples.test.mjs` executes the README's console blocks and compares them;
  `test/golden-ledger.test.mjs` pins the fixture run's ledger byte for byte, regenerated with
  `npm run golden:update`; `test/runner.test.mjs` compares the committed fixture corpus against
  its generator, regenerated with `node scripts/make-fixtures.mjs` and
  `node scripts/record-rubric.mjs`.
- **Zero-dependency and no-I/O-in-stages:** `test/repo-hygiene.test.mjs`.
- **Contract conformance:** `test/contract-conformance.test.mjs` for stages, and a new adapter
  conformance test in the same shape for the sender registry.
- **Keyless proof:** `test/cli.test.mjs` runs the demo under a bare environment carrying only
  PATH and HOME, which is what proves the rubric did not quietly acquire a key.

## Definition of done

A stranger clones, `npm test` is green, and `node bin/signal-desk.mjs run` works with no key
and no network. The run visibly refuses a PII-bearing draft, a rubric-failing draft and an
ungrounded-prose draft, each naming its own reason code. `queue`, `approve` and `reject` are
exercisable end to end against the demo corpus. `replay` verifies a sealed chain and refuses a
truncated one. The adversarial test's M1-gap assertion is flipped to REFUSE and its comment is
gone.

---

## Implementation addendum, written after the lane ran

The spec above was committed first, before any code. This section records what the
implementation actually taught, because a spec that is quietly edited to match what got built
is not a spec.

### Things the spec did not anticipate

1. **The decision store became a hash-chained ledger, not a plain JSONL list.** The spec said
   decisions append to `runs/approvals.jsonl` and left the format open. Writing it made the
   argument obvious: rewriting *which draft* a decision covers is precisely the attack the
   content hash exists to prevent, so the file holding the binding needs the same
   tamper-evidence as the run ledger. Decisions are now ledger entries with `actor: human` and
   `stage: approval`, and a broken chain refuses every command that reads them. This also
   satisfies the dispatch's "record the decision into the ledger (actor: human)" more directly
   than the run-ledger path alone did.

2. **"Latest run" was a real bug, and the tests found it rather than review.**
   `test/approval-workflow.test.mjs` failed intermittently, twice in eight runs. The cause: both
   `queue` and `explain` resolved the latest run by sorting run ids and taking the last. A run
   id is a hash of the inputs and carries no temporal ordering, and approving a draft changes
   the inputs, so the next run's id sorted *before* the previous one about half the time. The
   consequence was user-visible and serious: `queue` would show a stale run's parked drafts and
   invite a human to approve a draft already decided. `run` now writes an explicit pointer.
   `explain` had the same defect since M1.

3. **A second decision on one draft needed a rule.** The spec's resolution table assumed at most
   one decision per hash. An append-only store makes two possible, and a human changing their
   mind is a legitimate thing to do. The latest decision binds; the superseded one stays on
   record, because the history of what was decided and when is the product.

4. **Approving by prefix.** Not in the spec and obviously necessary once the output existed:
   nobody retypes a 16-character hash. An unambiguous prefix of a draft hash or a lead id
   resolves; an ambiguous one is an error naming every match, never a guess.

### Things the spec got right and the implementation confirmed

- Typing the prose-grounding check was the load-bearing decision. The corpus now ships a
  poisoned `industry` string containing "Series C", and an untyped check would have to pass it.
- Short-circuiting the rubric behind the deterministic rules cost nothing and is provable: a
  counting fetcher shows the judge is never called for a draft already known broken.
- `APPROVAL_STALE` as NEEDS_HUMAN rather than REFUSE reads correctly in the run summary, where
  it sits next to `AWAITING_APPROVAL` and means the same thing to the operator.

### One assertion I got wrong, recorded because the reviewer will see the diff

When flipping the M1-gap adversarial test, I asserted one lead would be refused for its prose.
Two were, because the poisoned play is `executive-intro` and both priority-band leads route to
it. Adding the hostile fixtures later made it five. The assertion now derives the expected count
from the leads actually routed to that play, so growing the corpus cannot silently weaken it.

### Counts

Base `ce0b9de` (merged M1): 331 tests. Golden ledger 32 -> 55 entries. Demo corpus 6 -> 10
signals, 4 -> 8 refusals, one survivor throughout. Test count at the end of the first pass was
520; see the fix-wave section below for where it finished.


---

## Fix wave 1, after the independent ship-check

The ship-check returned BLOCK. This section records what it found and what changed, because a
spec that only describes the version that passed is a spec that hides the review.

Every finding was **reproduced before being fixed**, and re-probed after.

### BLOCKER: `replay` ignored the decisions store

`verbReplay` rebuilt the run with `buildRun({ fixtures: loadFixtures() })` and omitted the
`decisions` that `verbRun` layers in. Any run that acted on a human approval therefore replayed
as the fixture-only run, produced a different run id, and told the user "the inputs or the
wiring have changed since that run" — blaming them for a wiring bug, at the happy path's final
step.

It shipped because **no test walked `run` → `approve` → `run` → `replay`**. The approval
workflow tests stopped at the second `run`. Four subprocess tests now cover it, including the
seal summary on a post-approval run, and one pinning the genuine limitation that a PRE-approval
run stops replaying once a decision exists, since replay re-executes from current inputs.

### IMPORTANT: the JSON writer stripped every nested object

`stableJson` passed `Object.keys(value).sort()` to `JSON.stringify` as a **replacer array**,
which is an allowlist of key names applied at *every* nesting depth. Every export shipped
`"claim_refs": [{}]`, so the citation grounding each claim — the evidence this whole pipeline
exists to carry — was missing from the artifact.

The lesson is about where assertions were pointed. Every existing conformance test read
`adapter.render()`, and the rendered object was always correct; the loss happened in the writer.
The harness now asserts on the **serialised bytes** for every adapter, plus a round-trip check.
That byte assertion immediately caught a second gap: the `eml` adapter's serialised form carried
no evidence at all, now fixed with `X-Signal-Desk-Claim` / `X-Signal-Desk-Citations` headers.

### IMPORTANT: the rubric fail-opened against its own spec

This document promised "any single criterion FAIL"; the code inspected only criteria named in
`requiredCriteria`. A judge volunteering `legal_risk: FAIL` was ignored and the draft passed.

Reconciled toward the code, and the reason is this module's one rule rather than a general
preference. "Silence is not a pass" exists so an unanswered question cannot read as approval.
Discarding a volunteered FAIL is that mistake pointed the other way: treating something the
judge actually *said* as if it had not been said. `requiredCriteria` keeps its meaning — the
questions that must be answered — and was never the list of answers allowed to matter.

### Minors fixed rather than filed

- **PII appeared verbatim in refusal details**, and therefore in the committed golden ledger.
  Judged: withhold it. The gate refuses so a value does not travel; carrying it into the
  durable, shareable record makes the safeguard the mechanism of the leak. Details now name the
  kind of finding. The operator loses nothing, because the draft still holds its own text.
- **Compatibility-form PII bypassed both detectors.** A fullwidth `＠` and fullwidth digits went
  through silently. Both passes now normalise with NFKC before matching.
- **Deciding twice was silent.** `approve` on an already-approved draft appended a duplicate and
  printed success. It now reports the standing decision and records nothing.
- **`README.md` pointed at `docs/M1-SPEC.md`** as what the current milestone built.

## Deferred, explicitly

Not solved, not hidden. Each is pinned by a test that fails if someone closes it, and each is
named in the README's "Known boundaries".

| Deferral | Why it is not in M2 |
|---|---|
| **The ledger chain is unkeyed.** A fully recomputed chain and seal verify clean; only re-execution catches a rewritten ledger | Closing it at the integrity layer needs a signing key, and a key makes this a hosted-secret tool. `replay`'s byte comparison is the check that does the work, which is why it is reported separately |
| **Homoglyph PII adjacent to an `@`.** NFKC folds compatibility forms but not Cyrillic а onto Latin a | Needs a Unicode confusables table, which is different work from normalisation. The gap is narrower than it looks: a homoglyph mid-local-part is still caught, since the ASCII run either side matches |
| **Approvals never expire.** A decision binds to a draft hash indefinitely | An expiry window is a policy decision with a number attached, and inventing one here would be scope this milestone did not earn |
| **Deduplication is per run.** A lead accepted Monday can be processed again Friday | Same reason: cross-run suppression needs a retention window. Accepted as argued by the ship-check |
| **Recordings sit outside the run id**, consistent with M1 | Two runs with different recordings share an id. Accepted as argued; a candidate for M3 |

### Final counts

531 tests at the start of the fix wave's first commit, **549** at its end, all green. Every
commit in the wave was red first.
