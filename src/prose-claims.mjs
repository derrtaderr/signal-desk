// Claim grounding, extended from structured references to free prose.
//
// Grounding pattern adapted from business-brain; no code vendored.
//
// M1's gate verified `claim_refs`, the structured list the draft stage emits when it fills a
// {claim:field} placeholder. That catches a forged citation and cannot see a factual assertion
// written as an ordinary sentence, because prose carries no reference to check. M1 asserted
// that gap rather than hiding it. This module closes it.
//
// The check is lexical and deterministic, which matters: it is the layer that still works with
// no key and no model. The LLM rubric is the second layer, for what lexical rules miss.
//
// The check is also TYPED, and the typing is the reason it is correct rather than merely
// strict. An assertion of a given kind grounds ONLY against a claim field that can carry that
// kind of fact. Untyped support — "is this token anywhere in any cited claim" — would let a
// poisoned enrichment value reading "logistics, now scaling after their Series C" vouch for a
// Series C assertion, which is exactly the attack this rule exists to stop. Typing also makes
// CONTRADICTION refusable: a body asserting Series C when the cited funding_stage says series B
// has a claim of the right type that does not support it, and that refuses.

// Which claim fields may ground which kind of assertion. Named rather than implied, because
// this table IS the rule.
export const PROSE_CLAIM_FIELDS = Object.freeze({
  funding_stage: Object.freeze(['funding_stage']),
  employee_count: Object.freeze(['employee_count']),
  money: Object.freeze(['revenue', 'valuation', 'funding_amount']),
});

const DETECTORS = [
  {
    kind: 'funding_stage',
    // A named round, a seed round, or an IPO. The lettered-series form is the common one and
    // the one the M1 adversarial fixture uses.
    pattern: /\b(series\s+[a-f]|seed\s+round|pre-seed|ipo)\b/gi,
    valueOf: (match) => match[1].toLowerCase().replace(/\s+/g, ' '),
  },
  {
    kind: 'employee_count',
    // A number attached to a word that makes it a headcount. The attachment is required, so a
    // bare number in prose, or a phone-shaped string, is not read as a claim about the company.
    pattern: /\b(\d[\d,]*)\s+(?:people|employees|staff|headcount)\b/gi,
    valueOf: (match) => Number(match[1].replace(/,/g, '')),
  },
  {
    kind: 'money',
    pattern: /\$\s?(\d[\d,.]*)\s*(k|m|bn?|million|billion|thousand)?\b/gi,
    valueOf: (match) => match[0].trim(),
  },
];

/**
 * Every factual assertion this module can recognise in a piece of prose.
 *
 * Returns [{ kind, text, value }], in the order they appear, deterministically.
 */
export function detectProseClaims(text) {
  if (typeof text !== 'string') {
    throw new TypeError('detectProseClaims requires the text to scan');
  }

  const found = [];
  for (const detector of DETECTORS) {
    // A fresh regex per call. A shared /g regex carries lastIndex between calls, which would
    // make this function's answer depend on how many times it had been called before.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      found.push({
        kind: detector.kind,
        text: match[0].trim(),
        value: detector.valueOf(match),
        index: match.index,
      });
    }
  }

  return found.sort((a, b) => a.index - b.index || (a.kind < b.kind ? -1 : 1)).map(
    ({ kind, text: matched, value }) => ({ kind, text: matched, value }),
  );
}

function normalise(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Does this cited claim support this assertion? Same kind is already guaranteed by the field
// table; what is checked here is whether the VALUES agree.
function supports(assertion, claimValue) {
  if (assertion.kind === 'employee_count') {
    return Number(claimValue) === Number(assertion.value);
  }
  if (assertion.kind === 'funding_stage') {
    const claim = normalise(claimValue);
    const asserted = normalise(assertion.value);
    return claim === asserted || claim.includes(asserted) || asserted.includes(claim);
  }
  // Money figures are compared as written. Two different renderings of the same amount are
  // treated as ungrounded rather than guessed at, because guessing is what this module exists
  // to prevent.
  return normalise(claimValue) === normalise(assertion.value);
}

/**
 * Every prose assertion in the text that no CITED claim of an appropriate field supports.
 *
 * An empty result means every factual assertion in the prose traces to evidence fetched this
 * run. A non-empty result is what the gate refuses on.
 */
export function groundProseClaims(text, claims = []) {
  const usable = (Array.isArray(claims) ? claims : []).filter((c) => c && c.cited && c.citation);

  return detectProseClaims(text)
    .filter((assertion) => {
      const fields = PROSE_CLAIM_FIELDS[assertion.kind] ?? [];
      const candidates = usable.filter((claim) => fields.includes(claim.field));
      return !candidates.some((claim) => supports(assertion, claim.value));
    })
    .map((assertion) => {
      const fields = PROSE_CLAIM_FIELDS[assertion.kind] ?? [];
      const candidates = usable.filter((claim) => fields.includes(claim.field));
      return {
        ...assertion,
        detail:
          candidates.length === 0
            ? `the draft asserts "${assertion.text}", and no cited ${fields.join(" or ")} claim exists to support it`
            : `the draft asserts "${assertion.text}", which the cited ${candidates[0].field} of ` +
              `"${candidates[0].value}" does not support`,
      };
    });
}
