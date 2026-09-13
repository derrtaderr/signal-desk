// Fail-closed PII redaction. Pattern adapted from redaction-gate; no code vendored.
//
// The pattern is asymmetric on purpose, and the asymmetry is the entire idea.
//
// A single regex pass that reports what it matched cannot tell you the difference between
// "there was no PII in this text" and "my pattern did not match the PII in this text". Those
// are the only two outcomes that matter, and a one-pass gate answers PASS to both.
//
// So there are two passes with two different detectors:
//
//   redact(text)      removes what it recognises, and reports what it removed.
//   assertClean(text) looks again with a BROADER, structurally different detector.
//
// The caller refuses when the second pass still finds something, because at that point the
// system cannot even characterise what is in the text. That refusal is REDACTION_INCOMPLETE
// and it is strictly more severe than "I found a phone number", which is the case where
// everything worked.
//
// The verifying patterns are deliberately looser than the redacting ones. An @ between word
// characters with no dotted TLD is not a valid address by the redacting pattern and is very
// much a leak. Ten digits with no separators is not a phone number by the redacting pattern
// and is very much a phone number.

// --- the redacting detectors ----------------------------------------------------------

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Deliberately loose. A gate that only catches the tidy format is a gate that lets the untidy
// one through. The looseness is justified by asymmetric cost, not by cheapness: a falsely
// refused draft is recoverable by editing and re-running, and a phone number that reaches a
// stranger is not recoverable at all.
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

export const EMAIL_PLACEHOLDER = '[redacted:email]';
export const PHONE_PLACEHOLDER = '[redacted:phone]';
export const RECIPIENT_PLACEHOLDER = '[recipient]';

// --- the verifying detectors, independent and broader -----------------------------------

// Any @ joining word characters. Catches bare hostnames and TLD-less internal addresses that
// the redacting pattern's dotted-TLD requirement rejects.
const RESIDUAL_EMAIL = /[a-z0-9._%+-]+@[a-z0-9._%+-]+/gi;

// A span of digits and phone separators carrying seven or more digits. Catches unseparated
// runs that the redacting pattern's group structure misses. Seven is the shortest real
// subscriber number, and ordinary prose numbers ("240 people", "3 regions") fall well under it.
const RESIDUAL_PHONE = /[\d][\d\s().+-]{5,}[\d]/g;

function digitCount(text) {
  return (text.match(/\d/g) ?? []).length;
}

// The placeholders this module writes are not findings. Stripping them before verification is
// what keeps a successful redaction from reporting itself as a failure.
function stripPlaceholders(text) {
  return text
    .split(EMAIL_PLACEHOLDER).join(' ')
    .split(PHONE_PLACEHOLDER).join(' ')
    .split(RECIPIENT_PLACEHOLDER).join(' ');
}

/**
 * Removes recognised PII and reports what was removed.
 *
 * Addresses on the allow list are removed too, and are NOT reported. Writing to someone is not
 * leaking them, but leaving their address in the text would make the verification pass below
 * report it, so it goes as well. Verification therefore runs against text that should contain
 * no addresses at all, which is a much sharper question to ask than "no addresses except one".
 */
export function redact(text, { allow = [] } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('redact requires the text to redact');
  }
  const allowed = new Set(allow.map((address) => String(address).toLowerCase()));
  const hits = [];

  let redacted = text.replace(EMAIL, (match) => {
    if (allowed.has(match.toLowerCase())) return RECIPIENT_PLACEHOLDER;
    hits.push({ type: 'email', value: match });
    return EMAIL_PLACEHOLDER;
  });

  redacted = redacted.replace(PHONE, (match) => {
    hits.push({ type: 'phone', value: match });
    return PHONE_PLACEHOLDER;
  });

  return { redacted, hits };
}

/**
 * Looks again, with detectors that are broader than the ones redact uses.
 *
 * A false result means redaction MISSED something, which is the case the caller must refuse.
 */
export function assertClean(text) {
  if (typeof text !== 'string') {
    throw new TypeError('assertClean requires the text to verify');
  }
  const subject = stripPlaceholders(text);
  const found = [];

  for (const match of subject.matchAll(RESIDUAL_EMAIL)) {
    found.push({ type: 'email', value: match[0] });
  }

  for (const match of subject.matchAll(RESIDUAL_PHONE)) {
    if (digitCount(match[0]) >= 7) found.push({ type: 'phone', value: match[0].trim() });
  }

  return { clean: found.length === 0, found };
}
