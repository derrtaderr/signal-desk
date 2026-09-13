// Stage 6 — gate.
//
// The design's full gate is three parts: fail-closed PII redaction, deterministic rules plus a
// fail-closed LLM rubric, and a claim-grounding check. M1 shipped the deterministic rule layer.
// M2 is landing the rest, one part per commit, and this header says which are in:
//
//   (a) fail-closed PII redaction   LANDED, see src/redaction.mjs
//   (b) fail-closed LLM rubric      not yet
//   (c) prose claim grounding       LANDED, see src/prose-claims.mjs
//
// The structure is a list of named rules, every one evaluated, violations collected. Rule order
// is the reported order, so the same broken draft always refuses for the same named reason.
//
// Fail-closed is the invariant, and it is enforced twice. The whole evaluation runs inside a
// try/catch that converts any error into REFUSE/GATE_ERROR, and the kernel converts a throw
// that escapes anyway into REFUSE/STAGE_ERROR. A gate that errors refuses. It never passes.
//
// Fail-closed patterns adapted from redaction-gate and gtm-agent-evals; no code vendored.

import { pass, refuse } from '../contract.mjs';
import { redact, assertClean } from '../redaction.mjs';
import { groundProseClaims } from '../prose-claims.mjs';

const PLACEHOLDER = /\{[a-z0-9_]+(?::[a-z0-9_]+)?\}/i;

// Rule order is stable and meaningful: the reported reason code is the first violation in
// this order, so the same broken draft always refuses for the same named reason.
function evaluateRules(lead, config) {
  const { draft, claims, citations } = lead;
  const text = `${draft.subject}\n${draft.body}`;
  const violations = [];
  const rulesRun = [];

  const bannedPhrases = config.bannedPhrases ?? [];
  if (!Array.isArray(bannedPhrases)) {
    throw new TypeError('gate config bannedPhrases must be an array');
  }

  rulesRun.push('placeholder_resolution');
  if (PLACEHOLDER.test(draft.subject) || PLACEHOLDER.test(draft.body)) {
    violations.push({
      rule: 'placeholder_resolution',
      code: 'PLACEHOLDER_UNRESOLVED',
      detail: 'the composed draft still contains an unresolved placeholder',
    });
  }

  rulesRun.push('claim_grounding');
  for (const ref of draft.claim_refs ?? []) {
    const claim = claims.find((c) => c.field === ref.field);
    if (claim === undefined || !claim.cited || !claim.citation) {
      violations.push({
        rule: 'claim_grounding',
        code: 'UNGROUNDED_CLAIM',
        detail: `the draft asserts "${ref.field}", which is not backed by a cited claim on this lead`,
      });
      continue;
    }
    if (claim.citation !== ref.citation || !citations.includes(ref.citation)) {
      violations.push({
        rule: 'claim_grounding',
        code: 'UNGROUNDED_CLAIM',
        detail: `the draft cites "${ref.citation}" for "${ref.field}", which is not a source this run fetched`,
      });
    }
  }

  // The same grounding discipline, applied to prose rather than to structured references.
  // A {claim:} placeholder leaves a claim_ref the rule above can check. A sentence asserting a
  // funding round leaves nothing, which is why M1 could not see it. See src/prose-claims.mjs.
  rulesRun.push('prose_grounding');
  for (const ungrounded of groundProseClaims(text, claims)) {
    violations.push({
      rule: 'prose_grounding',
      code: 'UNGROUNDED_PROSE_CLAIM',
      detail: ungrounded.detail,
    });
  }

  // Fail-closed redaction, two passes with two detectors. See src/redaction.mjs for why one
  // pass cannot be enough. Nothing is sent in redacted form; redaction here is the mechanism
  // that produces a CHECKABLE proof of completeness, and the draft passes through untouched.
  rulesRun.push('pii_redaction');
  const { redacted, hits } = redact(text, { allow: [String(draft.to)] });
  const verification = assertClean(redacted);

  // Reported first within this rule, because it is the more severe finding. "I found a phone
  // number" means everything worked. "Something is still in there after I redacted" means the
  // gate cannot characterise what it is holding.
  if (!verification.clean) {
    const [first] = verification.found;
    violations.push({
      rule: 'pii_redaction',
      code: 'REDACTION_INCOMPLETE',
      detail:
        `redaction ran and verification still found ${first.type}-shaped content ` +
        `("${first.value}"), so the gate cannot certify what this draft contains`,
    });
  }

  for (const hit of hits) {
    violations.push({
      rule: 'pii_redaction',
      code: 'PII_IN_BODY',
      detail:
        hit.type === 'email'
          ? `the draft contains a third-party email address: ${hit.value}`
          : `the draft contains something shaped like a phone number: ${hit.value}`,
    });
  }

  rulesRun.push('banned_phrases');
  const lowered = text.toLowerCase();
  for (const phrase of bannedPhrases) {
    if (lowered.includes(String(phrase).toLowerCase())) {
      violations.push({
        rule: 'banned_phrases',
        code: 'BANNED_PHRASE',
        detail: `the draft contains the banned phrase "${phrase}"`,
      });
    }
  }

  rulesRun.push('length_bounds');
  const min = config.minBodyChars ?? 0;
  const max = config.maxBodyChars ?? Infinity;
  if (draft.body.length < min) {
    violations.push({
      rule: 'length_bounds',
      code: 'DRAFT_TOO_SHORT',
      detail: `body is ${draft.body.length} characters, under the ${min} minimum`,
    });
  }
  if (draft.body.length > max) {
    violations.push({
      rule: 'length_bounds',
      code: 'DRAFT_TOO_LONG',
      detail: `body is ${draft.body.length} characters, over the ${max} maximum`,
    });
  }

  return { violations, rules_run: rulesRun };
}

export const gate = {
  name: 'gate',

  run(lead, ctx) {
    let report;

    try {
      report = evaluateRules(lead, ctx.config.gate ?? {});
    } catch (error) {
      // The gate could not form an opinion. That is not permission.
      return refuse({
        reason: 'GATE_ERROR',
        detail: `the gate could not evaluate this draft, so it refuses: ${error.message}`,
      });
    }

    if (report.violations.length > 0) {
      const [first] = report.violations;
      return refuse({
        reason: first.code,
        detail: first.detail,
        output: { ...lead, gate: report },
      });
    }

    return pass({ output: { ...lead, gate: report } });
  },
};
