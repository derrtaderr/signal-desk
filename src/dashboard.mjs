// The dashboard. One self-contained HTML file over one run's ledger.
//
// THE CONTRACT, in one sentence: this is a pure function of one run's ledger entries and nothing
// else.
//
// That is a stronger constraint than "read-only", and it is chosen deliberately. If a view a
// reader wants is not derivable from the ledger, the answer is that the ledger does not record
// it and the fix belongs in the stage that should have written it down. A dashboard that could
// show what the ledger cannot would quietly become the more trusted artifact, and then the
// ledger's completeness would stop being checkable. The queue stage writes `by` and `at` as
// fields for exactly this reason, rather than this module parsing them out of an English
// sentence.
//
// ESCAPING. This surface renders attacker-controlled text by design: the prompt-injection
// fixture's payload is quoted into the ledger on purpose, and the ledger is what this renders.
// Every interpolation goes through escapeHtml, WITHOUT EXCEPTION, including counts, timestamps,
// stage names and hardcoded labels. The donor pattern (gtm-agent-evals) took an XSS finding at
// the one interpolation somebody exempted because its type said it was safe. A rule with
// exemptions asks every future contributor to correctly re-derive which category their new field
// is in; a rule with none asks nothing of them.
//
// CSS class names are never interpolated from data. Where a verdict picks a colour, the code
// maps it to one of a fixed vocabulary first, so hostile data can choose among three known
// classes and can never supply a class string.
//
// NO JAVASCRIPT, AT ALL. The donor ships four static lines for a click affordance; this page
// ships none. Navigation is <details>/<summary> and fragment links, which are HTML and CSS
// features. Two things follow. A page with no script tag cannot execute an injected one. And
// because the page needs no runtime data there is no JSON island, so there is no </script>
// breakout to get wrong, no <!-- parsing hazard, and no U+2028 mismatch — a second escaping
// contract that escapeHtml would NOT have covered, and that the donor's own lesson is about
// having declined.
//
// Adapted from gtm-agent-evals' dashboard, which is a public repo. No code is vendored.

import { SEAL_STAGE, SEAL_LEAD_ID } from './ledger.mjs';
import { canonical } from './canonical.mjs';

// --- escaping ----------------------------------------------------------------------------

/**
 * The five characters that change how markup parses.
 *
 * Ampersand first, so an entity this function emits is not re-escaped by a later replacement.
 * String() because a ledger is parsed JSON and its fields are whatever was on disk, not whatever
 * a signature says they should be.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

// --- the view model ------------------------------------------------------------------------

const VERDICT_CLASS = Object.freeze({ PASS: 'pass', NEEDS_HUMAN: 'park', REFUSE: 'block' });

// A verdict never supplies a class name; it chooses among three known ones. Anything
// unrecognised falls to the neutral class rather than reaching the attribute.
function verdictClass(verdict) {
  return VERDICT_CLASS[verdict] ?? 'plain';
}

// Which part of the three-part gate a refusal came from.
//
// Derived from the reason code, because the gate's own `rules_run` report lives on the lead and
// not in the ledger. Deriving what is derivable and declining to invent the rest is the same
// rule as everywhere else here: a code this table does not know is reported as itself rather
// than guessed into a bucket.
const GATE_PARTS = Object.freeze({
  PLACEHOLDER_UNRESOLVED: 'deterministic rules',
  BANNED_PHRASE: 'deterministic rules',
  DRAFT_TOO_SHORT: 'deterministic rules',
  DRAFT_TOO_LONG: 'deterministic rules',
  UNGROUNDED_CLAIM: 'claim grounding',
  UNGROUNDED_PROSE_CLAIM: 'claim grounding',
  PROMPT_INJECTION: 'prompt injection',
  PII_IN_BODY: 'PII redaction',
  REDACTION_INCOMPLETE: 'PII redaction',
  RUBRIC_UNAVAILABLE: 'LLM rubric',
  RUBRIC_MISMATCH: 'LLM rubric',
  RUBRIC_MALFORMED: 'LLM rubric',
  RUBRIC_FAILED: 'LLM rubric',
  DRAFT_HASH_MISMATCH: 'draft integrity',
  GATE_ERROR: 'draft integrity',
});

// The single verdict entry for one (lead, stage) execution.
//
// The kernel appends a stage's supplementary entries FIRST and its verdict entry LAST, and a
// stage runs at most once per lead per run. So the verdict entry for a pair is the last entry
// carrying that pair. This is a derivation rather than a flag, which is why the funnel it feeds
// is checked against the seal summary the kernel computed for itself.
function verdictEntries(entries) {
  // Keyed by lead, then by stage. A composite string key would need a separator, and a
  // separator in a template literal is exactly where this repo has already lost an hour once:
  // a NUL byte landed invisibly inside one in src/stages/ingest.mjs. Nested maps need no
  // separator, so there is nothing to get wrong.
  const byLead = new Map();
  for (const entry of entries) {
    if (entry.stage === SEAL_STAGE) continue;
    if (!byLead.has(entry.lead_id)) byLead.set(entry.lead_id, new Map());
    byLead.get(entry.lead_id).set(entry.stage, entry);
  }
  return [...byLead.values()].flatMap((stages) => [...stages.values()]);
}

function tally(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

export function buildDashboardView(entries) {
  const list = [...entries];
  const seal =
    list.length > 0 && list[list.length - 1].stage === SEAL_STAGE ? list[list.length - 1] : null;
  const body = list.filter((entry) => entry.stage !== SEAL_STAGE);
  const verdicts = verdictEntries(list);

  // Stage order comes from the ledger itself, in order of first appearance, rather than from
  // the config. The dashboard describes what a run DID; importing the wiring would let it
  // describe a pipeline the ledger never ran.
  const stageOrder = [];
  for (const entry of body) {
    if (!stageOrder.includes(entry.stage)) stageOrder.push(entry.stage);
  }

  const funnel = stageOrder.map((stage) => {
    const rows = verdicts.filter((v) => v.stage === stage);
    return {
      stage,
      reached: rows.length,
      PASS: rows.filter((v) => v.verdict === 'PASS').length,
      NEEDS_HUMAN: rows.filter((v) => v.verdict === 'NEEDS_HUMAN').length,
      REFUSE: rows.filter((v) => v.verdict === 'REFUSE').length,
    };
  });

  const refusalRows = verdicts.filter((v) => v.verdict === 'REFUSE');
  // Grouped on the pair itself rather than on a joined string, for the separator reason above.
  const refusalGroups = new Map();
  for (const refusal of refusalRows) {
    const code = refusal.reason_codes.join(',');
    const existing = refusalGroups.get(refusal.stage)?.get(code);
    if (!refusalGroups.has(refusal.stage)) refusalGroups.set(refusal.stage, new Map());
    refusalGroups.get(refusal.stage).set(code, (existing ?? 0) + 1);
  }
  const refusals = [...refusalGroups]
    .flatMap(([stage, codes]) => [...codes].map(([code, count]) => ({ stage, code, count })))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const gateRows = verdicts.filter((v) => v.stage === 'gate');
  const gateRefusals = gateRows.filter((v) => v.verdict === 'REFUSE');
  const gate = {
    executions: gateRows.length,
    passed: gateRows.filter((v) => v.verdict === 'PASS').length,
    refused: gateRefusals.length,
    parts: [...tally(gateRefusals, (v) => GATE_PARTS[v.reason_codes[0]] ?? v.reason_codes[0])]
      .map(([part, count]) => ({
        part,
        count,
        codes: [
          ...new Set(
            gateRefusals
              .filter((v) => (GATE_PARTS[v.reason_codes[0]] ?? v.reason_codes[0]) === part)
              .map((v) => v.reason_codes[0]),
          ),
        ].sort(),
      }))
      .sort((a, b) => b.count - a.count || (a.part < b.part ? -1 : 1)),
  };

  // Every entry a person is responsible for. Read as fields, never parsed out of the detail.
  const decisions = body
    .filter((entry) => entry.actor === 'human')
    .map((entry) => ({
      ts: entry.ts,
      lead_id: entry.lead_id,
      draft_hash: entry.draft_hash ?? '',
      decision: entry.decision ?? '',
      by: entry.by ?? '',
      at: entry.at ?? '',
      note: entry.note,
      verdict: entry.verdict,
      reason_codes: entry.reason_codes,
    }));

  const leadIds = [];
  for (const entry of body) {
    if (entry.lead_id === SEAL_LEAD_ID) continue;
    if (!leadIds.includes(entry.lead_id)) leadIds.push(entry.lead_id);
  }

  const leads = leadIds.map((leadId) => {
    const trail = body.filter((entry) => entry.lead_id === leadId);
    const last = trail[trail.length - 1];
    return {
      lead_id: leadId,
      outcome: { verdict: last.verdict, stage: last.stage },
      entries: trail,
    };
  });

  return {
    run_id: list.length > 0 ? list[0].run_id : '',
    entry_count: list.length,
    seal,
    funnel,
    refusals,
    gate,
    decisions,
    leads,
    // The canonical serialiser, so the block on the page is byte-identical to the file on
    // disk. A dashboard that showed a DIFFERENT rendering of the same entries would be a
    // second account of the record, which is the one thing this module must never be.
    raw: list.length === 0 ? '' : `${list.map((entry) => canonical(entry)).join('\n')}\n`,
  };
}

// --- rendering -----------------------------------------------------------------------------
//
// Below this line every interpolation is escaped. If you add one that is not, the escaping rule
// has an exemption in it, and an exemption is how the donor's XSS landed.

function row(cells, tag = 'td') {
  return `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
}

function chip(text, cls) {
  return `<span class="chip ${e(cls)}">${e(text)}</span>`;
}

function count(value, cls) {
  return value === 0 ? '<span class="zero">0</span>' : `<span class="${e(cls)}">${e(value)}</span>`;
}

function funnelSection(view) {
  if (view.funnel.length === 0) {
    return section('funnel', 'Funnel', '<p class="empty">No stage ran in this ledger.</p>');
  }
  const rows = view.funnel
    .map((stage) =>
      row([
        `<code>${e(stage.stage)}</code>`,
        e(stage.reached),
        count(stage.PASS, 'pass'),
        count(stage.NEEDS_HUMAN, 'park'),
        count(stage.REFUSE, 'block'),
      ]),
    )
    .join('');

  return section(
    'funnel',
    'Funnel',
    `<p class="note">Every stage execution writes exactly one verdict entry, so these counts are
      the ledger read back rather than a separate tally. Reach never grows down the pipeline.</p>
     <div class="scroll"><table>
       <thead>${row(['Stage', 'Reached', 'Passed', 'Parked', 'Refused'], 'th')}</thead>
       <tbody>${rows}</tbody>
     </table></div>`,
  );
}

function refusalSection(view) {
  if (view.refusals.length === 0) {
    return section('refusals', 'Refusals', '<p class="empty">Nothing was refused in this run.</p>');
  }
  const rows = view.refusals
    .map((refusal) =>
      row([
        `<code>${e(refusal.code)}</code>`,
        `<code>${e(refusal.stage)}</code>`,
        e(refusal.count),
      ]),
    )
    .join('');

  return section(
    'refusals',
    'Refusals',
    `<p class="note">Grouped by reason code, commonest first. A refusal with no reason code
      cannot exist: the kernel rejects one.</p>
     <div class="scroll"><table>
       <thead>${row(['Reason', 'Stage', 'Count'], 'th')}</thead>
       <tbody>${rows}</tbody>
     </table></div>`,
  );
}

function gateSection(view) {
  if (view.gate.executions === 0) {
    return section('gate', 'Gate', '<p class="empty">No lead reached the gate in this run.</p>');
  }

  const parts =
    view.gate.parts.length === 0
      ? '<p class="note">The gate refused nothing in this run.</p>'
      : `<div class="scroll"><table>
           <thead>${row(['Part', 'Refusals', 'Codes'], 'th')}</thead>
           <tbody>${view.gate.parts
             .map((part) =>
               row([
                 e(part.part),
                 e(part.count),
                 part.codes.map((code) => `<code>${e(code)}</code>`).join(' '),
               ]),
             )
             .join('')}</tbody>
         </table></div>`;

  return section(
    'gate',
    'Gate',
    `<div class="cards">
       <div class="card"><div class="big">${e(view.gate.executions)}</div><div class="label">evaluated</div></div>
       <div class="card"><div class="big pass">${e(view.gate.passed)}</div><div class="label">passed</div></div>
       <div class="card"><div class="big block">${e(view.gate.refused)}</div><div class="label">refused</div></div>
     </div>
     <p class="note">Which part of the gate produced each refusal, derived from the reason code.
       A gate that errors refuses; it never passes.</p>
     ${parts}`,
  );
}

function decisionSection(view) {
  const body =
    view.decisions.length === 0
      ? `<p class="empty">No human decided anything in this run. Every survivor is still parked.</p>`
      : `<div class="scroll"><table>
           <thead>${row(['Decision', 'Draft', 'Lead', 'By', 'At', 'Note'], 'th')}</thead>
           <tbody>${view.decisions
             .map((decision) =>
               row([
                 chip(decision.decision || decision.reason_codes.join(','), verdictClass(decision.verdict)),
                 `<code>${e(decision.draft_hash)}</code>`,
                 `<code>${e(decision.lead_id)}</code>`,
                 e(decision.by),
                 `<span class="ts">${e(decision.at)}</span>`,
                 decision.note === undefined ? '<span class="zero">—</span>' : e(decision.note),
               ]),
             )
             .join('')}</tbody>
         </table></div>`;

  return section(
    'decisions',
    'Human decisions',
    `<p class="note">A decision binds to the draft's content hash, never to the lead. Edit one
      character of a draft and the decision above stops covering it.</p>
     ${body}
     <p class="note readonly">This page is a read-only view of the ledger. Decisions are made at
       the command line, with <code>node bin/signal-desk.mjs approve &lt;draft-hash&gt;</code>,
       and nothing here can change one.</p>`,
  );
}

function entryBlock(entry) {
  const parts = [
    `<div class="line"><span class="ts">${e(entry.ts)}</span> <code>${e(entry.stage)}</code> ` +
      `${chip(entry.verdict, verdictClass(entry.verdict))} <span class="actor">${e(entry.actor)}</span></div>`,
  ];
  if (entry.reason_codes.length > 0) {
    parts.push(
      `<div class="kv"><span class="k">reasons</span> ${entry.reason_codes
        .map((code) => `<code>${e(code)}</code>`)
        .join(' ')}</div>`,
    );
  }
  if (entry.detail !== undefined) {
    parts.push(`<div class="kv"><span class="k">detail</span> <span class="v">${e(entry.detail)}</span></div>`);
  }
  if (entry.evidence_refs.length > 0) {
    parts.push(
      `<div class="kv"><span class="k">evidence</span> <span class="v">${entry.evidence_refs
        .map((ref) => e(ref))
        .join('<br>')}</span></div>`,
    );
  }
  return `<div class="entry">${parts.join('')}</div>`;
}

function leadSection(view) {
  if (view.leads.length === 0) {
    return section('leads', 'Leads', '<p class="empty">This ledger carries no lead.</p>');
  }

  const blocks = view.leads
    .map(
      (lead) =>
        `<details>
           <summary>
             <code>${e(lead.lead_id)}</code>
             ${chip(`${lead.outcome.verdict} at ${lead.outcome.stage}`, verdictClass(lead.outcome.verdict))}
             <span class="zero">${e(lead.entries.length)} entries</span>
           </summary>
           ${lead.entries.map((entry) => entryBlock(entry)).join('')}
         </details>`,
    )
    .join('');

  return section(
    'leads',
    'Leads',
    `<p class="note">The same trail <code>node bin/signal-desk.mjs explain &lt;lead&gt;</code>
      prints. Open one to see every stage that ran, what it decided, and the evidence it stood
      on.</p>${blocks}`,
  );
}

function rawSection(view) {
  return section(
    'ledger',
    'The ledger itself',
    `<p class="note">The record this page describes, so the file you were handed contains it
      rather than pointing at it. Append-only JSONL, hash-chained.</p>
     <details><summary>${e(view.entry_count)} entries</summary>
       <div class="scroll"><pre><code>${e(view.raw)}</code></pre></div>
     </details>`,
  );
}

function section(id, heading, inner) {
  return `<section id="${e(id)}"><h2>${e(heading)}</h2>${inner}</section>`;
}

function headerBlock(view) {
  const seal =
    view.seal === null
      ? `<p class="warn">This ledger has no terminal seal, so it is not a record of a completed
          run. Either lines were removed from the end or the run did not finish. A hash chain
          proves order, not completeness.</p>`
      : `<div class="cards">
           <div class="card"><div class="big pass">${e(view.seal.summary.PASS)}</div><div class="label">passed to handoff</div></div>
           <div class="card"><div class="big park">${e(view.seal.summary.NEEDS_HUMAN)}</div><div class="label">awaiting a human</div></div>
           <div class="card"><div class="big block">${e(view.seal.summary.REFUSE)}</div><div class="label">refused</div></div>
           <div class="card"><div class="big">${e(view.seal.summary.total)}</div><div class="label">signals in total</div></div>
         </div>`;

  const nav = [
    ['funnel', 'Funnel'],
    ['refusals', 'Refusals'],
    ['gate', 'Gate'],
    ['decisions', 'Decisions'],
    ['leads', 'Leads'],
    ['ledger', 'Ledger'],
  ]
    .map(([id, label]) => `<a href="#${e(id)}">${e(label)}</a>`)
    .join('');

  return `<header>
    <h1>signal-desk</h1>
    <p class="sub">Run <code>${e(view.run_id)}</code>, ${e(view.entry_count)} ledger entries.
      Every decision below was read from the ledger and nothing else.</p>
    ${seal}
    <nav class="nav">${nav}</nav>
  </header>`;
}

/**
 * The whole page, as a string.
 *
 * Pure. It opens nothing and writes nothing; the CLI is what puts bytes on disk, which is the
 * same division the stages and the kernel follow and what keeps the escaping testable.
 */
export function renderDashboard(view) {
  if (view.entry_count === 0) {
    return page(
      view,
      `<header><h1>signal-desk</h1>
        <p class="sub">This ledger has no entries, so there is nothing to show. Run
          <code>node bin/signal-desk.mjs run</code> first.</p></header>`,
    );
  }

  return page(
    view,
    [
      headerBlock(view),
      `<main>`,
      funnelSection(view),
      refusalSection(view),
      gateSection(view),
      decisionSection(view),
      leadSection(view),
      rawSection(view),
      `</main>`,
      `<footer>Static view over one run's ledger. Read-only, offline, no dependencies.
        Nothing was sent; this tool never sends mail.</footer>`,
    ].join(''),
  );
}

function page(view, body) {
  const title = view.run_id === '' ? 'signal-desk' : `signal-desk ${view.run_id}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// System fonts only. No @font-face, no url(), nothing to fetch, so the page is identical over
// file:// with the network off.
const STYLE = `:root { color-scheme: light dark; --bg:#0f1115; --fg:#e7e9ee; --dim:#98a0b0;
  --line:#242833; --card:#161a22; }
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
  font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header, main, footer { max-width: 60rem; margin: 0 auto; }
h1 { font-size:1.6rem; margin:0 0 .35rem; letter-spacing:-.01em; }
h2 { font-size:1.05rem; margin:2.4rem 0 .6rem; padding-bottom:.4rem;
  border-bottom:1px solid var(--line); }
.sub { color:var(--dim); margin:0 0 1.2rem; }
.note { color:var(--dim); font-size:.87rem; margin:.4rem 0 .9rem; }
.readonly { border-left:2px solid var(--line); padding-left:.7rem; }
.empty { color:var(--dim); font-style:italic; }
.warn { color:#f0cf7a; background:#3a2f12; padding:.7rem .9rem; border-radius:6px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.86em; }
.nav { display:flex; flex-wrap:wrap; gap:.9rem; margin:1.2rem 0 0; font-size:.87rem; }
.nav a { color:var(--dim); text-decoration:none; border-bottom:1px solid var(--line); }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.7rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.8rem .9rem; }
.big { font-size:1.7rem; font-weight:600; line-height:1.1; }
.label { color:var(--dim); font-size:.8rem; margin-top:.2rem; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.9rem; }
th, td { text-align:left; padding:.45rem .7rem; border-bottom:1px solid var(--line);
  white-space:nowrap; }
th { color:var(--dim); font-weight:500; font-size:.8rem; text-transform:uppercase;
  letter-spacing:.04em; }
.chip { display:inline-block; padding:.1rem .45rem; border-radius:999px; font-size:.76rem;
  background:var(--card); }
.chip.pass { background:#12351f; color:#74e0a0; }
.chip.block { background:#3a1618; color:#f28b8b; }
.chip.park { background:#3a2f12; color:#f0cf7a; }
.chip.plain { color:var(--dim); }
.pass { color:#74e0a0; } .block { color:#f28b8b; } .park { color:#f0cf7a; }
.zero { color:var(--dim); }
details { border:1px solid var(--line); border-radius:8px; margin:.5rem 0;
  background:var(--card); }
summary { cursor:pointer; padding:.6rem .8rem; display:flex; gap:.6rem; align-items:center;
  flex-wrap:wrap; }
.entry { padding:.5rem .9rem .6rem; border-top:1px solid var(--line); }
.line { display:flex; gap:.55rem; align-items:center; flex-wrap:wrap; }
.ts { color:var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:.8rem; }
.actor { color:var(--dim); font-size:.8rem; }
.kv { margin-top:.3rem; font-size:.86rem; display:flex; gap:.5rem; }
.k { color:var(--dim); min-width:4.5rem; flex:none; }
.v { word-break:break-word; }
pre { margin:0; padding:.8rem; font-size:.75rem; line-height:1.45; }
footer { color:var(--dim); font-size:.82rem; margin-top:3rem; padding-top:1rem;
  border-top:1px solid var(--line); }`;
