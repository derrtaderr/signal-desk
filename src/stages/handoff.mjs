// Stage 8 — handoff. M1 scope.
//
// The open tool never sends mail. It hands a survivor to a pluggable sender interface, and
// the one reference adapter in this repo produces a dry-run JSON artifact. M2 adds adapter
// depth and .eml rendering. SMTP and HeyReach adapters are non-scope and stay that way.
//
// The stage returns the artifact rather than writing it, because stages do no I/O. The CLI
// is what puts bytes on disk, which keeps this stage testable and keeps the write in one place.
//
// c1-sender is private prior art for the adapter shape. No code is vendored.

import { pass, refuse } from '../contract.mjs';

// The registry is the pluggable interface. An adapter takes a lead and returns an artifact;
// nothing in the registry may perform I/O or send anything.
export const adapters = {
  'dry-run-json': (lead, ctx) => ({
    dry_run: true,
    lead_id: lead.lead_id,
    run_id: ctx.run_id,
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
  }),
};

export const handoff = {
  name: 'handoff',

  run(lead, ctx) {
    // Belt and braces with stage 7. The queue is what parks a lead, but handoff is the
    // stage that would act, so it re-checks rather than trusting that it was reached
    // legitimately.
    if (lead.approval?.decision !== 'approve') {
      return refuse({
        reason: 'NOT_APPROVED',
        detail: 'handoff was reached without a recorded human approval on this lead',
      });
    }

    const name = ctx.config.handoff?.adapter;
    const adapter = adapters[name];
    if (adapter === undefined) {
      return refuse({
        reason: 'UNKNOWN_ADAPTER',
        detail: `no adapter named "${name}" is registered; falling back to a default would be a send nobody chose`,
      });
    }

    return pass({
      output: {
        ...lead,
        handoff: { adapter: name, sent: false, artifact: adapter(lead, ctx) },
      },
      evidence_refs: lead.citations,
    });
  },
};
