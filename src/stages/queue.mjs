// Stage 7 — queue. M1 scope.
//
// Everything parks for a human by default. That is the send boundary, and it is the reason
// this pipeline is safe to run against a real list before anyone trusts it.
//
// M1/M2 boundary: the approval WORKFLOW is M2 — the `queue`, `approve` and `reject` verbs
// and the state they mutate. What M1 reads is fixtures/approvals.json, a record of decisions
// humans made outside this system, so the fixture run can demonstrate all eight stages. This
// stage writes nothing. When M2 lands the real queue, that file is what it replaces.
//
// The earned-autonomy hook exists here and ships disabled, per the design's send boundary.
// Enabling it requires config.queue.autonomy.enabled === true, an explicit opt-in that the
// repo's own default config does not contain and a test pins.

import { pass, refuse, needsHuman } from '../contract.mjs';

function autonomyEnabled(config) {
  return config.autonomy?.enabled === true;
}

export const queue = {
  name: 'queue',

  run(lead, ctx) {
    const config = ctx.config.queue ?? {};
    const enabled = autonomyEnabled(config);
    const queueState = { autonomy_enabled: enabled, owner: lead.route.owner };
    const decision = (config.approvals ?? {})[lead.lead_id];

    if (decision?.decision === 'approve') {
      return pass({
        output: { ...lead, queue: queueState, approval: decision },
        entries: [
          {
            verdict: 'PASS',
            actor: 'human',
            reason_codes: ['APPROVED_BY_HUMAN'],
            detail: `${decision.by} approved this draft at ${decision.at}`,
          },
        ],
      });
    }

    if (decision?.decision === 'reject') {
      return refuse({
        reason: 'REJECTED_BY_HUMAN',
        detail: `${decision.by} rejected this draft at ${decision.at}${decision.note ? `: ${decision.note}` : ''}`,
        output: { ...lead, queue: queueState, approval: decision },
        entries: [
          {
            verdict: 'REFUSE',
            actor: 'human',
            reason_codes: ['REJECTED_BY_HUMAN'],
            detail: `${decision.by} rejected this draft at ${decision.at}`,
          },
        ],
      });
    }

    // No decision, or a decision nobody can interpret. Both park. Guessing what a human
    // meant is exactly the move this stage exists to prevent.
    return needsHuman({
      reason: 'AWAITING_APPROVAL',
      output: { ...lead, queue: queueState },
      detail: decision
        ? `recorded decision "${decision.decision}" is not one this stage recognises`
        : `parked for ${lead.route.owner}; no human decision is on record`,
    });
  },
};
