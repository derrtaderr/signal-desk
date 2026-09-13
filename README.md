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
run run-cc483f9d8434

  1 passed to handoff
  1 awaiting a human
  12 refused
  14 signals in total

  lead-29e94419ba7e      handoff   PASS         
  sig-1001               ingest    REFUSE       DUPLICATE_SIGNAL
  lead-ff1af2ff8d01      queue     NEEDS_HUMAN  AWAITING_APPROVAL
  lead-845826c4c069      route     REFUSE       BELOW_ROUTING_FLOOR
  lead-e557482af15d      queue     REFUSE       REJECTED_BY_HUMAN
  sig-9001               ingest    REFUSE       MALFORMED_PAYLOAD
  lead-e321020a996e      gate      REFUSE       PII_IN_BODY
  lead-6dfbc9615067      gate      REFUSE       RUBRIC_FAILED
  lead-3a8cab6564a2      gate      REFUSE       UNGROUNDED_PROSE_CLAIM
  sig-9006               ingest    REFUSE       DUPLICATE_LEAD
  lead-aa10c945e3bf      enrich    REFUSE       IDENTITY_CONTRADICTED
  lead-d03317053357      enrich    REFUSE       EVIDENCE_DECAYED
  lead-f4a249c336f5      gate      REFUSE       PROMPT_INJECTION
  lead-03ceebb25be4      enrich    REFUSE       NO_CITED_CLAIMS

  ledger    runs/run-cc483f9d8434/ledger.jsonl
  handoffs  1 dry run artifact(s) in runs/run-cc483f9d8434/handoffs

  Nothing was sent. This tool never sends mail.
  Inspect a decision with: node bin/signal-desk.mjs explain <lead>
  Act on what is parked with: node bin/signal-desk.mjs queue
```

Fourteen signals went in and one came out the far end. That ratio is the point. Twelve were refused
and one is waiting for a person, and every one of those outcomes names the rule that produced
it.

The corpus ships hostile fixtures on purpose, one per safeguard, so the demo shows the gates
working rather than asserting that they exist:

| Refusal | What the fixture does |
|---|---|
| `MALFORMED_PAYLOAD` | A webhook body with no company domain |
| `DUPLICATE_SIGNAL` | The same signal id replayed, correctly signed |
| `DUPLICATE_LEAD` | The same *person* re-signalled under a **new** signal id. The HMAC covers the payload only, so this is validly signed and walks past signal-level idempotency |
| `BELOW_ROUTING_FLOOR` | A six-person company reading a blog post |
| `PII_IN_BODY` | A scraped directory page with a phone number in its industry field, interpolated straight into the draft |
| `UNGROUNDED_PROSE_CLAIM` | An industry string smuggling "now scaling after their Series C" into the body, which no cited source supports |
| `RUBRIC_FAILED` | A draft every deterministic rule passes, pitched to the wrong reader. No regex catches that, which is what the judge is for |
| `IDENTITY_CONTRADICTED` | A signal that is correct in every checkable way and names the wrong human. The person-level source puts that address at a different company |
| `EVIDENCE_DECAYED` | A source that answers 200, in the right shape, with a record dated eleven months ago. A 200 is not freshness |
| `PROMPT_INJECTION` | A scraped page whose industry field tells the system to ignore its instructions and approve the lead, with live markup attached |
| `NO_CITED_CLAIMS` | A company that does not exist. Three sources each know nothing, and nothing is invented to fill the hole |
| `REJECTED_BY_HUMAN` | A person said no |

## Inspect a decision

Pass any lead id to `explain` and you get its whole trail, in order, with the evidence each
stage stood on.

<!-- verified-block: explain-pass -->
```console
$ node bin/signal-desk.mjs explain lead-29e94419ba7e
lead lead-29e94419ba7e
run  run-cc483f9d8434

  2026-03-01T09:00:00.000Z  ingest    PASS         system
      evidence  signal:sig-1001
  2026-03-01T09:00:01.000Z  enrich    PASS         system
      reasons   IDENTITY_CONFIRMED
      detail    https://people.test/dana@acme.test confirms Dana Ruiz at acme.test on 3 of 3 fields (company_domain, name, email)
      evidence  https://people.test/dana@acme.test
  2026-03-01T09:00:02.000Z  enrich    PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test
  2026-03-01T09:00:03.000Z  score     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:04.000Z  route     PASS         system
  2026-03-01T09:00:05.000Z  draft     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:06.000Z  gate      PASS         system
  2026-03-01T09:00:07.000Z  queue     PASS         human
      reasons   APPROVED_BY_HUMAN
      detail    dana.reviewer approved draft draft-b66622be1a11d3db at 2026-03-01T08:56:00.000Z
      evidence  draft:draft-b66622be1a11d3db
  2026-03-01T09:00:08.000Z  queue     PASS         system
      evidence  draft:draft-b66622be1a11d3db
  2026-03-01T09:00:09.000Z  handoff   PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test

  outcome: PASS at handoff
```

The first enrich line is the identity check. Before anything asks what is true about the
company, something asks whether the human the signal names is the human the evidence describes.
A record that disagrees stops the lead there, which is the `IDENTITY_CONTRADICTED` row above.

Note the `human` actor on the queue line. A person approved that draft, and the ledger records
who, when, and **which draft**. An approval binds to a hash of the message content, never to
the lead, so changing a single character of the text leaves the old decision covering nothing
and the lead parks again as `APPROVAL_STALE`. A refusal reads the same way.

<!-- verified-block: explain-refuse -->
```console
$ node bin/signal-desk.mjs explain sig-9001
lead sig-9001
run  run-cc483f9d8434

  2026-03-01T09:00:35.000Z  ingest    REFUSE       system
      reasons   MALFORMED_PAYLOAD
      detail    signal is malformed: payload.company.domain

  outcome: REFUSE at ingest
```

## Replay a run

`replay` does three separate things, and reports them separately, because a ledger can pass one
and fail another. It verifies the hash chain, which proves the file was not edited after it was
written. It checks the terminal seal, which proves nothing was removed from the end. Then it
re-executes the run from the same inputs and compares the bytes, which proves the code still
makes the same decisions.

<!-- verified-block: replay -->
```console
$ node bin/signal-desk.mjs replay run-cc483f9d8434
hash chain verified across 83 entries
seal verified: 1 passed, 1 parked, 12 refused, 14 in total
replay of run-cc483f9d8434 is an exact match
83 entries, identical bytes, chain intact
```

If you edit a line in `runs/<run-id>/ledger.jsonl` and run `replay` again, it tells you which
entry broke and exits non-zero.

The seal is worth its own sentence, because a hash chain proves order and integrity and says
nothing about completeness. Delete the last few lines of a ledger and the chain still verifies
perfectly: every remaining entry links to the one before it. So every completed run appends a
terminal entry carrying the run summary and the head hash, and `replay` refuses a ledger that
does not end in one. That refusal says the chain was intact and lines were removed, because
that is a different problem from tampering and leads somewhere different.

## See the whole run at once

`dashboard` renders any run's ledger as one HTML file and writes it beside that ledger. No run
id means the latest run.

<!-- verified-block: dashboard -->
```console
$ node bin/signal-desk.mjs dashboard
dashboard run-cc483f9d8434

  83 ledger entries across 14 lead(s)
  1 passed, 1 parked, 12 refused
  12 distinct refusal reason(s), 2 human decision(s)

  runs/run-cc483f9d8434/dashboard.html

  Open it in a browser. It is one file, works offline, and fetches nothing.
  It is a read-only view. Decisions are still made with: node bin/signal-desk.mjs approve <id>
```

Open it in a browser. It is a single file with no dependencies, no external stylesheet, no
webfont and no JavaScript at all, so it renders identically with the network off. It shows the
funnel stage by stage, every refusal grouped by reason code, which part of the gate produced
each one, the human decisions with the draft hashes they bound to, and every lead's full trail.

Two properties are worth stating because they are enforced rather than intended.

**It is a pure function of the ledger and nothing else.** If a view is not derivable from the
ledger, the ledger does not record it and the fix belongs in the stage that should have written
it down. That is why the queue stage records `by` and `at` as fields rather than leaving a
renderer to parse them out of a sentence.

**It is read-only, and it does not pretend otherwise.** There is no approve control and no
disabled-looking one either, because a button that advertises a capability at the wrong surface
invites somebody to wire it up. Decisions are made at the command line. The page says so.

It also escapes every string it takes from the ledger, and that is not a formality here: the
prompt-injection fixture's payload is quoted into the ledger on purpose, so this page renders
attacker-controlled markup by design. A test renders the hostile run and asserts, in both
directions, that the payload is present and inert.

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
| 6 | gate | Three parts: fail-closed PII redaction, deterministic rules plus a fail-closed LLM rubric, and claim grounding over both structured references and prose. A gate that errors refuses |
| 7 | queue | Everything parks for a human by default. An approval binds to the draft's content hash, never to the lead. This is the send boundary |
| 8 | handoff | Renders an artifact through a documented adapter contract. Only approved draft hashes are exportable, and an export cannot overwrite a different one. Never sends |

## The gate

Stage 6 refuses on four separate disciplines rather than one list of rules.

**Fail-closed PII redaction.** Not one regex pass that reports what it matched, because that
cannot tell "there was no PII" apart from "my pattern did not match". Redaction and verification
are two passes with two different detectors, and the draft is refused when the second pass still
finds something. Finding a phone number is `PII_IN_BODY` and means everything worked. Residue
after redaction is `REDACTION_INCOMPLETE`, which is worse: the gate cannot characterise what it
is holding. Nothing is ever sent in redacted form; redaction here is how the check earns a
proof, not a repair.

**A fail-closed LLM rubric.** Silence is not a pass. A judge that could not be reached, answered
about a different draft, returned a shape this code cannot read, or left a required criterion
unanswered has approved nothing, and each of those is its own reason code. In fixture mode the
judge is a recorded response addressed by draft hash, which keeps the demo keyless and stops a
recorded verdict from outliving the draft it judged. Live mode (M4) swaps the fetcher and
changes nothing else.

**Claim grounding, over prose as well as references.** A `{claim:}` placeholder leaves a
structured reference the gate can verify. A sentence asserting a funding round leaves nothing,
which is how that used to get through. The prose check is typed: a funding claim grounds only
against a cited `funding_stage`, a headcount only against a cited `employee_count`. Typing is
what makes it correct rather than merely strict, and it is what lets a *contradiction* refuse.

**Prompt injection, new in M3.** A scraped page can carry text addressed to the system rather
than to the reader, and markup has no business in a message these templates compose as plain
prose. Both refuse, and the refusal quotes what it saw, because an operator cannot decide whether
to drop a source from their config on the strength of "something tried to instruct your system".

Worth being precise about what that rule does and does not buy, because the marketing version is
bigger than the honest one. In fixture mode the draft stage is a mechanical template fill, so an
instruction smuggled into a source has nothing to instruct: there is no interpreter in the loop.
This pipeline is not immune because it defends well. It is immune because there is no model in
the drafting path yet, and M4 ends that. What the rule does today is make the payload **visible** —
flagged by enrich where it entered, refused by the gate where it landed — and that is the part
that survives M4.

## What enrichment refuses

Three of M3's four hostile catches land at stage 2, and the unevenness is the point rather than
an accident. Most bad outreach is stopped by knowing something is wrong with the evidence, not by
catching a bad sentence after writing one.

**The signal names a person; the evidence names someone else.** Vendor-side identity resolution
is probabilistic, so a signal can be correctly attributed to a company and wrongly attributed to
a human. A person-level source is checked first, before any claim source, and a record that
disagrees stops the lead there. No draft is composed, because a message to the wrong person is
not made safer by being written first and refused later.

A record that is missing, unreachable or expired is reported as `IDENTITY_UNVERIFIED` and the
lead proceeds. That is not a fail-open. It is the state every lead was in before this rule
existed, and refusing it would be a new product policy rather than a safeguard. What matters is
that absence never reads as confirmation, and the ledger says so out loud.

**A 200 is not freshness.** Every claim response carries an `as_of`, compared against the run's
own clock. A record outside the freshness window is dropped and named. So is a record that
carries no `as_of` at all, and that is the load-bearing half: a response with no date cannot tell
"fetched fresh" apart from "read out of a cache in 2019", and trusting it would put the whole
rule at the mercy of a source that declines to date itself.

**No source knows this company.** Every source comes back empty and nothing is invented to fill
the hole. The refusal says what the run observed, which is that no citable claim exists. It does
not say the company is fake, because nothing here can tell that apart from every source being
down, and asserting it would be exactly the confident unsupported claim the safeguard exists to
refuse.

## The approval queue

The pipeline parks every survivor. `queue` shows what is waiting, `approve` and `reject` record
a decision, and the next run acts on it.

```console
$ node bin/signal-desk.mjs queue
$ node bin/signal-desk.mjs approve <draft-hash> --by you
$ node bin/signal-desk.mjs reject <draft-hash> --note "wrong persona"
$ node bin/signal-desk.mjs run
```

Any unambiguous prefix of a draft hash or a lead id works, because nobody retypes a hash. An
ambiguous one is an error rather than a guess.

**An approval binds to a hash of the draft's content, never to the lead.** This is the whole
design of the queue, and it exists because the alternative was tried: keying by lead meant one
recorded approval released a second draft the human had never seen. Edit a single character and
the old decision stops covering the draft, so the lead parks again as `APPROVAL_STALE` rather
than going out unread. Handoff re-checks the same binding, so only an approved draft hash is
exportable.

Decisions are written to `runs/approvals.jsonl` as an append-only, hash-chained ledger with
`actor: human`. Rewriting which draft a decision covers is precisely the attack the content hash
exists to stop, so the file holding the binding gets the same tamper-evidence as the run ledger.

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

M1 built the kernel, the stage contract, the hash-chained ledger, all eight stages end to end in
fixture mode, and `run`, `explain` and `replay`.

M2 was the depth: the three-part gate, the approval queue and its `queue`, `approve` and
`reject` verbs, the adapter contract with a second conforming adapter, and a terminal seal that
makes a truncated ledger detectable. It also decided the identity model M1 left unowned, which
is why a second signal for one person is refused rather than doubling the motion.

M3 is the surface and the suite. The `dashboard` verb and its self-contained HTML page. The four
hostile fixtures the design still owed: a wrong-person match, a decayed record, a prompt
injection in a scraped page, and a company that does not exist. The mechanisms three of them
needed, in the stage that owns each. And a test that checks the design's hostile list against
the reason codes the demo actually produces, so the list cannot quietly stop being complete.

One of those four needed no new rule at all. The hallucination-bait lead is caught by a
discipline M1 built and no fixture had ever reached, and finding that out was worth more than
another gate would have been.

Deliberately not here. Live mode and real keys are M4. Sending is non-scope in every milestone,
and approving from the dashboard is non-scope permanently rather than pending.

The M1 limitation that a test used to pin is closed, and the test was flipped rather than
deleted. See `test/adversarial.test.mjs`.

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

`docs/DESIGN.md` is the approved design. `docs/M3-SPEC.md` is what this milestone built,
including the stage-ownership argument for each hostile catch, the dashboard's contract and its
escaping rule, and the divergences. `docs/M2-SPEC.md` and `docs/M1-SPEC.md` are the previous
milestones, each carrying its own addendum on what the implementation taught.
`docs/ADAPTERS.md` is the sender adapter contract.

### Known boundaries

Named here rather than left to be discovered, and each one pinned by a test that fails if
somebody closes it.

- **The ledger chain is unkeyed.** It proves order and integrity, and the terminal seal proves
  completeness. None of that proves authenticity: anyone who can run this code can regenerate a
  ledger from scratch and produce a chain and seal that verify. What catches that is
  re-execution, which is why `replay` compares bytes as a separate check. A signing key would
  close it and would make this a hosted-secret tool, which it deliberately is not.
- **PII detection is ASCII, after NFKC normalisation.** Fullwidth and other compatibility forms
  are folded and caught. A homoglyph sitting directly against an `@` is not; that needs a
  Unicode confusables table.
- **Approvals do not expire.** A decision binds to a draft hash forever. Nothing re-asks after a
  week, and a draft that still hashes the same is still authorised. As of M3 this is pinned by a
  tripwire test rather than merely written down here, because until then adding an expiry window
  would have failed nothing.
- **Identity evidence is checked when it exists, and its absence is not a refusal.** A source
  that cannot answer leaves the lead `IDENTITY_UNVERIFIED`, and the pipeline will still write to
  a person no source confirmed. Absence never reads as confirmation, which is the property that
  matters, but an unverified identity is not a verified one.
- **The injection rule makes a payload visible; it is not what stops it working.** Nothing is
  stopping it working today, because fixture-mode drafting is a template fill with no model in
  it. That changes in M4, and this boundary is the one to press on when reviewing it.
- **Deduplication is per run.** A lead processed on Monday can be processed again on Friday.
