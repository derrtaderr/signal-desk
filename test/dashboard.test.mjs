// The dashboard: one self-contained HTML file over one run's ledger.
//
// THIS SURFACE RENDERS ATTACKER-CONTROLLED TEXT BY DESIGN. The prompt-injection fixture's
// payload is quoted into the ledger on purpose (see src/injection.mjs for why), the dashboard
// renders the ledger, and therefore every ledger-derived string in it is escaped. The
// gtm-agent-evals dashboard lane took an XSS finding at the one interpolation someone exempted
// because its type said it was safe; the lesson taken here is that the rule has no exemptions.
//
// The escaping tests below drive the real exported renderer against the REAL hostile-suite run
// rather than a hand-built fixture, and each asserts in BOTH directions: the raw markup is
// absent, and the escaped form is present. The negative alone passes trivially if the field is
// dropped on the floor. The positive alone passes if the output is double-escaped into garbage.
// One named test per payload, so a failure names the thing that broke.
//
// See docs/M3-SPEC.md part 2.

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, buildDashboardView, renderDashboard } from '../src/dashboard.mjs';
import { executeFixtureRun } from '../src/runner.mjs';
import { pipeline } from '../src/config.mjs';

const run = await executeFixtureRun();
const entries = run.ledger.entries();
const view = buildDashboardView(entries);
const html = renderDashboard(view);

// --- escapeHtml ------------------------------------------------------------------------

test('escapeHtml covers the five characters that change how markup parses', () => {
  assert.equal(escapeHtml(`a & <b> "c" 'd'`), 'a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;');
});

test('escapeHtml replaces the ampersand first, so an emitted entity is not re-escaped', () => {
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml coerces, because a ledger is parsed JSON and its fields are whatever was on disk', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
});

// --- the view model --------------------------------------------------------------------

test('the view names the run it describes', () => {
  assert.equal(view.run_id, run.run_id);
  assert.equal(view.entry_count, entries.length);
});

test('the funnel lists the stages in the order the ledger shows them running', () => {
  const stages = view.funnel.map((row) => row.stage);
  const expected = pipeline.map((s) => s.name).filter((name) => stages.includes(name));
  assert.deepEqual(stages, expected);
});

test('the funnel counts agree with the seal the kernel wrote independently', () => {
  // The derivation this pins: the kernel appends a stage's supplementary entries first and its
  // single verdict entry last, so the verdict entry for a (lead, stage) pair is the LAST entry
  // with that pair. That is a derivation rather than a flag, so it gets checked against a number
  // the kernel computed for itself.
  const totals = view.funnel.reduce(
    (sum, row) => ({
      PASS: sum.PASS,
      NEEDS_HUMAN: sum.NEEDS_HUMAN + row.NEEDS_HUMAN,
      REFUSE: sum.REFUSE + row.REFUSE,
    }),
    { PASS: 0, NEEDS_HUMAN: 0, REFUSE: 0 },
  );
  assert.equal(totals.REFUSE, view.seal.summary.REFUSE);
  assert.equal(totals.NEEDS_HUMAN, view.seal.summary.NEEDS_HUMAN);

  const lastStage = view.funnel[view.funnel.length - 1];
  assert.equal(lastStage.PASS, view.seal.summary.PASS, 'the final stage passed exactly the leads the seal counted');
});

test('the funnel reports how many leads reached each stage, which is the shape of a funnel', () => {
  const reached = view.funnel.map((row) => row.reached);
  assert.deepEqual(reached, [...reached].sort((a, b) => b - a), 'reach never grows down the pipeline');
});

test('the refusal breakdown groups by reason code, commonest first', () => {
  assert.ok(view.refusals.length >= 7, 'the hostile suite produces a spread of codes');
  for (let i = 1; i < view.refusals.length; i += 1) {
    const [prev, row] = [view.refusals[i - 1], view.refusals[i]];
    assert.ok(prev.count > row.count || (prev.count === row.count && prev.code <= row.code));
  }
  const total = view.refusals.reduce((sum, row) => sum + row.count, 0);
  assert.equal(total, view.seal.summary.REFUSE);
});

test('every refusal row names the stage that emitted it', () => {
  for (const row of view.refusals) {
    assert.ok(typeof row.stage === 'string' && row.stage !== '');
  }
});

test('the gate stats split refusals by which part of the gate produced them', () => {
  assert.ok(view.gate.executions > 0);
  assert.equal(view.gate.passed + view.gate.refused, view.gate.executions);
  const parts = view.gate.parts.map((p) => p.part);
  assert.ok(parts.includes('prompt injection'));
  assert.ok(parts.includes('PII redaction'));
  assert.ok(parts.includes('LLM rubric'));
  assert.equal(view.gate.parts.reduce((sum, p) => sum + p.count, 0), view.gate.refused);
});

test('the decisions view carries every human actor entry with its draft hash and who decided', () => {
  assert.equal(view.decisions.length, 2, 'the demo corpus ships one approval and one rejection');
  for (const decision of view.decisions) {
    assert.match(decision.draft_hash, /^draft-[0-9a-f]{16}$/);
    assert.ok(['approve', 'reject'].includes(decision.decision));
    assert.equal(decision.by, 'dana.reviewer');
    assert.ok(typeof decision.at === 'string' && decision.at !== '');
  }
});

test('every lead in the ledger gets a trail, and the seal is not one of them', () => {
  const ledgerLeads = new Set(entries.map((e) => e.lead_id));
  ledgerLeads.delete('-');
  assert.deepEqual(new Set(view.leads.map((l) => l.lead_id)), ledgerLeads);
});

test('each lead trail ends in the outcome that lead actually reached', () => {
  for (const lead of view.leads) {
    const reported = run.report.leads.find((l) => l.lead_id === lead.lead_id);
    if (reported === undefined) continue; // a lead id that only refused ingest under a signal id
    assert.equal(lead.outcome.verdict, reported.final_status);
    assert.equal(lead.outcome.stage, reported.final_stage);
  }
});

test('the view carries the raw ledger, so the file a reader was handed contains the record', () => {
  assert.equal(view.raw, run.ledger.toJSONL());
});

// --- escaping, against the real hostile run ---------------------------------------------

test('ESCAPES a script tag from the injection fixture — this class of surface took an XSS finding once', () => {
  assert.ok(!html.includes('<script>'), 'the raw tag is absent');
  assert.ok(html.includes('&lt;script&gt;'), 'and the escaped form is present, so it was rendered rather than dropped');
});

test('ESCAPES a closing script tag, which is the breakout half of the same payload', () => {
  assert.ok(!html.includes('</script>'));
  assert.ok(html.includes('&lt;/script&gt;'));
});

test('ESCAPES an img tag carrying an error handler', () => {
  // Deliberately not a <script> payload. A naive filter that strips "<script>" would pass a
  // script-only test and leave this one live.
  assert.ok(!html.includes('<img src=x onerror=alert(9)>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(9)&gt;'));
});

test('ESCAPES an anchor tag pointing at an external host', () => {
  // The ledger stores the span through JSON.stringify, so the raw form carries literal
  // backslashes. Asserted against that exact form rather than against "<a href=", because the
  // page emits its own navigation anchors and a blanket ban would fail for the wrong reason.
  assert.ok(!html.includes('<a href=\\"https://evil.test'), 'the raw tag is absent');
  assert.ok(html.includes('&lt;a href='), 'and the escaped form is present');
  assert.ok(!/<a\b[^>]*evil\.test/i.test(html), 'no emitted anchor points at the injected host');
});

test('ESCAPES the injected text wherever it appears, not only in the first section that shows it', () => {
  // The payload reaches the ledger through two entries, enrich's flag and the gate's refusal,
  // and the dashboard shows both in the refusal breakdown and in the lead trail. One escaped
  // copy and one raw copy would still be an XSS.
  const rawOccurrences = html.split('<script').length - 1;
  assert.equal(rawOccurrences, 0, 'no occurrence anywhere in the document');
  assert.ok(html.split('&lt;script').length - 1 >= 2, 'the payload really does appear more than once');
});

test('the rendered document contains no script element at all', () => {
  // The strongest form of the lesson, and it is cheap here because the page needs no runtime
  // data: there is no JSON island, so there is no </script> breakout, no <!-- hazard, and no
  // U+2028 mismatch to get wrong. A page with no script tag cannot execute an injected one.
  assert.doesNotMatch(html, /<script\b/i);
});

// --- self-containment -------------------------------------------------------------------

// Every real tag the document emits. Escaped ledger content is `&lt;`, not `<`, so this only
// ever matches markup the renderer itself produced.
function emittedTags(document) {
  return [...document.matchAll(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    attributes: m[2],
  }));
}

test('the document emits only tags from a small, named vocabulary', () => {
  const allowed = new Set([
    'html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header', 'section', 'footer',
    'h1', 'h2', 'h3', 'p', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'details', 'summary', 'pre', 'code', 'ul', 'li', 'a', 'nav', 'br', 'hr', 'small',
  ]);
  const used = new Set(emittedTags(html).map((t) => t.name));
  assert.deepEqual([...used].filter((name) => !allowed.has(name)), []);
});

test('no emitted tag carries a src attribute, so nothing is fetched when the file opens', () => {
  const offenders = emittedTags(html).filter((t) => /\bsrc\s*=/i.test(t.attributes));
  assert.deepEqual(offenders, []);
});

test('every emitted href is a fragment inside this page, never an external address', () => {
  const hrefs = emittedTags(html)
    .map((t) => /\bhref\s*=\s*"([^"]*)"/i.exec(t.attributes))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(hrefs.length > 0, 'the page really does have internal navigation');
  for (const href of hrefs) assert.match(href, /^#/, `href ${href} stays inside the document`);
});

test('no emitted tag carries an inline event handler', () => {
  const offenders = emittedTags(html).filter((t) => /\bon[a-z]+\s*=/i.test(t.attributes));
  assert.deepEqual(offenders, []);
});

test('the stylesheet is inline and pulls nothing over the network', () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'the CSS is inline');
  assert.doesNotMatch(style[1], /@import/i);
  assert.doesNotMatch(style[1], /url\s*\(/i, 'no webfont, no background image, nothing to fetch');
});

test('no external stylesheet or font is linked', () => {
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@font-face/i);
});

// --- read-only ---------------------------------------------------------------------------

test('the dashboard offers no control that could mutate a decision', () => {
  // DESIGN.md Non-scope: "Dashboard is read-only over the ledger; approvals happen in the CLI
  // only." It does not simulate an approve control either. A disabled-looking button is worse
  // than no button, because it advertises a capability at the wrong surface and invites
  // somebody to wire it up.
  for (const tag of ['form', 'button', 'input', 'select', 'textarea']) {
    assert.doesNotMatch(html, new RegExp(`<${tag}\\b`, 'i'), `the document emits no <${tag}>`);
  }
});

test('the dashboard says out loud that deciding happens in the CLI', () => {
  assert.match(html, /signal-desk\.mjs approve/, 'it points at where a decision is actually made');
});

// --- what a reader gets -------------------------------------------------------------------

test('the document is a complete HTML page', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport"/i);
});

test('the page names the run, so a file on disk says which run it describes', () => {
  assert.ok(html.includes(run.run_id));
  assert.match(/<title>([^<]*)<\/title>/.exec(html)[1], /signal-desk/);
});

test('every lead id in the ledger appears in the page', () => {
  for (const leadId of new Set(entries.map((e) => e.lead_id))) {
    if (leadId === '-') continue;
    assert.ok(html.includes(leadId), `${leadId} is on the page`);
  }
});

test('every reason code in the ledger appears in the page', () => {
  for (const code of new Set(entries.flatMap((e) => e.reason_codes))) {
    assert.ok(html.includes(code), `${code} is on the page`);
  }
});

test('the page carries the raw ledger, escaped', () => {
  assert.match(html, /<pre[^>]*>/);
  assert.ok(html.includes(escapeHtml(entries[0].hash)));
});

test('rendering is deterministic: the same ledger produces the same bytes', () => {
  assert.equal(renderDashboard(buildDashboardView(entries)), html);
});

test('a ledger with no seal still renders rather than throwing', () => {
  // A dashboard is a debugging surface as much as a presentation one, and the run a reader
  // most wants to look at is the one that did not finish.
  const truncated = entries.slice(0, -1);
  const partial = renderDashboard(buildDashboardView(truncated));
  assert.match(partial, /^<!doctype html>/i);
  assert.match(partial, /no terminal seal|did not finish|incomplete/i);
});

test('an empty ledger renders a page that says so rather than an empty one', () => {
  const empty = renderDashboard(buildDashboardView([]));
  assert.match(empty, /^<!doctype html>/i);
  assert.match(empty, /no entries/i);
});
