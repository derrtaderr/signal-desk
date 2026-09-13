// The pipeline kernel. It executes an ordered sequence of stages under one contract and
// is the only writer to the ledger.
//
// Two invariants live here rather than in the stages, because a discipline that depends on
// every stage remembering it is not a discipline:
//
//   1. Fail-closed. A stage that throws, or returns something the contract does not
//      recognise, becomes a REFUSE. There is no path through this function where an error
//      becomes a PASS.
//   2. Uniform trail. Every stage execution writes exactly one verdict entry, plus any
//      supplementary evidence entries the stage returned. A stage cannot run silently.

import {
  PASS,
  REFUSE,
  NEEDS_HUMAN,
  assertStageResult,
  ContractViolationError,
} from './contract.mjs';

const STAGE_ERROR = 'STAGE_ERROR';
const CONTRACT_VIOLATION = 'CONTRACT_VIOLATION';

function initialLeadId(signal, index) {
  if (signal && typeof signal === 'object') {
    if (typeof signal.lead_id === 'string' && signal.lead_id !== '') return signal.lead_id;
    if (typeof signal.id === 'string' && signal.id !== '') return signal.id;
  }
  return `unidentified-${index}`;
}

function sortSignals(signals) {
  return signals
    .map((signal, index) => ({ signal, index, key: initialLeadId(signal, index) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
}

export async function runPipeline({ stages, signals, ctx, ledger }) {
  const leads = [];
  const summary = { PASS: 0, REFUSE: 0, NEEDS_HUMAN: 0, total: 0 };

  for (const { signal, index } of sortSignals(signals)) {
    let leadId = initialLeadId(signal, index);
    let input = signal;
    let finalStatus = PASS;
    let finalStage = null;
    let reasonCodes = [];

    for (const stage of stages) {
      let result;

      try {
        result = assertStageResult(await stage.run(input, ctx), stage.name);
      } catch (error) {
        const isContract = error instanceof ContractViolationError;
        result = {
          status: REFUSE,
          output: input,
          entries: [],
          reason_codes: [isContract ? CONTRACT_VIOLATION : STAGE_ERROR],
          detail: error.message,
        };
      }

      // A stage may assign the canonical lead id — ingest does, deriving it from the
      // company and contact. Adopt it BEFORE stamping, so every entry for this stage,
      // including ingest's own verdict, files under one id and `explain <lead>` returns the
      // whole trail rather than one that starts at the second stage. What we knew before is
      // not lost: ingest records `signal:<id>` in its evidence.
      if (result.status === PASS) {
        const assigned = result.output;
        if (assigned && typeof assigned === 'object' && typeof assigned.lead_id === 'string') {
          leadId = assigned.lead_id;
        }
      }
      const stampedLeadId = leadId;

      const stamp = (entry) => ({
        reason_codes: [],
        evidence_refs: [],
        actor: 'system',
        verdict: result.status,
        stage: stage.name,
        ...entry,
        ts: ctx.clock.now(),
        run_id: ctx.run_id,
        lead_id: stampedLeadId,
      });

      for (const entry of result.entries) ledger.append(stamp(entry));

      ledger.append(
        stamp({
          stage: stage.name,
          verdict: result.status,
          reason_codes: result.reason_codes ?? [],
          evidence_refs: result.evidence_refs ?? [],
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }),
      );

      finalStage = stage.name;
      finalStatus = result.status;
      reasonCodes = result.reason_codes ?? [];

      if (result.status !== PASS) break;

      input = result.output;
    }

    leads.push({
      lead_id: leadId,
      final_status: finalStatus,
      final_stage: finalStage,
      reason_codes: reasonCodes,
      output: input,
    });
    summary[finalStatus] += 1;
    summary.total += 1;
  }

  return { run_id: ctx.run_id, leads, summary };
}

export { PASS, REFUSE, NEEDS_HUMAN, STAGE_ERROR, CONTRACT_VIOLATION };
