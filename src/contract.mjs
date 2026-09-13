// The uniform stage contract.
//
//   stage(input, ctx) -> { status: PASS | REFUSE | NEEDS_HUMAN, output, entries }
//
// Every stage in the pipeline satisfies this and nothing else. Adapting the system means
// replacing one module and re-wiring the sequence. That is the whole extension mechanism,
// which is why the contract is enforced rather than documented.

export const PASS = 'PASS';
export const REFUSE = 'REFUSE';
export const NEEDS_HUMAN = 'NEEDS_HUMAN';

export const VERDICTS = [PASS, REFUSE, NEEDS_HUMAN];

function requireReason(reason, verdict) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError(`a ${verdict} result requires a machine-readable reason code`);
  }
}

export function pass({ output = {}, entries = [], ...rest } = {}) {
  return { status: PASS, output, entries, reason_codes: [], ...rest };
}

export function refuse({ reason, output = {}, entries = [], ...rest } = {}) {
  requireReason(reason, REFUSE);
  return { status: REFUSE, output, entries, reason_codes: [reason], ...rest };
}

export function needsHuman({ reason, output = {}, entries = [], ...rest } = {}) {
  requireReason(reason, NEEDS_HUMAN);
  return { status: NEEDS_HUMAN, output, entries, reason_codes: [reason], ...rest };
}

// Called by the kernel on every stage return. A stage that breaks the contract is a
// REFUSE, never a pass-through, so a malformed result cannot become a send.
export function assertStageResult(result, stageName) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError(`stage ${stageName} returned a non-object result`);
  }
  if (!VERDICTS.includes(result.status)) {
    throw new TypeError(
      `stage ${stageName} returned status ${JSON.stringify(result.status)}, expected one of ${VERDICTS.join(', ')}`,
    );
  }
  if (!Array.isArray(result.entries)) {
    throw new TypeError(`stage ${stageName} returned entries that are not an array`);
  }
  if (result.status !== PASS) {
    const codes = result.reason_codes;
    if (!Array.isArray(codes) || codes.length === 0) {
      throw new TypeError(`stage ${stageName} returned ${result.status} with no reason code`);
    }
  }
  return result;
}
