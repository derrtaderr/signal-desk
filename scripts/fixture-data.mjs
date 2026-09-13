// The fixture corpus as data. Pure: importing this module writes nothing.
//
// scripts/make-fixtures.mjs writes these to disk. A test compares the committed files
// against this module, so the generator and the corpus cannot drift apart silently.

import { signPayload } from '../src/stages/ingest.mjs';
import { FIXTURE_SECRET } from '../src/config.mjs';

function signed(signal) {
  return { ...signal, signature: signPayload(FIXTURE_SECRET, signal.payload) };
}

// --- signals -------------------------------------------------------------------------

const acme = signed({
  id: 'sig-1001',
  source: 'rb2b',
  received_at: '2026-03-01T08:57:00.000Z',
  payload: {
    company: { name: 'Acme Robotics', domain: 'acme.test' },
    contact: { name: 'Dana Ruiz', email: 'dana@acme.test', title: 'VP Revenue Operations' },
    intent: { page: '/pricing', visits: 4 },
  },
});

const northwind = signed({
  id: 'sig-1002',
  source: 'rb2b',
  received_at: '2026-03-01T08:58:00.000Z',
  payload: {
    company: { name: 'Northwind Logistics', domain: 'northwind.test' },
    contact: { name: 'Sam Patel', email: 'sam@northwind.test', title: 'Demand Generation Manager' },
    intent: { page: '/demo', visits: 2 },
  },
});

const tiny = signed({
  id: 'sig-1003',
  source: 'rb2b',
  received_at: '2026-03-01T08:58:30.000Z',
  payload: {
    company: { name: 'Tiny Corp', domain: 'tiny.test' },
    contact: { name: 'Alex Doe', email: 'alex@tiny.test', title: 'Marketing Intern' },
    intent: { page: '/blog/hello', visits: 1 },
  },
});

const globex = signed({
  id: 'sig-1004',
  source: 'rb2b',
  received_at: '2026-03-01T08:59:00.000Z',
  payload: {
    company: { name: 'Globex Industrial', domain: 'globex.test' },
    contact: { name: 'Robin Vale', email: 'robin@globex.test', title: 'Head of Sales Operations' },
    intent: { page: '/demo', visits: 3 },
  },
});

// Hostile fixture 1: a webhook body that is structurally wrong. No company domain, so there
// is nothing to enrich against and nothing to address.
const malformed = signed({
  id: 'sig-9001',
  source: 'rb2b',
  received_at: '2026-03-01T08:59:30.000Z',
  payload: {
    company: { name: 'Mystery Co' },
    contact: { email: 'someone@mystery.test' },
    intent: { page: '/pricing', visits: 2 },
  },
});

// Hostile fixture 2: the same signal id as acme, replayed. Correctly signed and in window,
// which is the point. Only idempotency catches this one.
const duplicate = signed({
  id: 'sig-1001',
  source: 'rb2b',
  received_at: '2026-03-01T08:59:45.000Z',
  payload: acme.payload,
});

// Hostile fixture 3: a poisoned enrichment source leaks PII into the draft.
//
// Nothing about this signal is malformed. The directory page for vertex.test carries a phone
// number inside its industry field, the draft template interpolates that field, and a phone
// number nobody asked for ends up in outbound mail. The gate's redaction rule catches it.
const vertex = signed({
  id: 'sig-9003',
  source: 'rb2b',
  received_at: '2026-03-01T08:59:50.000Z',
  payload: {
    company: { name: 'Vertex Freight', domain: 'vertex.test' },
    contact: { name: 'Morgan Hale', email: 'morgan@vertex.test', title: 'VP Operations' },
    intent: { page: '/pricing', visits: 4 },
  },
});

// Hostile fixture 4: a draft every deterministic rule passes and a judge does not.
//
// The text is clean, grounded, well formed and the wrong message for this reader. No regex
// catches that, which is the entire reason the rubric exists. See scripts/record-rubric.mjs,
// where this lead's recorded verdict is a FAIL on audience_fit.
const halcyon = signed({
  id: 'sig-9004',
  source: 'rb2b',
  received_at: '2026-03-01T08:59:55.000Z',
  payload: {
    company: { name: 'Halcyon Systems', domain: 'halcyon.test' },
    contact: { name: 'Priya Raman', email: 'priya@halcyon.test', title: 'VP Engineering' },
    intent: { page: '/pricing', visits: 4 },
  },
});

// Hostile fixture 5: a factual assertion in free prose that no source supports.
//
// The directory page for orbital.test describes the company as "now scaling after their Series
// C". That string is interpolated into the body, so the draft asserts a funding round, and no
// cited funding_stage claim backs it. M1 could not see this: the assertion is prose, not a
// {claim:} placeholder, so it left no reference to check. The gate's prose_grounding rule does.
const orbital = signed({
  id: 'sig-9005',
  source: 'rb2b',
  received_at: '2026-03-01T09:00:00.000Z',
  payload: {
    company: { name: 'Orbital Dynamics', domain: 'orbital.test' },
    contact: { name: 'Chris Okafor', email: 'chris@orbital.test', title: 'Head of Revenue' },
    intent: { page: '/pricing', visits: 4 },
  },
});

// Hostile fixture 6: the same person, re-signalled under a NEW signal id.
//
// The M1 review's finding 1. The HMAC covers `payload` and nothing else, so re-issuing a signal
// under a fresh id leaves the signature valid and walks straight past signal-level idempotency.
// In M1 this ran the whole pipeline a second time, consumed the same human approval again, and
// wrote its handoff artifact over the first. Lead-level dedup refuses it as DUPLICATE_LEAD, a
// different code from DUPLICATE_SIGNAL because it is a different event.
const acmeAgain = signed({
  id: 'sig-9006',
  source: 'rb2b',
  received_at: '2026-03-01T09:00:05.000Z',
  payload: acme.payload,
});

// Hostile fixture 7: the signal names the wrong human.
//
// Everything a webhook can be checked for is correct here. Correctly signed, in window, not a
// duplicate, a well-formed company and a well-formed contact. What is wrong with it is invisible
// until something asks the person-level source who that address actually belongs to: Jordan
// Blake works at harborline.test, and the visit was attributed to them by a vendor doing
// probabilistic identity resolution over a shared office IP.
const meridian = signed({
  id: 'sig-9007',
  source: 'rb2b',
  received_at: '2026-03-01T09:00:10.000Z',
  payload: {
    company: { name: 'Meridian Payments', domain: 'meridian.test' },
    contact: { name: 'Jordan Blake', email: 'jordan@meridian.test', title: 'VP Revenue' },
    intent: { page: '/pricing', visits: 3 },
  },
});

// Hostile fixture 8: a source that answers perfectly with a record that expired.
//
// The directory knows Cinder Field. It answers 200, in the right shape, with a headcount and an
// industry. The record is dated April 2025, eleven months before this run's clock, and headcount
// is the single fastest-rotting field in B2B data. A pipeline that reads a 200 as freshness
// would state an expired number as a current fact, with a citation attached to make it look
// checked. Nothing else answers for this company, so nothing survives the freshness window.
const cinder = signed({
  id: 'sig-9008',
  source: 'rb2b',
  received_at: '2026-03-01T09:00:15.000Z',
  payload: {
    company: { name: 'Cinder Field', domain: 'cinder.test' },
    contact: { name: 'Wren Ito', email: 'wren@cinder.test', title: 'VP Customer Operations' },
    intent: { page: '/demo', visits: 3 },
  },
});

const signals = [
  ['0001-acme.json', acme],
  ['0002-northwind.json', northwind],
  ['0003-tiny.json', tiny],
  ['0004-globex.json', globex],
  ['9001-malformed-webhook.json', malformed],
  ['9002-duplicate-signal.json', duplicate],
  ['9003-pii-in-enrichment.json', vertex],
  ['9004-rubric-failure.json', halcyon],
  ['9005-ungrounded-prose.json', orbital],
  ['9006-same-contact-new-id.json', acmeAgain],
  ['9007-wrong-person-match.json', meridian],
  ['9008-decayed-enrichment.json', cinder],
];

// --- recordings ----------------------------------------------------------------------
//
// Every claim response carries an `as_of`. Undated evidence is unusable as of M3, so a corpus
// containing an undated recording would be a corpus that cannot demonstrate its own rule.
// See src/stages/enrich.mjs.

// Nine days before the fixture clock, comfortably inside the 90 day freshness window.
const FRESH = '2026-02-20T00:00:00.000Z';

function sourced(claims, as_of = FRESH) {
  return { status: 200, body: { as_of, claims } };
}

const companySources = {
  'https://directory.test/company/acme.test': sourced({ employee_count: 240, industry: 'industrial robotics' }),
  'https://newsroom.test/acme.test': sourced({ funding_stage: 'series B' }),
  'https://directory.test/company/northwind.test': sourced({ employee_count: 180, industry: 'freight logistics' }),
  'https://directory.test/company/tiny.test': sourced({ employee_count: 6, industry: 'consulting' }),
  'https://directory.test/company/globex.test': sourced({ employee_count: 420, industry: 'industrial manufacturing' }),
  'https://newsroom.test/globex.test': sourced({ funding_stage: 'public' }),

  // A scraped directory page whose industry field carries a phone number. Real directories do
  // this constantly, and a template that interpolates the field ships the number with it.
  'https://directory.test/company/vertex.test': sourced({
    employee_count: 320,
    industry: 'freight operations, desk line 415-555-0142',
  }),

  // Clean data. This lead's draft fails on judgement, not on any rule.
  'https://directory.test/company/halcyon.test': sourced({ employee_count: 260, industry: 'developer tooling' }),

  // An industry string smuggling a funding claim. Note there is deliberately NO newsroom
  // recording for orbital.test, so no cited funding_stage claim exists to support it.
  'https://directory.test/company/orbital.test': sourced({
    employee_count: 210,
    industry: 'orbital logistics software, now scaling after their Series C',
  }),

  // The decayed record. A perfect 200 in the right shape, dated eleven months before this run.
  // It is the only source that answers for cinder.test, so nothing survives the window and the
  // lead has no evidence at all rather than merely less of it.
  'https://directory.test/company/cinder.test': sourced(
    { employee_count: 90, industry: 'field service software' },
    '2025-04-02T00:00:00.000Z',
  ),
};

// --- person records -------------------------------------------------------------------
//
// The identity source. It answers "is this the right person", not "what is true about this
// company", which is why its responses carry an `identity` block rather than `claims` and why
// they never become citations. See src/stages/enrich.mjs.
//
// Every company in the corpus has one, so IDENTITY_UNVERIFIED in the demo ledger means the
// source genuinely knew nothing rather than the corpus being lazy.

function person({ email, name, domain }) {
  return {
    status: 200,
    body: { as_of: FRESH, identity: { name, email, company_domain: domain } },
  };
}

const people = {
  'https://people.test/dana@acme.test': person({
    email: 'dana@acme.test',
    name: 'Dana Ruiz',
    domain: 'acme.test',
  }),
  'https://people.test/sam@northwind.test': person({
    email: 'sam@northwind.test',
    name: 'Sam Patel',
    domain: 'northwind.test',
  }),
  'https://people.test/alex@tiny.test': person({
    email: 'alex@tiny.test',
    name: 'Alex Doe',
    domain: 'tiny.test',
  }),
  'https://people.test/robin@globex.test': person({
    email: 'robin@globex.test',
    name: 'Robin Vale',
    domain: 'globex.test',
  }),
  'https://people.test/morgan@vertex.test': person({
    email: 'morgan@vertex.test',
    name: 'Morgan Hale',
    domain: 'vertex.test',
  }),
  'https://people.test/priya@halcyon.test': person({
    email: 'priya@halcyon.test',
    name: 'Priya Raman',
    domain: 'halcyon.test',
  }),
  'https://people.test/chris@orbital.test': person({
    email: 'chris@orbital.test',
    name: 'Chris Okafor',
    domain: 'orbital.test',
  }),

  // The wrong-person catch. The signal put Jordan Blake at meridian.test; the person record
  // puts them at harborline.test. Nothing else in the signal is wrong, which is the point.
  'https://people.test/jordan@meridian.test': person({
    email: 'jordan@meridian.test',
    name: 'Jordan Blake',
    domain: 'harborline.test',
  }),

  // Fresh and correct, so the decayed-evidence fixture fails for exactly one reason. The person
  // is who the signal says; what is expired is everything known about the company.
  'https://people.test/wren@cinder.test': person({
    email: 'wren@cinder.test',
    name: 'Wren Ito',
    domain: 'cinder.test',
  }),
};

// --- approvals ------------------------------------------------------------------------
//
// NOT HERE ANY MORE, and the reason is the point of M2's queue change.
//
// M1 keyed approvals by lead id, which made them hand-authorable and made them worthless as
// authorisations: one recorded approval released a second draft the human had never seen.
// M2 binds every decision to a draft-content hash, so the file is DERIVED from the drafts the
// pipeline composes and cannot be written by hand. It is generated by
// scripts/record-approvals.mjs, whose DECISIONS table holds the authored half.

// One recordings map, two kinds of thing inside it. The fetcher is a single lookup and a stage
// cannot tell which half a response came from, which is the same arrangement rubric.json has.
const recordings = { ...companySources, ...people };

// Every file the corpus contains, as [relative path, contents] pairs.
export function fixtureFiles() {
  return [
    ...signals.map(([name, signal]) => [`signals/${name}`, signal]),
    ['recordings.json', recordings],
  ];
}

export { signals, recordings, companySources, people };
