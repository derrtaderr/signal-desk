// Stage 8 — handoff.
//
// The open tool never sends mail. It hands a survivor to a pluggable sender interface, and the
// adapters in this repo render files. SMTP, HeyReach and every other transport are non-scope
// and stay that way, in every milestone. See src/adapters.mjs for the contract.
//
// The stage RETURNS the artifact rather than writing it, because stages do no I/O. The CLI is
// what puts bytes on disk, which keeps this stage testable and keeps the write in one place.
//
// Three checks stand between a lead and an export, and all three are re-done here rather than
// trusted from upstream. Handoff is the stage that would ACT, so it re-asks rather than
// assuming it was reached legitimately:
//
//   1. a human decision exists and says approve      -> else NOT_APPROVED
//   2. that decision is bound to THIS draft's content -> else APPROVAL_HASH_MISMATCH
//   3. the configured adapter is one we know          -> else UNKNOWN_ADAPTER
//
// Check 2 is the teeth on the M1 review's finding. Only approved draft hashes are exportable,
// so a draft edited after approval cannot be exported on the strength of the old decision.

import { pass, refuse } from '../contract.mjs';
import { computeDraftHash } from '../draft-hash.mjs';
import { adapters, artifactFilename } from '../adapters.mjs';

export { adapters };

export const handoff = {
  name: 'handoff',

  run(lead, ctx) {
    if (lead.approval?.decision !== 'approve') {
      return refuse({
        reason: 'NOT_APPROVED',
        detail: 'handoff was reached without a recorded human approval on this lead',
      });
    }

    let draftHash;
    try {
      draftHash = computeDraftHash(lead.draft);
    } catch (error) {
      return refuse({
        reason: 'HANDOFF_ERROR',
        detail: `handoff could not hash this draft, so it refuses to export it: ${error.message}`,
      });
    }

    // Only approved draft hashes are exportable. An approval that names a different draft is an
    // approval for a different message, however recent it is and whoever signed it.
    if (lead.approval.draft_hash !== draftHash) {
      return refuse({
        reason: 'APPROVAL_HASH_MISMATCH',
        detail:
          `the approval on this lead authorises draft ${lead.approval.draft_hash} and the draft ` +
          `in hand is ${draftHash}; only an approved draft is exportable`,
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

    const subject = { ...lead, draft_hash: draftHash };

    return pass({
      output: {
        ...subject,
        handoff: {
          adapter: name,
          sent: false,
          filename: artifactFilename(subject, adapter),
          artifact: adapter.render(subject, ctx),
        },
      },
      evidence_refs: lead.citations,
    });
  },
};
