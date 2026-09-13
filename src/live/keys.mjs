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
