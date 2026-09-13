// Stage 7 — queue. The send boundary.
//
// Everything parks for a human by default. That is the reason this pipeline is safe to run
// against a real list before anyone trusts it.
//
// THE DECISION THIS STAGE EXISTS TO GET RIGHT: an approval binds to a DRAFT-CONTENT HASH,
// never to a lead id.
//
// M1 keyed approvals by lead id, and the M1 review demonstrated what that buys: one recorded
// approval released a SECOND draft the human had never seen, because the lead id had not
// changed. "Approved" has to mean "approved THIS", and the only way to say THIS that a later
// stage can check is to hash the message. See src/draft-hash.mjs and docs/M2-SPEC.md.
//
// Resolution order is the whole safety property, and it is:
//
//   1. a decision bound to THIS draft's hash            -> honour it
//   2. that decision's lead id disagrees with this lead -> refuse; a store was edited
//   3. a decision exists for this LEAD but not this DRAFT -> park as APPROVAL_STALE
//   4. nothing on record, or nothing interpretable      -> park as AWAITING_APPROVAL
//
// Step 3 is the M1 bug, closed. The human approved a draft, the draft changed, and the old
// decision no longer covers it. It parks for a fresh look rather than refusing, because
// nothing is wrong with the draft; what is missing is authorisation, which is the same thing
// missing from a draft nobody has read yet. NEEDS_HUMAN is the verdict that says so, and the
// safety property does not depend on the choice: a parked lead does not advance either way.
//
// The earned-autonomy hook exists here and ships disabled, per the design's send boundary.
// Enabling it requires config.queue.autonomy.enabled === true, an explicit opt-in that the
// repo's own default config does not contain and a test pins.

import { pass, refuse, needsHuman } from '../contract.mjs';
import { computeDraftHash } from '../draft-hash.mjs';

function autonomyEnabled(config) {
  return config.autonomy?.enabled === true;
}

function decisionsIn(config) {
  const approvals = config.approvals;
  if (Array.isArray(approvals)) return approvals;
  // An absent store is no decisions, which parks everything. A store of the WRONG SHAPE is not
  // silently treated as empty; M1's lead-keyed object would otherwise read as "no approvals"
  // and quietly park a corpus a reader expected to move.
  if (approvals === undefined || approvals === null) return [];
  throw new TypeError(
    'queue config approvals must be a list of decision records bound to draft hashes',
  );
}

export const queue = {
  name: 'queue',

  run(lead, ctx) {
    const config = ctx.config.queue ?? {};
    let decisions;
    let draftHash;

    try {
      decisions = decisionsIn(config);
      draftHash = computeDraftHash(lead.draft);
    } catch (error) {
      // The queue could not work out what it is holding or what was decided about it. That is
      // not permission.
      return refuse({
        reason: 'QUEUE_ERROR',
        detail: `the queue could not resolve a decision for this draft, so it refuses: ${error.message}`,
      });
    }

    if (lead.draft_hash !== undefined && lead.draft_hash !== draftHash) {
      return refuse({
        reason: 'DRAFT_HASH_MISMATCH',
        detail:
          `the lead carries draft hash ${lead.draft_hash} and its draft content hashes to ` +
          `${draftHash}; the draft changed after it was composed`,
      });
    }

    const queueState = {
      autonomy_enabled: autonomyEnabled(config),
      owner: lead.route.owner,
      draft_hash: draftHash,
    };
    const parked = { ...lead, queue: queueState, draft_hash: draftHash };

    const bound = decisions.find((record) => record?.draft_hash === draftHash);

    if (bound !== undefined) {
      // Belt and braces. Content keying makes cross-lead reuse structurally unlikely, since two
      // leads have different recipients and so different hashes. It does not make a hand-edited
      // store harmless, so the lead binding is checked as well as recorded.
      if (bound.lead_id !== undefined && bound.lead_id !== lead.lead_id) {
        return refuse({
          reason: 'APPROVAL_LEAD_MISMATCH',
          detail:
            `a decision bound to ${draftHash} names lead ${bound.lead_id}, and this lead is ` +
            `${lead.lead_id}; a decision about someone else does not release this draft`,
          output: parked,
        });
      }

      if (bound.decision === 'approve') {
        return pass({
          output: { ...parked, approval: bound },
          evidence_refs: [`draft:${draftHash}`],
          entries: [
            {
              verdict: 'PASS',
              actor: 'human',
              reason_codes: ['APPROVED_BY_HUMAN'],
              evidence_refs: [`draft:${draftHash}`],
              detail: `${bound.by} approved draft ${draftHash} at ${bound.at}`,
            },
          ],
        });
      }

      if (bound.decision === 'reject') {
        return refuse({
          reason: 'REJECTED_BY_HUMAN',
          detail: `${bound.by} rejected draft ${draftHash} at ${bound.at}${bound.note ? `: ${bound.note}` : ''}`,
          output: { ...parked, approval: bound },
          evidence_refs: [`draft:${draftHash}`],
          entries: [
            {
              verdict: 'REFUSE',
              actor: 'human',
              reason_codes: ['REJECTED_BY_HUMAN'],
              evidence_refs: [`draft:${draftHash}`],
              detail: `${bound.by} rejected draft ${draftHash} at ${bound.at}`,
            },
          ],
        });
      }

      // A decision nobody can interpret. Parks. Guessing what a human meant is exactly the
      // move this stage exists to prevent.
      return needsHuman({
        reason: 'AWAITING_APPROVAL',
        output: parked,
        evidence_refs: [`draft:${draftHash}`],
        detail: `recorded decision "${bound.decision}" is not one this stage recognises`,
      });
    }

    // No decision bound to this draft. Is there one bound to an EARLIER draft for this lead?
    // This is the M1 demo, closed: the human approved something, and this is not that thing.
    const stale = decisions.find((record) => record?.lead_id === lead.lead_id);
    if (stale !== undefined) {
      return needsHuman({
        reason: 'APPROVAL_STALE',
        output: parked,
        evidence_refs: [`draft:${draftHash}`],
        detail:
          `${stale.by} decided "${stale.decision}" on draft ${stale.draft_hash}, and this draft ` +
          `is ${draftHash}; the draft changed, so that decision does not cover it`,
      });
    }

    return needsHuman({
      reason: 'AWAITING_APPROVAL',
      output: parked,
      evidence_refs: [`draft:${draftHash}`],
      detail: `parked for ${lead.route.owner}; no human decision is on record for draft ${draftHash}`,
    });
  },
};
