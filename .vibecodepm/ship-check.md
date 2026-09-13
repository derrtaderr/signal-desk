---
date: 2026-09-13
status: draft
phase: ship-check
---

```yaml
goal: an inspectable, refusable signal-to-outreach pipeline that earns trust before autonomy
user: a GTM engineer with their own Anthropic key who must know exactly what leaves their machine
phase: ship-check
critical_assumption: nothing a run writes can carry a credential, and the approval loop closes in every mode
decision: BLOCK — the live approval loop never closes (decisions ignored), and the shareable run capture contains the HMAC signing secret in plaintext
hard_gate: approve → run --live → handoff works and is tested; inputs.json carries no credential (with replay semantics decided, not defaulted); the evidence transport's parse-path details are scrubbed and capped; key-hygiene test greps BOTH secrets
success_window: carried from metrics.md — clone to completed run under two minutes, every refusal interpretable without reading source
```

# Ship-check — signal-desk M4 (lane/signal-desk-m4, PR #4, base fa715d0, head 4f1caf6)

Reviewer: lane-signal-desk-m2-reviewer (continuing; builder was lane-signal-desk-m4-builder).
Suite 831 tests / 830 pass / 1 skipped (double-gated smoke) / exit 0, keyless. All evidence
below is the reviewer's own runs through injected fake transports with canary credentials.

## Verdict: BLOCK

### Blocking findings

1. **No live lead can ever be delivered: the live path ignores the decision store.**
   `src/cli.mjs` executeLive calls `buildLiveRun` without `decisions: loadDecisions(base)`
   (the parameter exists and defaults to `[]`). Probed end to end: `run --live` parks a draft →
   `queue` shows it → `approve` records it and prints "Run again to act on it" → the next
   `run --live` parks the IDENTICAL draft `AWAITING_APPROVAL` (not `APPROVAL_STALE`, proving
   the store never reached the queue stage). flow.md's approval table ("Decision acted on →
   the next run") and the approve verb's own output are both false in live mode; "live mode
   ends at the approval queue" is true in the wrong sense — nothing can ever leave it. This is
   the exact recurrence class of the M2 replay blocker; no live-cli test exercises
   approve → run --live. The approve hint also names `run`, not `run --live` — fix the printed
   next step with the wiring.
2. **The shareable run artifact contains the signing secret in plaintext.**
   `runs/<run-id>/inputs.json` embeds the live config, and `config.ingest.secret` IS
   `SIGNAL_DESK_SIGNAL_SECRET` (probed: canary secret present in every live run's inputs.json).
   README: "Hand somebody the run directory and they can re-derive every decision in it
   without your credentials" and "never sent: your signal secret"; capture.mjs: "No key, no
   headers." A recipient of a shared run dir can forge validly-signed signals for your live
   ingest. `test/key-hygiene.test.mjs` sets a canary SECRET but only ever greps for the model
   KEY (lines 93–95), which is why this passed. Note the real design tension: replay's raw-HMAC
   ingest re-verification currently needs the secret, so the fix is a decision (redact and
   record the verification outcome, or require the env secret to replay a live run), not a
   deletion — and the key-hygiene test must gain the secret as a second asserted canary.

### Important

3. **Scrub bypass in the evidence transport's parse path.** `src/live/http.mjs`
   parseJsonObject: `SOURCE_UNPARSEABLE` details interpolate `JSON.stringify(parsed)` —
   probed: a source answering 200 with a JSON string containing the canary key put the FULL
   KEY into the ledger (and from there the dashboard) — and `error.message` from JSON.parse,
   which embeds a body snippet; neither passes through `scrub`, and the stringify path is
   uncapped (a 256KB JSON string floods the ledger). README's "every message relayed from
   outside is scrubbed first" is false on these two paths. One-line fix plus a cap, plus a
   200-string-body hostile source in the key-hygiene test.
4. **Silent flag swallowing** (advocate, high): `run --liev` and `run --live=true` run the
   FIXTURE pipeline and exit 0 — a plausible success nobody chose on exactly the live/fixture
   boundary; `dlq --replya` lists instead of replaying, exit 0. Violates flow.md's own
   "every way of getting the setup wrong fails immediately."
5. **README carries two stale M3-era passages** (advocate): "there is no model in the drafting
   path yet, and M4 ends that" (~lines 258–264 and 586–588) — contradicting the shipped
   milestone on the injection question, the exact topic the key-setting reader needs settled.

### Minor

6. The README never states that no call was ever made against the real Messages API; the
   disclosure lives only in the spec and the smoke test's skip annotation. One sentence owed.
7. The trust section never literally names api.anthropic.com; the export commands precede the
   trust story; the usage `dashboard` row is misaligned (all advocate).
8. `dlq --replay` demands both live credentials even to re-feed letters that will re-fail at
   ingest; and a letter re-fed outside the replay window dead-letters under a new reason file
   (bounded, but the "fix at the sender" story has no answer for staleness).
9. `sourcesFrom: 'signal'` SSRF surface unstated: a compromised trusted sender can point the
   pipeline at internal HTTPS endpoints (https-only blocks cloud metadata; internal HTTPS
   services remain reachable; no host allowlist exists or is named). See open question 1.

### What passed, with evidence

Fail-closed matrix 7/7 (429, 500, timeout, malformed JSON, empty content, refusal,
model-obeys-injection): each REFUSEs with its named code, no template fallback ever, every run
seals. HMAC raw-bytes: tampered → SIGNATURE_INVALID, unsigned → SIGNATURE_MISSING, both
dead-lettered; parse-vs-bytes agreement enforced; unparseable payloads dead-letter. DLQ replay
re-feeds the same bytes, digest-named files cannot multiply, boundary (ingest-only, duplicates
excluded) held under probing. No-network gate genuinely fails when a test gains the transport
import (mutation-tested). Keyless subprocess replay of a live-captured run: byte-identical,
exit 0, reproduced. The three M3 review-binding fixes verified against the original probes:
fieldless/unknown-field identity → IDENTITY_UNVERIFIED, future-dated as_of → REFUSE
EVIDENCE_FUTURE_DATED with 5-minute skew tolerance honored, quoted injection spans redacted
(tel: number → [redacted:phone]) with the withhold path for unverifiable spans. Clock fix
sound: only now() consumes in both clock implementations, peek non-consuming in both, and the
forced-apart-reads regression guard exists (test/live-cli.test.mjs:74–86). Recordings enter
the run id as argued; the fixture golden is structurally identical to M3 (83/83 entries, only
ids and hashes moved). Egress matches the README's field list: the draft prompt withholds the
recipient address; the rubric sends draft + cited claims only; the untrusted fence is
content-derived and deterministic.

### The builder's disclosures, weighed

(1) No live provider call was ever made: correctly handled in the spec and the double-gated
smoke test; the README owes the one sentence (minor 6) but nothing rises to overstatement.
(2) Mandatory SIGNAL_DESK_SIGNAL_SECRET: ACCEPT — silently unverified live ingest is the
"quiet acceptance" failure this repo exists to refuse; the refusal argues itself and the
staircase UX teaches one step at a time (advocate confirmed). Right call, properly disclosed.
(3) The three self-found composition bugs are real and their guards are in the tree; the
scrubber's coverage gap (finding 3) is the remainder of the second one.

### The builder's four open questions, judged

1. **sourcesFrom: 'signal' — ACCEPT the trust placement, with a named cost.** The signer holds
   the HMAC secret and is by definition the trusted party; fetches are HTTPS-only, bounded,
   redirect-free, and everything fetched is treated as untrusted downstream. What is missing is
   the NAME for the residual surface: a compromised sender can aim the pipeline at internal
   HTTPS endpoints. State it in the trust boundaries; an optional host allowlist is the
   future-shaped fix. 2. **DLQ boundary — ACCEPT**; only ingest refusals have a fix at the
   sender, and retaining gate refusals invites retry-until-pass. Probes agreed. 3.
   **fetched_at outside the recorded sequence — ACCEPT, verified** rather than trusted: clock
   consumption counts align, byte-identical replay reproduced, regression guard present. 4.
   **Two mandatory secrets — ACCEPT** (see disclosures above).

### Advocate walk

Trust-story walk passed narrowly: every provokable refusal fired before anything was read,
written, or fetched, and the filesystem agreed with every message when checked behind its
back. The trust-boundaries section plus the named canary test built the trust; the silent
flag swallowing (finding 4) and the stale injection passages (finding 5) are what spent it.

### What has to be true to clear

Live runs layer `loadDecisions` exactly as fixture runs do, with a subprocess test walking
run --live → approve → run --live → handoff, and the approve hint naming the right command;
inputs.json carries no credential, with replay's ingest-verification semantics decided and
documented, and the key-hygiene test asserting the secret canary across every written file;
http.mjs parse-path details scrubbed and capped, with a 200-string-body hostile source added
to the hygiene test. Findings 4–5 strongly recommended in the same wave; 6–9 recordable.
