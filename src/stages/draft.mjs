// Stage 5 — draft.
//
// In fixture mode the composition is a recorded template fill, which is deterministic and
// keyless. In live mode (M4) the same stage calls an LLM through ctx. The contract and the
// grounding rule do not change between the two, which is the point of composing rather than
// branching.
//
// Discipline enforced: every factual claim in the body traces to an enrichment citation.
// Grounding pattern adapted from business-brain; no code vendored.
//
// Two kinds of placeholder, deliberately distinguished:
//   {company_name}, {contact_first_name}  identity, resolved from the lead itself
//   {claim:field}                         a factual assertion, resolved only from a CITED claim
//
// The split is the whole idea. Addressing someone by name is not a claim about the world.
// Telling them how many people they employ is, and it needs a source fetched this run.

import { pass, refuse } from '../contract.mjs';
import { computeDraftHash } from '../draft-hash.mjs';
import { buildDraftPrompt, parseDraftResponse } from '../draft-prompt.mjs';

const PLACEHOLDER = /\{([a-z0-9_]+(?::[a-z0-9_]+)?)\}/g;

function firstNameOf(fullName) {
  return String(fullName).trim().split(/\s+/)[0];
}

// --- model mode, new in M4 -----------------------------------------------------------------
//
// `draft.mode` selects the composer. 'template' is M1's mechanical fill and remains the default,
// so a pipeline nobody reconfigured behaves exactly as it did. 'model' calls the LLM through the
// ctx.model seam.
//
// EVERY FAILURE IS A REFUSAL WITH ITS OWN CODE AND NOTHING FALLS BACK TO A TEMPLATE. That is the
// single most important line in this file. A fallback would produce a plausible artifact nobody
// chose, on a path the operator believes is running a model, and the ledger would record PASS. It
// is the rubric's rule applied one stage earlier: an outage that reads as success is an outage
// that authorises.
//
// What this stage does NOT do is adjudicate grounding. The model reports which claims it used and
// that report is carried through UNVERIFIED, because the gate is the single place grounding is
// decided. A second, weaker check here would invite somebody to trust it, and a lying self-report
// has to reach the gate intact in order to be refused there.
//
// See src/draft-prompt.mjs for the prompt, the untrusted fence, and why the prompt is not the
// defence.

async function composeWithModel(lead, ctx, config) {
  if (typeof ctx.model !== 'function') {
    return {
      failure: {
        reason: 'MODEL_UNAVAILABLE',
        detail:
          'draft is configured for model mode and this run has no model seam. A configured model ' +
          'that is absent is not a template; composing one anyway would put a message nobody ' +
          'chose on a path the operator believes is running a model',
      },
    };
  }

  // Checked before the call rather than after. A model handed no claims writes something pleasant
  // and unfounded, the gate refuses it, and the call was spent to learn what was already knowable.
  const cited = (lead.claims ?? []).filter((claim) => claim.cited && claim.citation);
  if (cited.length === 0) {
    return {
      failure: {
        reason: 'NO_CITED_CLAIMS',
        detail:
          'this lead carries no cited claim, so a model would have nothing to ground a sentence ' +
          'in. Refused before the call rather than after it',
      },
    };
  }

  const { system, prompt } = buildDraftPrompt(lead, { play: lead.route.play, brief: config.brief });

  let completion;
  try {
    completion = await ctx.model({ system, prompt });
  } catch (error) {
    return {
      failure: {
        // The transport names which kind of failure this was, because it is the only thing that
        // knows. An error carrying no code is still a refusal: an unknown failure is not a pass.
        reason: error?.stageCode ?? 'MODEL_UNAVAILABLE',
        detail: `the model did not produce a draft, so this lead is refused rather than templated: ${error.message}`,
      },
    };
  }

  let parsed;
  try {
    parsed = parseDraftResponse(completion?.text);
  } catch (error) {
    return {
      failure: {
        reason: error?.stageCode ?? 'MODEL_UNPARSEABLE',
        detail: error.message,
      },
    };
  }

  return {
    composed: {
      to: lead.contact.email,
      subject: parsed.subject,
      body: parsed.body,
      template: lead.route.play,
      claim_refs: parsed.claim_refs,
      composer: 'model',
      model: completion?.model ?? null,
    },
  };
}

export const draft = {
  name: 'draft',

  async run(lead, ctx) {
    const config = ctx.config.draft ?? {};
    const play = lead.route.play;

    if (typeof lead.contact?.name !== 'string' || lead.contact.name.trim() === '') {
      return refuse({
        reason: 'UNRESOLVED_IDENTITY',
        detail: 'the contact has no name, and addressing a blank is worse than not writing',
      });
    }

    if ((config.mode ?? 'template') === 'model') {
      const { composed, failure } = await composeWithModel(lead, ctx, config);
      if (failure !== undefined) return refuse(failure);

      const maxBodyChars = config.maxBodyChars ?? Infinity;
      if (composed.body.length > maxBodyChars) {
        return refuse({
          reason: 'DRAFT_TOO_LONG',
          detail: `body is ${composed.body.length} characters, over the ${maxBodyChars} limit`,
        });
      }

      return pass({
        output: { ...lead, draft: composed, draft_hash: computeDraftHash(composed) },
        evidence_refs: [...new Set(composed.claim_refs.map((c) => c.citation))].sort(),
      });
    }

    const template = (config.templates ?? {})[play];

    if (template === undefined) {
      return refuse({
        reason: 'NO_TEMPLATE_FOR_PLAY',
        detail: `no template is configured for play "${play}", and improvising one is not drafting`,
      });
    }

    const identity = {
      company_name: lead.company.name,
      contact_first_name: firstNameOf(lead.contact.name),
    };

    const claimsUsed = new Map();
    let failure = null;

    const fill = (text) =>
      text.replace(PLACEHOLDER, (whole, token) => {
        if (!token.startsWith('claim:')) {
          const value = identity[token];
          if (value === undefined) {
            failure ??= {
              reason: 'UNRESOLVED_IDENTITY',
              detail: `template references unknown identity field "${token}"`,
            };
            return whole;
          }
          return value;
        }

        const field = token.slice('claim:'.length);
        const claim = lead.claims.find((c) => c.field === field);
        if (claim === undefined) {
          failure ??= {
            reason: 'UNGROUNDED_CLAIM',
            detail: `template asserts "${field}", which this lead has no claim for`,
          };
          return whole;
        }
        if (!claim.cited || !claim.citation) {
          failure ??= {
            reason: 'UNGROUNDED_CLAIM',
            detail: `template asserts "${field}", which is uncited and cannot be stated as fact`,
          };
          return whole;
        }
        claimsUsed.set(field, claim.citation);
        return String(claim.value);
      });

    const subject = fill(template.subject);
    const body = fill(template.body);

    if (failure !== null) return refuse(failure);

    const maxBodyChars = config.maxBodyChars ?? Infinity;
    if (body.length > maxBodyChars) {
      return refuse({
        reason: 'DRAFT_TOO_LONG',
        detail: `body is ${body.length} characters, over the ${maxBodyChars} limit`,
      });
    }

    const claim_refs = [...claimsUsed.entries()]
      .map(([field, citation]) => ({ field, citation }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

    const composed = { to: lead.contact.email, subject, body, template: play, claim_refs };

    // The hash sits BESIDE the draft rather than inside it, so it is never part of its own
    // preimage. It is what the human approval downstream binds to, and what gate, queue and
    // handoff each recompute and compare, so a draft that changed between stages is a draft
    // nobody approved.
    return pass({
      output: { ...lead, draft: composed, draft_hash: computeDraftHash(composed) },
      evidence_refs: [...new Set(claim_refs.map((c) => c.citation))].sort(),
    });
  },
};
