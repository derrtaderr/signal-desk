// Stage 6 — gate.
//
// The design's full gate is three parts: fail-closed PII redaction, deterministic rules plus a
// fail-closed LLM rubric, and a claim-grounding check. M1 shipped the deterministic rule layer.
// M2 is landing the rest, one part per commit, and this header says which are in:
//
//   (a) fail-closed PII redaction   LANDED, see src/redaction.mjs
//   (b) fail-closed LLM rubric      LANDED, see src/rubric.mjs
//   (c) prose claim grounding       LANDED, see src/prose-claims.mjs
//   (d) prompt injection            LANDED in M3, see src/injection.mjs
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
import { detectInjection, describeInjection } from '../injection.mjs';
import { computeDraftHash } from '../draft-hash.mjs';
import { evaluateRubric } from '../rubric.mjs';

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

  // Text aimed at the system rather than at the reader, and markup in a message these templates
  // compose as plain prose. See src/injection.mjs for what each kind means and for the honest
  // account of what this defends today versus what it will have to defend in M4.
  //
  // ON RULE ORDER, which is the reported order and therefore a claim about severity. Rules 2
  // and 3 answer "is this true". This one answers "is this text trying to act on the system",
  // which is a different and more alarming question than "does this contain a phone number",
  // and it is the one a person triaging a queue of refusals wants at the top. No fixture in the
  // corpus trips both, so nothing committed depends on the choice; it is written down so the
  // next person does not have to re-derive it.
  //
  // The detail QUOTES the payload, unlike the redaction rule below. That divergence is
  // deliberate and is argued in describeInjection.
  rulesRun.push('prompt_injection');
  const injections = detectInjection(text);
  if (injections.length > 0) {
    violations.push({
      rule: 'prompt_injection',
      code: 'PROMPT_INJECTION',
      detail:
        `the draft contains ${describeInjection(injections)}. Outbound copy this pipeline ` +
        'composes is plain prose written to a person; text addressing the system, or markup of ' +
        'any kind, arrived from a source rather than from a template',
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
  // NOTE ON WHAT THESE DETAILS SAY. They name the KIND of finding and never the value.
  //
  // A refusal detail travels into the ledger, which is the durable, shareable, committed record
  // of the run. Quoting the leaked value there would make the safeguard the mechanism of the
  // leak: the gate refused precisely so that value would not travel, and the refusal would
  // carry it anyway, into the one artifact designed to be handed to other people.
  //
  // The operator loses nothing. The draft still holds its own text and is right in front of
  // them in the run output; what is withheld is the copy that would outlive the run.
  if (!verification.clean) {
    const [first] = verification.found;
    violations.push({
      rule: 'pii_redaction',
      code: 'REDACTION_INCOMPLETE',
      detail:
        `redaction ran and verification still found ${first.type}-shaped content in the body, ` +
        'so the gate cannot certify what this draft contains. The value is withheld from this ' +
        'record deliberately; read the draft itself to see it',
    });
  }

  for (const hit of hits) {
    violations.push({
      rule: 'pii_redaction',
      code: 'PII_IN_BODY',
      detail:
        hit.type === 'email'
          ? 'the draft contains a third-party email address, withheld from this record'
          : 'the draft contains something shaped like a phone number, withheld from this record',
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

  async run(lead, ctx) {
    const config = ctx.config.gate ?? {};
    let report;
    let draftHash;

    try {
      // The hash is always computed from the CONTENT, never trusted from the lead, because
      // content is what an approval binds to. A stated hash that disagrees with the content it
      // claims to describe means the draft moved between stages, and a draft that moved is a
      // draft nobody approved.
      draftHash = computeDraftHash(lead.draft);
      if (lead.draft_hash !== undefined && lead.draft_hash !== draftHash) {
        return refuse({
          reason: 'DRAFT_HASH_MISMATCH',
          detail:
            `the lead carries draft hash ${lead.draft_hash} and its draft content hashes to ` +
            `${draftHash}; the draft changed after it was composed`,
          output: { ...lead },
        });
      }

      report = evaluateRules(lead, config);
    } catch (error) {
      // The gate could not form an opinion. That is not permission.
      return refuse({
        reason: 'GATE_ERROR',
        detail: `the gate could not evaluate this draft, so it refuses: ${error.message}`,
      });
    }

    // The deterministic rules speak first. A draft already known to be broken does not need a
    // judge's opinion, and in live mode it would not deserve the spend either. This
    // short-circuit cannot weaken fail-closed, because it only ever happens on a path that is
    // already refusing.
    if (report.violations.length > 0) {
      const [first] = report.violations;
      return refuse({
        reason: first.code,
        detail: first.detail,
        output: { ...lead, gate: report },
      });
    }

    let judgment;
    try {
      judgment = await evaluateRubric(draftHash, ctx, config.rubric);
    } catch (error) {
      return refuse({
        reason: 'GATE_ERROR',
        detail: `the rubric could not be evaluated, so the gate refuses: ${error.message}`,
      });
    }

    report.rules_run.push('llm_rubric');

    if (!judgment.ok) {
      report.violations.push({ rule: 'llm_rubric', code: judgment.code, detail: judgment.detail });
      return refuse({
        reason: judgment.code,
        detail: judgment.detail,
        output: { ...lead, gate: report },
      });
    }

    report.rubric = judgment.criteria;
    return pass({ output: { ...lead, gate: report } });
  },
};
