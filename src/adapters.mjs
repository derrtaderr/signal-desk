// The pluggable sender interface, made explicit.
//
// THE ADAPTER CONTRACT. Documented in docs/ADAPTERS.md and enforced by
// test/adapter-conformance.test.mjs, in the same shape as the stage-contract conformance
// harness. A contract that is only documented is a suggestion.
//
//   {
//     name:       string   equal to its key in the registry
//     extension:  string   the file extension its serialised form takes
//     render(lead, ctx) -> artifact     pure, deterministic, no I/O
//     serialize(artifact) -> string     the bytes the CLI writes
//   }
//
// Two rules hold for every adapter in this registry, now and in any fork:
//
//   1. NOTHING HERE SENDS ANYTHING. An adapter renders. The stage returns what it rendered and
//      the CLI writes it. There is no transport in this repo and there is not going to be one.
//      SMTP and HeyReach adapters are non-scope in the open tool, in every milestone.
//   2. RENDER IS PURE. No filesystem, no network, no clock, no randomness. That is what makes a
//      run reproducible and what lets an adapter be tested with a plain object.
//
// c1-sender is private prior art for the adapter shape. No code is vendored.

// Sorted, because an artifact that serialises differently depending on object construction
// order is an artifact that cannot be compared between runs.
//
// Sorting is done by REBUILDING the value with ordered keys, not by handing JSON.stringify a
// replacer array. A replacer array is an allowlist of key names applied at EVERY nesting depth,
// so passing the top level's keys silently stripped every nested object: each claim_refs entry
// serialised as {} and the citation grounding each claim vanished from the export. The bug was
// invisible to any assertion made on the rendered object, because the object was always right.
function sortedDeep(value) {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value === null || typeof value !== 'object') return value;

  const ordered = {};
  for (const key of Object.keys(value).sort()) ordered[key] = sortedDeep(value[key]);
  return ordered;
}

function stableJson(value) {
  return JSON.stringify(sortedDeep(value), null, 2);
}

// The fields every adapter puts in its artifact, whatever format it renders to. Named once so
// two adapters cannot drift into describing the same handoff differently.
function handoffFacts(lead, ctx) {
  return {
    dry_run: true,
    lead_id: lead.lead_id,
    run_id: ctx.run_id,
    draft_hash: lead.draft_hash,
    to: lead.draft.to,
    subject: lead.draft.subject,
    body: lead.draft.body,
    company: lead.company.name,
    band: lead.route.band,
    owner: lead.route.owner,
    play: lead.route.play,
    score: lead.score.total,
    approved_by: lead.approval.by,
    approved_at: lead.approval.at,
    citations: [...lead.citations].sort(),
    claim_refs: lead.draft.claim_refs,
  };
}

export const adapters = {
  // The reference adapter. Everything the pipeline decided, in one readable object.
  'dry-run-json': {
    name: 'dry-run-json',
    extension: 'json',
    render: (lead, ctx) => handoffFacts(lead, ctx),
    serialize: (artifact) => `${stableJson(artifact)}\n`,
  },

  // RFC-5322-shaped message bytes. A file, not a transmission: no client is wired to it, and
  // the headers below are the point rather than a step towards sending. X-Signal-Desk-Dry-Run
  // is present so that a message which somehow escaped this repo would still announce itself.
  eml: {
    name: 'eml',
    extension: 'eml',
    render(lead, ctx) {
      const facts = handoffFacts(lead, ctx);
      return {
        ...facts,
        headers: {
          To: facts.to,
          Subject: facts.subject,
          'X-Signal-Desk-Run': facts.run_id,
          'X-Signal-Desk-Lead': facts.lead_id,
          'X-Signal-Desk-Draft': facts.draft_hash,
          'X-Signal-Desk-Approved-By': facts.approved_by,
          // The evidence travels WITH the artifact. Headers rather than body, because the body
          // is the message a person reads and citations are not part of it. An export that
          // dropped its grounding would make the artifact unauditable on its own, which is the
          // same loss the JSON writer was causing silently.
          'X-Signal-Desk-Claim': facts.claim_refs
            .map((ref) => `${ref.field}=${ref.citation}`)
            .join('; '),
          'X-Signal-Desk-Citations': facts.citations.join('; '),
          'X-Signal-Desk-Dry-Run': 'true',
        },
      };
    },
    serialize(artifact) {
      const headers = Object.entries(artifact.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
      // No Date header. A wall-clock stamp would make two identical runs produce different
      // bytes, which would break replay for the sake of a field nobody reads here.
      return `${headers}\n\n${artifact.body}\n`;
    },
  },
};

export const ADAPTER_CONTRACT_FIELDS = Object.freeze(['name', 'extension', 'render', 'serialize']);

// The name a rendered artifact takes on disk.
//
// The draft hash is in the filename deliberately. Run scoping already separates runs, so this
// is what separates two DIFFERENT MESSAGES to one person, and it is what makes a clobber
// detectable rather than silent. See the CLI's writer, which refuses a path that exists with
// different bytes.
export function artifactFilename(lead, adapter) {
  return `${lead.lead_id}-${lead.draft_hash}.${adapter.extension}`;
}
