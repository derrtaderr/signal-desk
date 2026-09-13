// The human decision store.
//
// `approve` and `reject` write here, and the next run reads it. It is the thing M1's
// fixtures/approvals.json stood in for.
//
// IT IS ITSELF A LEDGER. Same append-only JSONL, same hash chain, same entry shape, actor
// `human` throughout. Two reasons, and the second is the important one:
//
//   1. A decision store that can be edited without trace is not a record of authorisation. The
//      whole product claim is that a decision can be inspected afterwards, and a human's
//      decision is the one that matters most.
//   2. Every decision is bound to a DRAFT-CONTENT HASH. Rewriting which draft a decision
//      covers is exactly the attack the hash exists to stop, so the store that holds the
//      binding gets the same tamper-evidence as the run ledger.
//
// It lives under the runs directory rather than in the repo, because it is run output rather
// than repo content. A fresh clone therefore has no decisions and behaves identically for
// everyone, which is what keeps the README's examples true.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Ledger, parseLedger, verifyChain } from './ledger.mjs';

export const DECISIONS_FILE = 'approvals.jsonl';

export function decisionsPath(runsDir) {
  return join(runsDir, DECISIONS_FILE);
}

export class DecisionStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionStoreError';
  }
}

/**
 * Every decision on record, as ledger entries, verified.
 *
 * A store whose chain is broken throws rather than returning what it can read. Half a decision
 * store is not a decision store, and carrying on would mean running a pipeline against
 * authorisations that may have been rewritten.
 */
export function loadDecisionEntries(runsDir) {
  const path = decisionsPath(runsDir);
  if (!existsSync(path)) return [];

  const entries = parseLedger(readFileSync(path, 'utf8'));
  const chain = verifyChain(entries);
  if (!chain.ok) {
    throw new DecisionStoreError(
      `the decision store at ${path} has a broken hash chain: ${chain.reason}. ` +
        'It was edited after it was written, so no decision in it can be trusted.',
    );
  }
  return entries;
}

// The queue stage reads records, not ledger entries. This is the one translation between them.
export function decisionRecords(entries) {
  return entries.map((entry) => ({
    draft_hash: entry.draft_hash,
    lead_id: entry.lead_id,
    decision: entry.decision,
    by: entry.by,
    at: entry.at,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  }));
}

export function loadDecisions(runsDir) {
  return decisionRecords(loadDecisionEntries(runsDir));
}

/**
 * Appends one decision, rebuilding the chain over what is already there.
 *
 * Returns the written entry.
 */
export function appendDecision(runsDir, { draft_hash, lead_id, decision, by, at, note, run_id }) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new DecisionStoreError(`a decision must be approve or reject, not ${JSON.stringify(decision)}`);
  }

  const existing = loadDecisionEntries(runsDir);
  const ledger = new Ledger();
  // Re-appending re-derives every hash, so a store that was tampered with cannot be extended
  // into something that verifies. loadDecisionEntries has already refused that case; this is
  // what makes the new head cover the whole history rather than just the new line.
  for (const entry of existing) {
    const { hash, prev, ...payload } = entry;
    ledger.append(payload);
  }

  const written = ledger.append({
    ts: at,
    run_id,
    lead_id,
    stage: 'approval',
    verdict: decision === 'approve' ? 'PASS' : 'REFUSE',
    reason_codes: [decision === 'approve' ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN'],
    evidence_refs: [`draft:${draft_hash}`],
    actor: 'human',
    decision,
    draft_hash,
    by,
    at,
    ...(note === undefined ? {} : { note }),
  });

  const path = decisionsPath(runsDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ledger.toJSONL());

  return written;
}

/**
 * The decision currently binding a draft hash, or undefined.
 *
 * Last write wins, so a human who changes their mind can. The superseded decision stays in the
 * store, because the record of what was decided and when is the product.
 */
export function decisionFor(entries, draftHash) {
  return decisionRecords(entries)
    .filter((record) => record.draft_hash === draftHash)
    .pop();
}
