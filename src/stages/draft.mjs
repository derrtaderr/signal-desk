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

const PLACEHOLDER = /\{([a-z0-9_]+(?::[a-z0-9_]+)?)\}/g;

function firstNameOf(fullName) {
  return String(fullName).trim().split(/\s+/)[0];
}

export const draft = {
  name: 'draft',

  run(lead, ctx) {
    const config = ctx.config.draft ?? {};
    const play = lead.route.play;
    const template = (config.templates ?? {})[play];

    if (template === undefined) {
      return refuse({
        reason: 'NO_TEMPLATE_FOR_PLAY',
        detail: `no template is configured for play "${play}", and improvising one is not drafting`,
      });
    }

    if (typeof lead.contact.name !== 'string' || lead.contact.name.trim() === '') {
      return refuse({
        reason: 'UNRESOLVED_IDENTITY',
        detail: 'the contact has no name, and addressing a blank is worse than not writing',
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

    return pass({
      output: { ...lead, draft: { to: lead.contact.email, subject, body, template: play, claim_refs } },
      evidence_refs: [...new Set(claim_refs.map((c) => c.citation))].sort(),
    });
  },
};
