// The fixture corpus as data. Pure: importing this module writes nothing.
//
// scripts/make-fixtures.mjs writes these to disk. A test compares the committed files
// against this module, so the generator and the corpus cannot drift apart silently.

import { createHash } from 'node:crypto';

import { signPayload } from '../src/stages/ingest.mjs';
import { FIXTURE_SECRET } from '../src/config.mjs';

function leadIdFor(domain, email) {
  const digest = createHash('sha256').update(`${domain} ${email}`).digest('hex');
  return `lead-${digest.slice(0, 12)}`;
}

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

const signals = [
  ['0001-acme.json', acme],
  ['0002-northwind.json', northwind],
  ['0003-tiny.json', tiny],
  ['0004-globex.json', globex],
  ['9001-malformed-webhook.json', malformed],
  ['9002-duplicate-signal.json', duplicate],
];

// --- recordings ----------------------------------------------------------------------

const recordings = {
  'https://directory.test/company/acme.test': {
    status: 200,
    body: { claims: { employee_count: 240, industry: 'industrial robotics' } },
  },
  'https://newsroom.test/acme.test': {
    status: 200,
    body: { claims: { funding_stage: 'series B' } },
  },
  'https://directory.test/company/northwind.test': {
    status: 200,
    body: { claims: { employee_count: 180, industry: 'freight logistics' } },
  },
  'https://directory.test/company/tiny.test': {
    status: 200,
    body: { claims: { employee_count: 6, industry: 'consulting' } },
  },
  'https://directory.test/company/globex.test': {
    status: 200,
    body: { claims: { employee_count: 420, industry: 'industrial manufacturing' } },
  },
  'https://newsroom.test/globex.test': {
    status: 200,
    body: { claims: { funding_stage: 'public' } },
  },
};

// --- approvals -----------------------------------------------------------------------
// Decisions humans made outside this system. An M1 stand-in for the approval workflow M2
// builds. Northwind is deliberately absent, so the fixture run demonstrates a lead parking.

const approvals = {
  [leadIdFor('acme.test', 'dana@acme.test')]: {
    decision: 'approve',
    by: 'dana.reviewer',
    at: '2026-03-01T08:56:00.000Z',
  },
  [leadIdFor('globex.test', 'robin@globex.test')]: {
    decision: 'reject',
    by: 'dana.reviewer',
    at: '2026-03-01T08:56:30.000Z',
    note: 'already in an open opportunity, do not touch',
  },
};

// Every file the corpus contains, as [relative path, contents] pairs.
export function fixtureFiles() {
  return [
    ...signals.map(([name, signal]) => [`signals/${name}`, signal]),
    ['recordings.json', recordings],
    ['approvals.json', approvals],
  ];
}

export { signals, recordings, approvals };
