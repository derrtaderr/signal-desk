import { createHash } from 'node:crypto';

// Key resolution, and the one place the precedence rule is written down. M4 spec §11.
//
// The environment is passed IN rather than read here. That keeps this module a pure function of
// its argument, lets the CLI tests drive every branch without touching process.env, and means the
// repo has exactly one line that reads the real environment (in src/cli.mjs) instead of a habit
// scattered across modules.
//
// WHY THE PREFIXED NAME WINS. A developer machine very often exports ANTHROPIC_API_KEY for
// unrelated work. An operator who wants THIS tool on a different key — a separate billing line, a
// key scoped to one project, a key they are willing to hand to a pipeline that fetches strangers'
// URLs — needs a way to say so without disturbing everything else on the machine. The prefixed
// variable is that way, so it has to outrank the ambient one. The reverse precedence would make
// the override impossible to express, which is the only thing precedence is for.

export const KEY_VARIABLES = Object.freeze(['SIGNAL_DESK_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY']);

// --- the signing-secret fingerprint --------------------------------------------------------
//
// A live run used to write `config.ingest.secret` verbatim into `runs/<id>/inputs.json`, the one
// artifact the README tells you to hand to other people. Found by the M4 ship-check.
//
// THE TENSION THAT MAKES THIS A DECISION RATHER THAN A DELETION. Replay re-executes ingest, and in
// raw mode ingest verifies an HMAC, which needs the secret. Taking it out of the capture takes
// something away from replay.
//
// THE CHOICE. The capture stores a fingerprint; replay resolves the real secret from the
// environment, exactly as the live run did. Three outcomes, and the third is the honest one:
//
//   matching secret    full re-execution, byte comparison, signatures genuinely re-verified
//   different secret   REFUSED by name, instead of a byte divergence reported as "the inputs or the
//                      wiring have changed" — which would send a reader hunting a code change that
//                      does not exist. This is the case the fingerprint exists for.
//   no secret          chain and seal verified, and replay SAYS the signatures were not re-verified
//                      and names the variable that would allow it.
//
// The alternative for the third row was to re-execute anyway with verification skipped. That was
// rejected: it would report "exact match" while having checked strictly less than the original run,
// so the word "match" would quietly stop meaning what a reader takes it to mean. A weaker claim
// stated plainly beats a stronger claim that is not quite true.
//
// THE RESIDUAL, stated rather than left to be discovered. This is a salted SHA-256 truncated to 64
// bits, not a password KDF. A LOW-ENTROPY secret is therefore brute-forceable offline from the
// fingerprint. That is acceptable because an HMAC secret shared with a sending system should be
// high-entropy random rather than memorable, and the truncation limits what an attacker gains; it
// is NOT acceptable to pretend otherwise, so it is written here. A deployment using a guessable
// shared secret has a bigger problem than this file.

const FINGERPRINT_DOMAIN = 'signal-desk/signal-secret-fingerprint/v1';

export function secretFingerprint(secret) {
  return createHash('sha256')
    .update(`${FINGERPRINT_DOMAIN}\n${String(secret ?? '')}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The config as it may be WRITTEN DOWN: the same object with every credential removed.
 *
 * Used for two things that must agree, which is why it is one function rather than two. The capture
 * stores this, and the run id is computed over this. If the id covered the secret and the capture
 * did not, a replay could never recompute the id it was checking against.
 *
 * It also means NO run id anywhere is a function of a credential, in fixture mode as well as live,
 * which is the uniform version of the rule and the one worth having.
 */
export function publicConfig(config) {
  if (config === null || typeof config !== 'object') return config;
  const ingest = config.ingest;
  if (ingest === null || typeof ingest !== 'object' || ingest.secret === undefined) return config;

  const { secret, ...rest } = ingest;
  return {
    ...config,
    ingest: { ...rest, secret_fingerprint: secretFingerprint(secret) },
  };
}

export class SecretMismatchError extends Error {
  constructor() {
    super(
      'the signing secret in your environment is not the one this run was executed with. Replaying ' +
        'with a different secret would refuse every signal for an invalid signature and report a ' +
        'byte mismatch, which reads as a code change rather than as the configuration difference it ' +
        'is. Unset SIGNAL_DESK_SIGNAL_SECRET to verify the chain and the seal without re-executing.',
    );
    this.name = 'SecretMismatchError';
    this.code = 'SECRET_MISMATCH';
  }
}

export class MissingKeyError extends Error {
  constructor() {
    super(
      'live mode needs a model key and found none. Export one of ' +
        `${KEY_VARIABLES.join(' or ')} and run again. ` +
        `${KEY_VARIABLES[0]} takes precedence, so it can point this tool at a different key from ` +
        'the one your shell already exports. Nothing was fetched, nothing was sent, and no run was written.',
    );
    this.name = 'MissingKeyError';
    this.code = 'LIVE_KEY_MISSING';
  }
}

/**
 * The key for live model calls, by precedence.
 *
 * A variable that is present but blank is NOT a key. An empty export is the shape a sourced
 * dotenv file leaves behind when a line is commented out, and treating it as present would send a
 * request guaranteed to 401 and report it as an outage.
 */
export function resolveModelKey(env = {}) {
  for (const name of KEY_VARIABLES) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  throw new MissingKeyError();
}

/**
 * Removes a known secret from any string before it is reported.
 *
 * Defence in depth rather than the primary mechanism. The primary mechanism is that the key lives
 * in one closure and is never handed to a stage, a config object, or a ledger entry. This exists
 * because one carrier is outside that guarantee: a provider's own 401 body can quote the
 * offending credential back, and a transport that passes an upstream message through verbatim
 * would put the key into a refusal detail and from there into the durable record.
 */
export const KEY_PLACEHOLDER = '[redacted:key]';

export function scrubKey(text, key) {
  if (typeof text !== 'string') return text;
  if (typeof key !== 'string' || key === '') return text;
  return text.split(key).join(KEY_PLACEHOLDER);
}

/**
 * One scrubber over every secret this process holds, for the transports to apply to any message
 * that came from outside.
 *
 * THE DISTINCTION THAT MAKES THIS SAFE. A transport handed this function does not HOLD a secret; it
 * holds the ability to remove one. The evidence transport in particular never sees a key and must
 * not, which is exactly why it could not scrub one on its own — and a message it relays from a
 * stranger's server can still carry whatever that server managed to observe.
 *
 * FOUND BY test/key-hygiene.test.mjs RATHER THAN BY REVIEW. A source whose error body echoed the
 * key put it into an enrich detail, then the ledger, then dashboard.html, which is a file somebody
 * opens in a browser and shares. The model transport was already scrubbing its own key; the
 * evidence transport was relaying upstream text verbatim because it had nothing to scrub WITH.
 */
export function secretScrubber(secrets = []) {
  const present = secrets.filter((secret) => typeof secret === 'string' && secret.trim() !== '');
  if (present.length === 0) return (text) => text;
  // Longest first, so a secret that contains another is removed whole rather than leaving a tail.
  const ordered = [...present].sort((a, b) => b.length - a.length);
  return (text) => {
    if (typeof text !== 'string') return text;
    let scrubbed = text;
    for (const secret of ordered) scrubbed = scrubbed.split(secret).join(KEY_PLACEHOLDER);
    return scrubbed;
  };
}
