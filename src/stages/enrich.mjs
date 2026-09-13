// Stage 2 — enrich.
//
// Discipline enforced: every claim binds to a citation fetched in the same run. Claims
// that arrived with the signal are kept, but marked uncited, and the draft stage is barred
// from using them. Pattern adapted from account-scout; no code vendored.
//
// A source that does not answer is skipped, never invented. Enrich is not a gate, so a
// missing source degrades the evidence rather than refusing outright; the refusal comes
// when there is no fetched evidence at all, because there is then nothing to ground a
// draft in.

import { pass, refuse } from '../contract.mjs';
import { detectInjection, describeInjection } from '../injection.mjs';

function expand(template, lead) {
  return template
    .replaceAll('{domain}', lead.company.domain)
    .replaceAll('{email}', lead.contact.email);
}

// --- evidence freshness ------------------------------------------------------------------
//
// A 200 is not freshness. A source can answer perfectly, in a well-formed shape, with a record
// that was true two years ago, and headcount, funding stage and role are exactly the fields that
// rot. Until M3 this pipeline would state any of them as a current fact.
//
// Every claim response must carry an `as_of` instant, and it is compared against the run's own
// clock with peek() rather than now(), because a validation check must not advance the clock.
// A ledger whose instants depend on how many branches a stage took is not replayable, which is
// the rule ingest's replay window has followed since M1.
//
// THE UNDATED CASE IS THE LOAD-BEARING ONE, and it is M2's redaction argument applied to time.
// Redaction is two passes because a single pass cannot tell "there was no PII" apart from "my
// pattern did not match". A response with no `as_of` cannot tell "fetched fresh" apart from
// "read out of a cache in 2019". Treating undated evidence as fresh would put the entire rule at
// the mercy of a source that simply declines to date itself, which is the cheapest possible
// bypass, so undated evidence is unusable and the corpus contains none.

// WHAT AN as_of IS, stated because M4 is where it stops being a value this repo committed and
// starts being whatever a stranger's server says.
//
// `as_of` is an ASSERTION BY THE SOURCE. It is not a verification by this pipeline, and no plain
// GET can make it one. A source that lies about its dates defeats this rule completely and
// nothing here will notice.
//
// What the rule does buy, stated precisely so nobody over-reads it: it catches the CARELESS
// source, the one honestly serving a stale record with an honest date, which is the common case.
// And it forces the dishonest source to lie EXPLICITLY and in writing, which is a rarer failure
// than negligence and leaves a dated artifact in the ledger for somebody to find. That is a
// smaller claim than "freshness is verified" and it is the true one.
//
// The one thing self-assertion cannot buy is a date in the FUTURE. A source cannot have observed
// something that has not happened, so a future as_of is a broken clock or an attempt to sit
// permanently inside the freshness window, and either way the record's real age is unknowable —
// which is the undated case wearing a date. The skew tolerance exists because an honest clock
// can run a minute fast, and punishing that would be catching a rounding error rather than a lie.

export const DEFAULT_MAX_EVIDENCE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

// Returns null when the evidence is usable, or the reason it is not.
function decayOf(response, ctx) {
  const maxAgeMs = ctx.config.enrich?.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const toleranceMs = ctx.config.enrich?.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
  const asOf = response.body?.as_of;

  if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) {
    return {
      code: 'EVIDENCE_UNDATED',
      describe: (url) =>
        `${url} answered 200 and its record carries no readable as_of, so its age cannot be ` +
        'checked. Undated evidence is not fresh evidence; it is evidence of unknown age',
    };
  }

  const ageMs = Date.parse(ctx.clock.peek()) - Date.parse(asOf);

  if (ageMs < -toleranceMs) {
    return {
      code: 'EVIDENCE_FUTURE_DATED',
      describe: (url) =>
        `${url} answered with a record dated ${asOf}, which is after this run's own clock by ` +
        `more than the ${Math.floor(toleranceMs / 1000)}s skew tolerance. A source cannot have ` +
        'observed something that has not happened, so the record is either clock-broken or ' +
        'claiming a freshness it cannot have. Its real age is unknowable, which is the undated ' +
        'case wearing a date',
    };
  }

  if (ageMs > maxAgeMs) {
    const days = Math.floor(ageMs / 86400000);
    return {
      code: 'EVIDENCE_DECAYED',
      describe: (url) =>
        `${url} answered with a record dated ${asOf}, which is ${days} days old and outside the ` +
        `${Math.floor(maxAgeMs / 86400000)} day freshness window. A stale record stated as a ` +
        'current fact is a false claim with a citation attached',
    };
  }

  return null;
}

// --- identity verification -------------------------------------------------------------
//
// Whether the human this signal names is the human the evidence describes.
//
// Vendor-side identity resolution is probabilistic. A shared office IP, a stale record, or
// somebody who changed jobs last quarter all produce a signal correctly attributed to a
// company and wrongly attributed to a person, and until M3 nothing here looked.
//
// It runs FIRST, before any claim source. A person the evidence contradicts should not consume
// the claim fetches, and the trail then reads the way a human reasons about it: who is this,
// and only then what do we know about them.
//
// Three outcomes, and the third is the one worth arguing about. Confirmed proceeds and says so.
// CONTRADICTED refuses. Anything else — no source configured, no recording, a non-200, a body
// with no identity block — proceeds and is reported as UNVERIFIED.
//
// That third outcome is not a fail-open, and the distinction is checkable rather than a matter
// of trust. Fail-closed is a rule about GATES THAT CANNOT FORM AN OPINION; enrich is not a gate,
// and a source that does not answer has degraded the evidence rather than refused since M1.
// "We have no identity evidence" is the state every lead in every prior milestone was in.
// Refusing it would be a new product policy, mandatory person-level enrichment on every lead,
// with a cost this milestone has not argued. What fail-closed genuinely requires here is that
// ABSENCE NEVER READS AS CONFIRMATION, and it does not: the ledger says IDENTITY_UNVERIFIED out
// loud, which is the difference between a known gap and an invisible one. The boundary is named
// in the README rather than left to be discovered.

function normaliseName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// What the record and the signal must agree about, and what each disagreement means.
// Named as a table because this table IS the rule.
const IDENTITY_FIELDS = [
  {
    name: 'company_domain',
    claimed: (lead) => lead.company.domain,
    describe: (recorded, claimed) =>
      `the signal places ${claimed} behind this visit and the person record puts them at ${recorded}`,
  },
  {
    name: 'name',
    claimed: (lead) => lead.contact.name,
    describe: (recorded, claimed) =>
      `the signal names ${claimed} and the person record at that address is ${recorded}`,
  },
  {
    name: 'email',
    claimed: (lead) => lead.contact.email,
    // The URL was keyed on the contact's own address, so a record naming a different one is the
    // source answering a question nobody asked.
    describe: (recorded, claimed) =>
      `the person record was fetched for ${claimed} and describes ${recorded}`,
  },
];

async function verifyIdentity(lead, ctx) {
  // In signal mode the person-level source is named by the payload, exactly as the claim sources
  // are, and for the same reasons: no vendor in the repo, no provider account needed, and the
  // evidence a run stands on is the evidence the payload pointed at. A signal that names none gets
  // no identity check, which is the state every lead was in before M3 and is reported as such.
  const template =
    (ctx.config.enrich?.sourcesFrom ?? 'config') === 'signal'
      ? lead.identity_source
      : ctx.config.enrich?.identitySource;
  if (typeof template !== 'string' || template === '') return { entries: [] };

  const url = expand(template, lead);
  const unverified = (why) => ({
    entries: [
      {
        verdict: 'PASS',
        reason_codes: ['IDENTITY_UNVERIFIED'],
        evidence_refs: [url],
        detail:
          `${why}, so nothing confirms this is the right person. Proceeding on the signal's own ` +
          'account of who they are, which is not the same as having checked',
      },
    ],
  });

  let response;
  try {
    response = await ctx.fetch(url);
  } catch (error) {
    return unverified(`${url} had no recording: ${error.message}`);
  }

  if (response.status !== 200) return unverified(`${url} answered ${response.status}`);

  // An expired or undated person record cannot contradict anything. It is the same state as
  // having no identity evidence at all, which is where every lead stood before M3.
  const decay = decayOf(response, ctx);
  if (decay !== null) return unverified(decay.describe(url));

  const identity = response.body?.identity;
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    return unverified(`${url} answered 200 and carried no identity record`);
  }

  // Counted, not assumed. A record carrying none of the fields in the table above used to skip
  // every iteration and fall out of the loop into the confirmation below, so an EMPTY identity
  // record read as CONFIRMED — the one path in this module where absence read as confirmation,
  // which is the exact thing its own rule forbids. Corpus-unreachable, because every recorded
  // person response is complete; reachable on the first live person-lookup that answers thin.
  // PR #3 review finding, closed before any live identity source could reach it.
  const compared = [];
  for (const field of IDENTITY_FIELDS) {
    const recorded = identity[field.name];
    if (recorded === undefined) continue;
    compared.push(field.name);
    const claimed = field.claimed(lead);
    if (normaliseName(recorded) === normaliseName(claimed)) continue;

    return {
      entries: [],
      refusal: {
        reason: 'IDENTITY_CONTRADICTED',
        evidence_refs: [url],
        detail:
          `${field.describe(recorded, claimed)}. Writing to the wrong human is not a smaller ` +
          'mistake than writing the wrong thing',
      },
    };
  }

  if (compared.length === 0) {
    return unverified(
      `${url} answered 200 with an identity record that carries no comparable field, so this ` +
        `run compared no field against the signal (it looks for ` +
        `${IDENTITY_FIELDS.map((f) => f.name).join(', ')})`,
    );
  }

  // The bar is ONE comparison, not three. A source that confirms the address and says nothing
  // about the company is still evidence, and demanding a complete record would be the mandatory
  // person-level enrichment policy M3 declined to adopt. The count is on the record so a reader
  // can weigh the confirmation instead of taking the word CONFIRMED at face value.
  return {
    entries: [
      {
        verdict: 'PASS',
        reason_codes: ['IDENTITY_CONFIRMED'],
        evidence_refs: [url],
        detail:
          `${url} confirms ${lead.contact.name} at ${lead.company.domain} on ` +
          `${compared.length} of ${IDENTITY_FIELDS.length} fields (${compared.join(', ')})`,
      },
    ],
  };
}

export const enrich = {
  name: 'enrich',

  async run(lead, ctx) {
    // WHERE THE SOURCE URLS COME FROM, new in M4. 'config' is the templated vendor URL every prior
    // milestone used. 'signal' is live mode: the payload names its own citation URLs.
    //
    // The second needs no provider account, so a stranger with a key and a JSON endpoint can run
    // the whole motion; it keeps every vendor out of the open repo, which DESIGN.md's non-scope
    // requires; and it makes "every claim binds to a citation fetched in this run" LITERAL. The
    // payload asserts where the evidence is and the pipeline fetches exactly that, so a claim with
    // no fetched citation behind it is structurally impossible rather than merely checked for.
    const sources =
      (ctx.config.enrich?.sourcesFrom ?? 'config') === 'signal'
        ? lead.sources ?? []
        : ctx.config.enrich?.sources ?? [];
    const claims = [];
    const citations = [];
    const entries = [];
    // How many sources answered and were then thrown away for their age. It is what separates
    // "everything we have is out of date" from "nothing knows this company", which are different
    // problems that send a reader somewhere different. The codes are collected too, so the
    // refusal can name what actually happened rather than assume it was staleness.
    let decayed = 0;
    const decayCodes = new Set();
    // The instants at which THIS RUN fetched, as reported by the transport. Absent in fixture
    // mode, where the responses were recorded rather than observed.
    const observed = [];

    // Identity first. See the block comment above for why the order is part of the rule.
    const identity = await verifyIdentity(lead, ctx);
    entries.push(...identity.entries);
    if (identity.refusal !== undefined) return refuse({ ...identity.refusal, entries });

    for (const template of sources) {
      const url = expand(template, lead);
      let response;

      try {
        response = await ctx.fetch(url);
      } catch (error) {
        // The transport names WHICH kind of failure this was, because it is the only thing that
        // knows. A timeout, an oversized body and a plaintext citation are three different problems
        // with three different fixes, and flattening them into SOURCE_UNAVAILABLE would throw away
        // the only information an operator could act on. A fixture-mode NoRecordingError carries no
        // stage code, so it still reports SOURCE_UNAVAILABLE exactly as it did.
        entries.push({
          verdict: 'PASS',
          reason_codes: [error?.stageCode ?? 'SOURCE_UNAVAILABLE'],
          evidence_refs: [url],
          detail: `${url} did not answer usefully: ${error.message}`,
        });
        continue;
      }

      if (response.status !== 200) {
        entries.push({
          verdict: 'PASS',
          reason_codes: ['SOURCE_UNAVAILABLE'],
          evidence_refs: [url],
          detail: `${url} answered ${response.status}`,
        });
        continue;
      }

      // It answered, and what it said may still be too old to say. Dropped rather than
      // downgraded: a claim nobody may state is not made safer by being left lying around
      // where a later rule might pick it up.
      const decay = decayOf(response, ctx);
      if (decay !== null) {
        decayed += 1;
        decayCodes.add(decay.code);
        entries.push({
          verdict: 'PASS',
          reason_codes: [decay.code],
          evidence_refs: [url],
          detail: decay.describe(url),
        });
        continue;
      }

      citations.push(url);
      if (typeof response.fetched_at === 'string') observed.push(response.fetched_at);
      for (const [field, value] of Object.entries(response.body?.claims ?? {})) {
        // Flagged, not dropped, and not refused. Enrich is not a gate, and the gate is the
        // stage whose job is judging text. Dropping it here would make the lead refuse for a
        // MISSING claim, which reports the wrong thing about what happened; refusing here would
        // hide the fact that a poisoned field travels all the way into a composed message
        // before anything stops it. What enrich owes is the FLAG, at the point a reader looks
        // to find out where the hostile bytes came from. See src/injection.mjs.
        const findings = typeof value === 'string' ? detectInjection(value) : [];
        if (findings.length > 0) {
          entries.push({
            verdict: 'PASS',
            reason_codes: ['INJECTION_MARKED'],
            evidence_refs: [url],
            detail:
              `the claim "${field}" fetched from ${url} contains ${describeInjection(findings)}. ` +
              'It is kept and marked rather than dropped, so the gate refuses the draft for what ' +
              'the source actually did rather than for a claim that went missing',
          });
        }

        claims.push({
          field,
          value,
          citation: url,
          cited: true,
          ...(findings.length > 0 ? { injection: true } : {}),
        });
      }
    }

    // Everything the signal asserted about itself. Real, usable for routing, and not
    // evidence, because nothing outside the signal corroborates it.
    for (const [field, value] of [
      ['company_name', lead.company.name],
      ['contact_title', lead.contact.title],
      ['intent_page', lead.intent?.page],
      ['intent_visits', lead.intent?.visits],
    ]) {
      if (value === undefined) continue;
      claims.push({ field, value, citation: null, cited: false });
    }

    if (citations.length === 0) {
      // Two codes, by cause, on the same argument ingest uses for DUPLICATE_SIGNAL versus
      // DUPLICATE_LEAD: these are different events and a reader deserves to be told which one
      // happened. "Every source we have is out of date" is a sourcing problem with a fix.
      // "No source knows this company" may mean the company does not exist.
      if (decayed > 0) {
        return refuse({
          reason: 'EVIDENCE_DECAYED',
          entries,
          detail:
            `every source that answered carried a record this run cannot date or cannot use ` +
            `(${[...decayCodes].sort().join(', ')}), so nothing this run fetched can ground a ` +
            'claim. The sources are reachable; what they know is unusable',
        });
      }

      return refuse({
        reason: 'NO_CITED_CLAIMS',
        entries,
        detail: 'no configured source answered, so no claim can be grounded',
      });
    }

    // Sorted, so the ledger bytes never depend on the order the sources answered in.
    claims.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    citations.sort();

    // Two dates, and the entry says which is which. `fetched_at` is this run's own observation
    // and is verified by construction; `as_of` is the source's assertion about when its record
    // was true. Conflating them would let a source's claim about the past borrow the authority
    // of something we actually did. Only live transports report an observation, so a fixture
    // run's entry is unchanged.
    const observation =
      observed.length === 0
        ? {}
        : {
            detail:
              `${observed.length} of ${citations.length} citation(s) were fetched by this run ` +
              `between ${observed.slice().sort()[0]} and ${observed.slice().sort().pop()}. That ` +
              'instant is this run\'s own observation; every as_of beside it is the source\'s ' +
              'assertion about its record and is not verified by this pipeline',
          };

    return pass({
      output: { ...lead, claims, citations },
      entries,
      evidence_refs: citations,
      ...observation,
    });
  },
};
