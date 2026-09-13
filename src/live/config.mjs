// The live wiring. M4 spec §5, §6, §8, §11.
//
// One function, and every difference from fixture mode is visible in it. That is the point of
// keeping the pipeline's wiring in data: live mode is not a second program, it is the same eight
// stages with four switches thrown and a real clock.
//
// The four switches, and what each one changes:
//
//   ingest.signatureOver  'raw'     verify the bytes the sender transmitted, not a reserialisation
//   enrich.sourcesFrom    'signal'  fetch the URLs the payload cited, not a vendor template
//   draft.mode            'model'   compose with the LLM, refusing rather than falling back
//   gate.rubric.mode      'model'   judge with the LLM, through M2's unchanged validator
//
// WHAT DOES NOT CHANGE, and this list is the more important one. The stage sequence. The gate's
// deterministic rules. The redaction passes. The injection rule. The claim-grounding check. The
// approval queue and its hash binding. The handoff adapter that writes and never sends. Earned
// autonomy, still off. A live draft faces exactly the gates a fixture draft faces, which is what
// makes the fixture demo evidence about the live path rather than a separate story.
//
// THE CLOCK START IS IN CONFIG, and that is load-bearing rather than incidental. The run id is a
// digest of the wiring, the signals and the recordings available at start, and a live run has
// captured nothing at that moment. The clock start is therefore what distinguishes one live run
// from the next, so two live runs over the same payload do not collide in the same directory.

import { defaultConfig } from '../config.mjs';
import { DEFAULT_MODEL } from './anthropic.mjs';

export const SECRET_VARIABLE = 'SIGNAL_DESK_SIGNAL_SECRET';
export const MODEL_VARIABLE = 'SIGNAL_DESK_MODEL';

export class MissingSecretError extends Error {
  constructor() {
    super(
      `live mode needs the shared secret your sender signs with and found none. Export ${SECRET_VARIABLE} ` +
        'and run again. It is not optional: ingest skips signature verification when no secret is ' +
        'configured, which is right for a pipeline nobody gave one to and catastrophic for a live ' +
        'mode that would then accept whatever arrived. Nothing was fetched and no run was written.',
    );
    this.name = 'MissingSecretError';
    this.code = 'LIVE_SECRET_MISSING';
  }
}

export function resolveSignalSecret(env = {}) {
  const value = env[SECRET_VARIABLE];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new MissingSecretError();
}

/**
 * The live config, derived from the fixture one so every unchanged rule is unchanged by
 * construction rather than by being retyped.
 */
export function liveConfig({ secret, startedAt, model = DEFAULT_MODEL } = {}) {
  return {
    ...defaultConfig,
    mode: 'live',

    // Not a fixture step clock. `start` records when this run began, which is what separates two
    // live runs over identical inputs; the instants themselves come from the recording clock.
    clock: { mode: 'live', start: startedAt },

    model,

    ingest: {
      ...defaultConfig.ingest,
      secret,
      signatureOver: 'raw',
    },

    enrich: {
      ...defaultConfig.enrich,
      sourcesFrom: 'signal',
      // The templated vendor URLs are dropped rather than left sitting unused, and BOTH of them
      // are. A config that still named them would suggest a live run might contact them, and
      // somebody reading it would have to check the code to find out.
      //
      // This is not cosmetic: the fixture identitySource points at people.test, and a live run that
      // inherited it would try to resolve a reserved test domain on every lead and then report
      // IDENTITY_UNVERIFIED as though a real source had declined to answer. Caught by a live CLI
      // test asserting that no fixture domain is contacted, which is exactly the kind of thing a
      // composition-level test finds and a unit test does not.
      sources: [],
      identitySource: '',
    },

    draft: {
      ...defaultConfig.draft,
      mode: 'model',
    },

    gate: {
      ...defaultConfig.gate,
      rubric: { ...defaultConfig.gate.rubric, mode: 'model' },
    },
  };
}
