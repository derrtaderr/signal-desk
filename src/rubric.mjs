// The fail-closed LLM rubric. Pattern adapted from gtm-agent-evals; no code vendored.
//
// One rule, and everything here follows from it: SILENCE IS NOT A PASS.
//
// A judge that did not answer, answered about a different draft, or answered in a shape this
// code cannot read has not approved anything. The tempting implementation treats each of those
// as "no objection raised" and lets the draft through, which converts every outage and every
// schema drift into a silent authorisation. Each one is a refusal here, and each carries its
// own reason code so a reader can tell an outage apart from a rejection.
//
// MODE SEAM. In fixture mode the judge is a recorded response reached through ctx.fetch, which
// is what makes the demo keyless and byte-for-byte reproducible. Live mode (M4) swaps the
// fetcher and changes nothing else: this module's only contact with the outside world is
// ctx.fetch, exactly like enrichment's. That is the entire seam, and it exists now so M4 is a
// fetcher swap rather than a rewrite of the gate.
//
// The request is addressed BY DRAFT HASH and the response must name the same hash. That is the
// approval-binding lesson applied one layer down: a recorded verdict that was not made about
// this exact draft is a verdict about something else, and reusing it would repeat the M1
// approval bug inside the gate.

export const RUBRIC_ENDPOINT = 'https://judge.test/rubric';

const VERDICTS = ['PASS', 'FAIL'];

function malformed(detail) {
  return { ok: false, code: 'RUBRIC_MALFORMED', detail };
}

export async function evaluateRubric(draftHash, ctx, config) {
  // A gate part that disappears when its configuration is absent is not a gate part.
  if (config === null || typeof config !== 'object') {
    return malformed('no rubric configuration is present, so the rubric cannot certify anything');
  }
  const required = config.requiredCriteria;
  if (!Array.isArray(required) || required.length === 0) {
    return malformed('the rubric declares no required criteria, and a rubric asking nothing certifies nothing');
  }

  const url = `${config.endpoint ?? RUBRIC_ENDPOINT}/${draftHash}`;

  let response;
  try {
    response = await ctx.fetch(url);
  } catch (error) {
    return {
      ok: false,
      code: 'RUBRIC_UNAVAILABLE',
      detail: `the rubric judge at ${url} could not be reached, and silence is not a pass: ${error.message}`,
    };
  }

  if (response?.status !== 200) {
    return {
      ok: false,
      code: 'RUBRIC_UNAVAILABLE',
      detail: `the rubric judge answered ${response?.status}, which is not a verdict`,
    };
  }

  const body = response.body;
  if (body === null || typeof body !== 'object') {
    return malformed('the rubric judge returned no readable body');
  }

  // Before reading the verdict, check it is about THIS draft.
  if (body.draft_hash !== draftHash) {
    return {
      ok: false,
      code: 'RUBRIC_MISMATCH',
      detail:
        `the judgment names draft ${JSON.stringify(body.draft_hash)} and this draft is ` +
        `${draftHash}; a verdict about another draft is not a verdict about this one`,
    };
  }

  if (!VERDICTS.includes(body.verdict)) {
    return malformed(
      `the judgment carries verdict ${JSON.stringify(body.verdict)}, expected one of ${VERDICTS.join(', ')}`,
    );
  }

  if (!Array.isArray(body.criteria)) {
    return malformed('the judgment carries no criteria list, so nothing it says can be checked');
  }

  const byName = new Map();
  for (const criterion of body.criteria) {
    if (criterion === null || typeof criterion !== 'object' || typeof criterion.name !== 'string') {
      return malformed('the judgment carries a criterion with no name');
    }
    if (!VERDICTS.includes(criterion.verdict)) {
      return malformed(
        `criterion "${criterion.name}" carries verdict ${JSON.stringify(criterion.verdict)}, ` +
          `expected one of ${VERDICTS.join(', ')}`,
      );
    }
    byName.set(criterion.name, criterion);
  }

  // The heart of the pattern. A required question the judge did not answer is not a pass on
  // that question. An overall PASS alongside an unanswered criterion is the exact shape of the
  // failure being designed out.
  const unanswered = required.filter((name) => !byName.has(name));
  if (unanswered.length > 0) {
    return malformed(
      `the judgment does not address ${unanswered.join(', ')}, and an unanswered criterion is not a pass`,
    );
  }

  // A judge contradicting itself resolves to the safe reading. A single failing criterion is a
  // failure however the overall line was filled in.
  const failing = required.map((name) => byName.get(name)).filter((c) => c.verdict === 'FAIL');
  if (failing.length > 0 || body.verdict === 'FAIL') {
    const detail =
      failing.length > 0
        ? `the rubric failed on ${failing.map((c) => `${c.name} (${c.note ?? 'no note'})`).join('; ')}`
        : `the rubric returned an overall FAIL${body.note ? `: ${body.note}` : ''}`;
    return { ok: false, code: 'RUBRIC_FAILED', detail };
  }

  return {
    ok: true,
    criteria: required.map((name) => ({ name, verdict: byName.get(name).verdict })),
  };
}
