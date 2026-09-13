// Stage 6 — gate. M1 scope.
//
// The design's full gate is three parts: PII redaction, an LLM rubric, and a claim-grounding
// check. M2 builds all three. What M1 ships is the deterministic rule layer, which is the part
// that needs no key and no model, and which can genuinely refuse. The structure here is the
// structure M2 extends: a list of named rules, every one evaluated, violations collected.
//
// Fail-closed is the invariant, and it is enforced twice. The whole evaluation runs inside a
// try/catch that converts any error into REFUSE/GATE_ERROR, and the kernel converts a throw
// that escapes anyway into REFUSE/STAGE_ERROR. A gate that errors refuses. It never passes.
//
// Fail-closed patterns adapted from redaction-gate and gtm-agent-evals; no code vendored.

import { pass, refuse } from '../contract.mjs';

const PLACEHOLDER = /\{[a-z0-9_]+(?::[a-z0-9_]+)?\}/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Deliberately loose. A gate that only catches the tidy format is a gate that lets the untidy
// one through.
//
// The looseness is justified by asymmetric cost, not by cheapness. A gate refusal is TERMINAL
// for this lead in this run; nobody glances at it and waves it past. What makes over-matching
// the right trade anyway is that the two errors are not the same size. A falsely refused draft
// is recoverable by editing the text and running again. A phone number that reaches a stranger
// is not recoverable at all.
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;

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

  rulesRun.push('pii_leakage');
  const recipient = String(draft.to).toLowerCase();
  const addresses = text.match(EMAIL) ?? [];
  for (const address of addresses) {
    if (address.toLowerCase() === recipient) continue;
    violations.push({
      rule: 'pii_leakage',
      code: 'PII_IN_BODY',
      detail: `the draft contains a third-party email address: ${address}`,
    });
  }
  if (PHONE.test(text)) {
    violations.push({
      rule: 'pii_leakage',
      code: 'PII_IN_BODY',
      detail: 'the draft contains something shaped like a phone number',
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
