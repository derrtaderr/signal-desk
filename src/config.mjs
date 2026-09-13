// The pipeline wiring. The stage sequence and every threshold live here, in data, so that
// adapting the system means replacing a module and editing this file. That is the whole
// extension mechanism; there is no plugin framework and there is not going to be one.

import { ingest } from './stages/ingest.mjs';
import { enrich } from './stages/enrich.mjs';
import { score } from './stages/score.mjs';
import { route } from './stages/route.mjs';
import { draft } from './stages/draft.mjs';
import { gate } from './stages/gate.mjs';
import { queue } from './stages/queue.mjs';
import { handoff } from './stages/handoff.mjs';

// Order is the pipeline. Nothing else defines it.
export const pipeline = [ingest, enrich, score, route, draft, gate, queue, handoff];

// Not a credential. Fixture mode signs its own fixtures with this constant so the HMAC path
// is genuinely exercised offline. Live mode (M4) reads a real secret from the environment.
export const FIXTURE_SECRET = 'signal-desk-fixture-secret';

export const defaultConfig = {
  mode: 'fixture',

  // Fixture mode pins the clock so a run is reproducible. Live mode replaces this.
  clock: { start: '2026-03-01T09:00:00.000Z', stepMs: 1000 },

  ingest: {
    secret: FIXTURE_SECRET,
    replayWindowMs: 300000,
  },

  enrich: {
    sources: ['https://directory.test/company/{domain}', 'https://newsroom.test/{domain}'],

    // The identity source, contact-scoped rather than company-scoped. It answers whether the
    // human this signal names is the human the evidence describes, which vendor-side identity
    // resolution gets wrong often enough to be worth asking. Its responses carry an `identity`
    // block rather than `claims`, so it never becomes a citation for anything.
    identitySource: 'https://people.test/{email}',

    // How old a record may be and still be stated as a current fact. Ninety days is a policy
    // choice with a number attached, which is why it sits in config rather than in the stage.
    // Widening it is a decision somebody makes on purpose; a source that quietly declines to
    // date itself is not, which is why undated evidence is unusable at any window width.
    maxEvidenceAgeMs: 90 * 24 * 60 * 60 * 1000,

    // How far ahead of this run's clock a source's `as_of` may sit before the record is refused
    // as future-dated. An honest server can run a minute fast; a record dated next year is either
    // clock-broken or claiming a freshness it cannot have. Five minutes is the line between
    // catching a lie and punishing a rounding error. See the posture note in src/stages/enrich.mjs:
    // `as_of` is the SOURCE's assertion, and checking it is a bound on trust, not a verification.
    clockSkewToleranceMs: 5 * 60 * 1000,
  },

  score: {
    seniorTitles: ['chief', 'vp', 'vice president', 'head of', 'director'],
    highIntentPages: ['/pricing', '/demo', '/book-a-call'],
    employeeBand: { min: 10, max: 500 },
  },

  route: {
    floor: 40,
    // Highest first. The first band a score clears wins.
    bands: [
      { name: 'priority', min: 80, owner: 'ae-round-robin', play: 'executive-intro' },
      { name: 'standard', min: 40, owner: 'sdr-queue', play: 'problem-first' },
    ],
  },

  draft: {
    maxBodyChars: 900,
    templates: {
      'executive-intro': {
        subject: 'Your team and {company_name}',
        body: [
          'Hi {contact_first_name},',
          '',
          'You spent time on our pricing page this week. Teams your size in {claim:industry} usually',
          'get there after the same thing breaks twice, so I will skip the pitch.',
          '',
          'At around {claim:employee_count} people, the constraint is rarely the tooling. It is that',
          'nobody owns the handoff between the signal and the send.',
          '',
          'Open to a short call?',
        ].join('\n'),
      },
      'problem-first': {
        subject: 'A question about {company_name}',
        body: [
          'Hi {contact_first_name},',
          '',
          'A question rather than a pitch. At around {claim:employee_count} people, who decides',
          'which inbound signals are worth a human reply?',
          '',
          'Most teams your size answer that with a rule nobody has revisited in a year.',
          '',
          'Worth a short conversation?',
        ].join('\n'),
      },
    },
  },

  gate: {
    minBodyChars: 80,
    maxBodyChars: 900,
    bannedPhrases: ['guaranteed results', '100% risk free', 'act now', 'limited time only'],

    // The fail-closed LLM rubric. In fixture mode the endpoint is reached through the recorded
    // fetcher, so the demo is keyless and deterministic; the recordings are addressed by draft
    // hash, so a verdict cannot outlive the draft it judged. Live mode (M4) swaps the fetcher
    // and points the endpoint at a real judge. Nothing else changes.
    //
    // requiredCriteria is the list of questions the judge MUST answer. A criterion missing from
    // a response is a refusal, not a pass, which is the whole reason the list is explicit.
    rubric: {
      endpoint: 'https://judge.test/rubric',
      requiredCriteria: ['claim_grounding', 'audience_fit', 'tone'],
    },
  },

  queue: {
    // The earned-autonomy hook. It exists so the code path is real and reviewable, and it
    // ships off. Turning it on is an explicit, separate decision with its own consequences.
    autonomy: { enabled: false },
    // Populated by the runner from fixtures/approvals.json plus any decisions a human recorded
    // with `approve` / `reject`. A LIST of records, each bound to a draft-content hash; the
    // M1 lead-keyed map is refused outright rather than read as empty. See src/stages/queue.mjs.
    approvals: [],
  },

  handoff: {
    adapter: 'dry-run-json',
  },
};
