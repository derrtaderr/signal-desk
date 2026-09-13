// The dead-letter queue. M4 spec §8.
//
// M1's divergence register: "The design's ingest row names a DLQ; M1 ships none." This is it, and
// the boundary is the design rather than an implementation detail, so it is argued here.
//
// WHAT GOES IN. Signals INGEST REFUSED — malformed, unsigned, wrongly signed, outside the replay
// window — plus payload files that could not be parsed into a signal at all.
//
// WHAT DOES NOT. Leads refused downstream. The ledger already records those decisions completely,
// and retaining a payload whose gate refusal was CORRECT invites somebody to replay it until it
// passes. The distinction is between "we could not accept this" and "we accepted it and said no",
// and only the first has a fix at the sender.
//
// DUPLICATES ARE EXCLUDED. DUPLICATE_SIGNAL and DUPLICATE_LEAD are the idempotency layer working
// exactly as designed. A dead letter for a successful no-op is an invitation to redeliver something
// the pipeline has already correctly declined to act on twice.
//
// WHY THE RAW BYTES ARE RETAINED, given the ledger holds the decision. They are different artifacts
// answering different questions. The ledger says what this pipeline decided and why, and it
// deliberately does not keep payloads. The DLQ keeps the payload so the sender can be fixed and the
// SAME BYTES re-fed, which is the only recovery that proves the fix. A reason code without the
// message it was about cannot be retried.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const DLQ_DIR = 'dlq';

// Refusals that are the idempotency layer working, rather than something a sender could fix.
export const NOT_DEAD_LETTERED = Object.freeze(['DUPLICATE_SIGNAL', 'DUPLICATE_LEAD']);

export function isDeadLetterable(reason) {
  return typeof reason === 'string' && reason !== '' && !NOT_DEAD_LETTERED.includes(reason);
}

export function dlqPath(runsDir) {
  return join(runsDir, DLQ_DIR);
}

// Named by a digest of the bytes, so re-feeding the same broken payload twice leaves one dead
// letter rather than a growing pile of identical ones.
function filenameFor(entry) {
  const digest = createHash('sha256').update(entry.raw ?? '').digest('hex').slice(0, 12);
  return `${entry.reason.toLowerCase()}-${digest}.json`;
}

export function writeDeadLetter(runsDir, entry) {
  const dir = dlqPath(runsDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filenameFor(entry));
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        reason: entry.reason,
        detail: entry.detail ?? null,
        source: entry.source ?? null,
        signal_id: entry.signal_id ?? null,
        at: entry.at ?? null,
        run_id: entry.run_id ?? null,
        // The signature travels with the bytes, so a re-feed is the same message and not a
        // reconstruction of it. An operator fixing their signing edits this field and replays.
        signature: entry.signature ?? '',
        raw: entry.raw ?? '',
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export function readDeadLetters(runsDir) {
  const dir = dlqPath(runsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}
