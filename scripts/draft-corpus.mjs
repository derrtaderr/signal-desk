// Composes every draft the fixture corpus produces, without running the gate.
//
// Two generated fixture files need this: the recorded judge responses (rubric.json) and the
// recorded human decisions (approvals.json). Both are addressed BY DRAFT HASH, so both are
// DERIVED from whatever drafts the pipeline currently composes rather than hand-authored.
//
// The chicken-and-egg — the gate needs the recordings these scripts produce — is resolved by
// running only the stages BEFORE the gate. Nothing here runs the gate, the queue, or handoff.

import { loadFixtures, buildRun } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { ingest } from '../src/stages/ingest.mjs';
import { enrich } from '../src/stages/enrich.mjs';
import { score } from '../src/stages/score.mjs';
import { route } from '../src/stages/route.mjs';
import { draft } from '../src/stages/draft.mjs';

// Everything up to, but not including, the gate.
export const UP_TO_DRAFT = [ingest, enrich, score, route, draft];

/**
 * Every lead that reaches a composed draft, in the order the pipeline processes them.
 *
 * Returns [{ lead_id, draft_hash, to, subject }].
 */
export async function composeDrafts() {
  const fixtures = loadFixtures();
  // The real config with a truncated stage list, so drafts are composed exactly as the full
  // pipeline composes them.
  const built = buildRun({ fixtures, stages: UP_TO_DRAFT });
  const report = await runPipeline({
    stages: UP_TO_DRAFT,
    signals: built.signals,
    ctx: built.ctx,
    ledger: built.ledger,
  });

  return report.leads
    .filter((lead) => lead.final_status === 'PASS' && lead.output?.draft_hash !== undefined)
    .map((lead) => ({
      lead_id: lead.lead_id,
      draft_hash: lead.output.draft_hash,
      to: lead.output.draft.to,
      subject: lead.output.draft.subject,
    }));
}

// Sorted keys and a trailing newline, so regenerating a fixture produces a stable diff.
export function serializeFixture(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
