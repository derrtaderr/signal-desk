// Prompt-injection detection, lexical and deterministic.
//
// Same tradition as src/prose-claims.mjs, and for the same reason: this is the layer that still
// works with no key and no model, which is what makes it the layer worth having.
//
// WHAT THIS DEFENDS AND WHAT IT DOES NOT, stated plainly, because the honest version is smaller
// than the marketing version.
//
// In fixture mode the draft stage is a mechanical template fill. There is no interpreter between
// a fetched string and the composed message, so an instruction smuggled into a scraped page has
// nothing to instruct. The pipeline is not immune because it defends well; it is immune because
// there is no model in the loop yet. When M4 puts an LLM in the draft stage, that structural
// immunity ends and this rule is the part that survives the transition.
//
// What this module does today is the second obligation, and it is not a lesser one: the hostile
// text must be VISIBLE. A payload that rode a scraped field into an outbound draft and was never
// named is a payload the operator cannot act on and cannot remove from their source list.
//
// TWO KINDS, both named in the table below, because the table IS the rule.
//
//   instruction  Text addressing the system rather than the reader.
//   markup       A tag or a handler. These templates compose plain prose, so markup in the body
//                arrived from somewhere else by definition.
//
// The second kind is the one that reaches a human. It is also the one that lands a real payload
// in the ledger, which is exactly why every ledger-derived string in the dashboard is escaped.
// The injection fixture and the dashboard's XSS test are two halves of one decision; see
// docs/M3-SPEC.md.

// A matched span is capped before it leaves this module. The markup pattern can swallow a very
// long tag, and a refusal detail travels into the ledger, the golden file and the dashboard.
// One hostile record should not be able to flood any of them.
const MAX_SPAN = 128;

export const INJECTION_DETECTORS = Object.freeze([
  {
    kind: 'instruction',
    // The classic override, through the phrasings that actually appear in the wild.
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|preceding|foregoing)\s+(?:instructions?|prompts?|rules?|directions?|context)/gi,
  },
  {
    kind: 'instruction',
    pattern: /\bnew\s+instructions?\s*[:\-]/gi,
  },
  {
    kind: 'instruction',
    // Naming the system's own prompt is an attempt to address the system.
    pattern: /\bsystem\s+prompt\b/gi,
  },
  {
    kind: 'instruction',
    pattern: /\byou\s+are\s+now\b/gi,
  },
  {
    kind: 'instruction',
    // Asking for the decision this pipeline exists to reserve for a human. The object is
    // required, so "your team will approve the budget" is ordinary prose and stays ordinary.
    pattern: /\b(?:approve|authoris[e]|authoriz[e]|whitelist|allow|send)\s+(?:this|the)\s+(?:lead|draft|message|email|request|contact|prospect)\b/gi,
  },
  {
    kind: 'instruction',
    // An instruction-block tag. Matched as an instruction rather than as markup because what
    // makes it hostile is what it claims to delimit, not that it has angle brackets.
    pattern: /<\s*\/?\s*(?:system|instructions?|prompt)\s*>/gi,
  },
  {
    kind: 'markup',
    // A tag. The name list is deliberate: these templates compose plain prose, so ANY tag is
    // out of place, and naming the ones that carry a payload keeps a stray "<20%" out of it.
    pattern: /<\s*\/?\s*(?:script|img|iframe|a|svg|style|object|embed|link|form|input|button|body|meta)\b[^>]*>?/gi,
  },
  {
    kind: 'markup',
    // A handler attribute, which can arrive without a recognisable tag around it.
    pattern: /\bon(?:error|load|click|mouseover|focus|submit)\s*=/gi,
  },
  {
    kind: 'markup',
    pattern: /javascript\s*:/gi,
  },
]);

function cap(value) {
  const text = value.trim();
  return text.length <= MAX_SPAN ? text : `${text.slice(0, MAX_SPAN - 1)}…`;
}

/**
 * Every injection finding this module can recognise in a piece of text.
 *
 * Returns [{ kind, text }], in the order they appear, deterministically. An empty result means
 * nothing in the text is shaped like an instruction to the system or like markup.
 */
export function detectInjection(text) {
  if (typeof text !== 'string') {
    throw new TypeError('detectInjection requires the text to scan');
  }

  const found = [];
  for (const detector of INJECTION_DETECTORS) {
    // A fresh regex per call. A shared /g regex carries lastIndex between calls, which would
    // make this function's answer depend on how many times it had been called before. The same
    // defect src/prose-claims.mjs guards against, and it is worth guarding twice.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      found.push({ kind: detector.kind, text: cap(match[0]), index: match.index });
    }
  }

  return found
    .sort((a, b) => a.index - b.index || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map(({ kind, text: matched }) => ({ kind, text: matched }));
}

/**
 * One line naming what was found, for a ledger detail.
 *
 * The payload IS quoted, which diverges from M2's rule that a PII refusal names the kind of
 * finding and never the value. The two cases are not alike. PII is a third party's private data
 * and carrying it into the durable record is itself the harm the gate refused to allow. An
 * injection payload is the attacker's own text: it is nobody's secret, it is the evidence, and
 * an operator cannot decide whether to drop a source from their config on the strength of
 * "something tried to instruct your system". The existing prose_grounding rule already quotes
 * the asserted text verbatim, so quoting the adversary is the established behaviour here and
 * withholding it would be the exception.
 */
export function describeInjection(findings) {
  return findings.map((f) => `${f.kind}-shaped content ${JSON.stringify(f.text)}`).join('; ');
}
