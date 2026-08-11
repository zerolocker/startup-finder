/**
 * Self-contained HTML dashboard.
 *
 * Complements the Markdown digest: the digest is for reading once, the
 * dashboard is for coming back and filtering ("show me only >70 fit, in CA,
 * that are hiring"). It is a single file with inlined CSS/JS and no network
 * dependencies, so it works from `file://` and survives being emailed around.
 */

import type { ResearchedCompany } from '../types.ts';
import { effectiveScore } from '../pipeline/score.ts';
import { describeCompany } from './markdown.ts';
import { formatUsd } from '../util/text.ts';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize data for embedding inside a `<script>` block.
 *
 * A bare JSON.stringify is unsafe here: the string `</script>` appearing in any
 * value closes the script element and everything after it is parsed as HTML.
 * Company names come from SEC filings and RSS feeds — anyone can file a Form D
 * with a crafted entity name — so this is genuinely attacker-influencable input.
 *
 * Escaping `<` as `<` is the standard fix. It is still valid JSON and
 * parses back to the identical string, so the page sees the original text.
 */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface HtmlOptions {
  runId: string;
  windowDays: number;
  costUsd: number;
  totalCandidates: number;
}

/** Everything the client-side filter needs, as one JSON blob. */
interface Row {
  id: string;
  name: string;
  score: number;
  what: string;
  amount: number | null;
  amountLabel: string;
  date: string;
  location: string;
  confidence: string;
  hiring: number;
  roles: string[];
  summary: string;
  green: string[];
  red: string[];
  links: Array<{ label: string; url: string }>;
  sources: Array<{ label: string; url: string }>;
  people: string[];
  rationale: string;
}

export function renderDashboard(companies: readonly ResearchedCompany[], opts: HtmlOptions): string {
  const rows: Row[] = [...companies]
    .sort((a, b) => effectiveScore(b) - effectiveScore(a))
    .map((c) => ({
      id: c.id,
      name: c.name,
      score: Math.round(effectiveScore(c)),
      what: describeCompany(c),
      amount: c.latestFunding?.amountUsd ?? null,
      amountLabel: formatUsd(c.latestFunding?.amountUsd ?? null),
      date: c.latestFunding?.date ?? '',
      location: c.location ?? '',
      confidence: c.llm?.confidence ?? '',
      hiring: c.dossier?.openRoles.length ?? 0,
      roles: c.dossier?.openRoles ?? [],
      summary: c.dossier?.summary ?? '',
      green: c.dossier?.greenFlags ?? [],
      red: [...(c.dossier?.redFlags ?? []), ...(c.llm?.concerns ?? [])],
      links: c.dossier?.links ?? [],
      sources: c.sources.map((s) => ({ label: s.kind, url: s.url })),
      people: c.people.slice(0, 6).map((p) => `${p.name}${p.relationships.length ? ` (${p.relationships.join(', ')})` : ''}`),
      rationale: c.llm?.rationale ?? '',
    }));

  const generated = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Startup digest — ${generated.slice(0, 10)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --text: #1a1a19; --muted: #6b6b68;
    --line: #e5e4e1; --accent: #b4501e; --hot: #c2410c; --good: #15803d;
    --shadow: 0 1px 2px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191918; --panel: #222221; --text: #ededec; --muted: #a1a09b;
      --line: #35352f; --accent: #e8845c; --hot: #f97316; --good: #4ade80;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 12px rgba(0,0,0,.2);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--text);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.7rem; margin: 0 0 .35rem; letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: .9rem; margin-bottom: 1.5rem; }
  .controls {
    display: flex; flex-wrap: wrap; gap: .6rem; align-items: center;
    padding: .85rem; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; margin-bottom: 1.25rem; box-shadow: var(--shadow);
    position: sticky; top: .5rem; z-index: 10;
  }
  input[type=search], select {
    font: inherit; padding: .4rem .6rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--text);
  }
  input[type=search] { flex: 1 1 200px; min-width: 0; }
  label { font-size: .85rem; color: var(--muted); display: flex; align-items: center; gap: .35rem; }
  .count { margin-left: auto; font-size: .85rem; color: var(--muted); white-space: nowrap; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 1rem 1.15rem; margin-bottom: .75rem; box-shadow: var(--shadow);
  }
  .card.hot { border-left: 3px solid var(--hot); }
  .head { display: flex; align-items: baseline; gap: .7rem; flex-wrap: wrap; }
  .score {
    font-weight: 700; font-variant-numeric: tabular-nums; font-size: 1.15rem;
    min-width: 2.2rem; color: var(--accent);
  }
  .name { font-weight: 650; font-size: 1.05rem; }
  .meta { color: var(--muted); font-size: .85rem; margin-left: auto; text-align: right; }
  .what { margin: .5rem 0 0; }
  .tags { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .6rem; }
  .tag {
    font-size: .75rem; padding: .15rem .5rem; border-radius: 20px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .tag.hiring { color: var(--good); border-color: currentColor; }
  details { margin-top: .7rem; }
  summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
  summary:hover { color: var(--text); }
  .detail { padding-top: .6rem; font-size: .92rem; }
  .detail h4 { margin: .8rem 0 .25rem; font-size: .8rem; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  .detail ul { margin: .2rem 0; padding-left: 1.1rem; }
  a { color: var(--accent); }
  .empty { text-align: center; color: var(--muted); padding: 3rem 1rem; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .8rem; text-align: center; }

  /* Grading. Only "saved" needs a click: "seen" comes from the scroll observer
     and "opened" from the <details> toggle, so a normal read-through produces
     labels without the user grading 300 companies by hand. */
  .save {
    font: inherit; font-size: .78rem; cursor: pointer; margin-left: .5rem;
    padding: .12rem .5rem; border-radius: 20px; background: transparent;
    border: 1px solid var(--line); color: var(--muted);
  }
  .save:hover { color: var(--text); }
  .save[aria-pressed=true] { color: var(--good); border-color: currentColor; font-weight: 600; }
  .card.saved { border-left: 3px solid var(--good); }
  #save { font: inherit; font-size: .85rem; padding: .4rem .7rem; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
  #save:hover { border-color: var(--accent); color: var(--accent); }
  #graded { font-size: .85rem; color: var(--muted); white-space: nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Startup digest</h1>
  <div class="sub">
    Last ${opts.windowDays} days · ${opts.totalCandidates} candidates screened · ${rows.length} ranked${
      // Omit rather than print "$0.00", which reads as "this was free".
      opts.costUsd > 0 ? ` · LLM cost $${opts.costUsd.toFixed(2)}` : ''
    } · generated ${generated.slice(0, 16).replace('T', ' ')} UTC
  </div>

  <div class="controls">
    <input type="search" id="q" placeholder="Search name, description, roles…" autocomplete="off">
    <label>Min fit <select id="minScore">
      <option value="0">any</option><option value="50">50+</option>
      <option value="70" selected>70+</option><option value="85">85+</option>
    </select></label>
    <label><input type="checkbox" id="hiringOnly"> hiring only</label>
    <label>Sort <select id="sort">
      <option value="score">fit</option><option value="amount">raise</option><option value="date">date</option>
    </select></label>
    <span class="count" id="count"></span>
    <span id="graded"></span>
    <button id="save" type="button" title="Export grades for the review-startups skill">Save grades</button>
  </div>

  <div id="list"></div>
  <div class="empty" id="empty" hidden>Nothing matches those filters.</div>

  <footer>
    Scores measure fit against <code>config/profile.yaml</code>, not company quality.<br>
    Scores below ~30 are ambiguous: either the model judged the company poorly, or nothing ever
    screened it. Only screened rows carry a confidence badge and a "why this score".<br>
    Unlinked claims are model-generated — verify before acting. Sources: SEC EDGAR Form D + funding press.<br>
    <a href="../docs/READING_THE_REPORT.md">How to read this report</a>
  </footer>
</div>

<script>
const ROWS = ${toScriptJson(rows)};
const RUN_ID = ${toScriptJson(opts.runId)};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/**
 * Grades for the review-startups skill. 0 = ignored, 1 = opened, 2 = saved.
 *
 * Only "saved" is a deliberate click. "opened" is the <details> toggle and
 * "seen" is the scroll observer below, so reading the digest normally already
 * produces most of the signal.
 *
 * A company is exported ONLY once it has been seen. That distinction is the
 * whole point: "ignored" has to mean "looked at it and moved on", never "was
 * filtered out" or "never scrolled that far". Treating an unexamined company
 * as a 0 would teach any future eval that whatever the ranker already buried
 * deserved to be buried — the bias would be invisible and self-confirming.
 *
 * The rank field records the on-screen position at the moment it was seen, so
 * a later eval can cut off at the point attention realistically ran out rather
 * than trusting 300 rows equally.
 */
const LABELS_KEY = 'sf-labels-v1';
let LABELS = {};
try { LABELS = JSON.parse(localStorage.getItem(LABELS_KEY)) || {}; } catch (e) { LABELS = {}; }

const gradeOf = (l) => (l.saved ? 2 : l.opened ? 1 : 0);

function mark(id, patch) {
  const prev = LABELS[id] || { seen: false, opened: false, saved: false, rank: null };
  LABELS[id] = { ...prev, ...patch, at: new Date().toISOString(), runId: RUN_ID };
  try { localStorage.setItem(LABELS_KEY, JSON.stringify(LABELS)); } catch (e) {}
  updateGradedCount();
}

function updateGradedCount() {
  const seen = Object.values(LABELS).filter((l) => l.seen);
  const saved = seen.filter((l) => l.saved).length;
  const opened = seen.filter((l) => l.opened && !l.saved).length;
  $('graded').textContent = seen.length
    ? seen.length + ' seen · ' + opened + ' opened · ' + saved + ' saved'
    : '';
}

// A card counts as seen once it has been at least half visible for a full
// second — long enough to exclude rows that merely flew past during a fast
// scroll to the bottom.
const timers = new Map();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id;
    if (e.isIntersecting) {
      if (!timers.has(id)) {
        timers.set(id, setTimeout(() => {
          const rank = [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === id);
          if (!(LABELS[id] || {}).seen) mark(id, { seen: true, rank: rank + 1 });
          timers.delete(id);
        }, 1000));
      }
    } else {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
  }
}, { threshold: 0.5 });

function exportLabels() {
  const out = Object.entries(LABELS)
    .filter(([, l]) => l.seen)
    .map(([companyId, l]) => ({ companyId, grade: gradeOf(l), rank: l.rank, at: l.at, runId: l.runId }))
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (!out.length) { alert('Nothing graded yet — scroll through some companies first.'); return; }
  return JSON.stringify({ exportedAt: new Date().toISOString(), runId: RUN_ID, labels: out }, null, 2);
}

async function saveLabels() {
  const json = exportLabels();
  if (!json) return;
  // Chrome can write straight to disk, which keeps the file where the skill
  // expects it. Everything else falls back to an ordinary download.
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'labels.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(json);
      await w.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled — not a failure
    }
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'labels.json';
  a.click();
  URL.revokeObjectURL(url);
}

function list(items, title) {
  if (!items || !items.length) return '';
  return '<h4>' + title + '</h4><ul>' + items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>';
}

function card(r) {
  const links = [...r.links, ...r.sources.map((s) => ({ label: 'SEC/news: ' + s.label, url: s.url }))]
    .map((l) => '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>')
    .join(' · ');

  const tags = [];
  if (r.hiring > 0) tags.push('<span class="tag hiring">' + r.hiring + ' open role' + (r.hiring > 1 ? 's' : '') + '</span>');
  if (r.confidence) tags.push('<span class="tag">' + esc(r.confidence) + ' confidence</span>');
  if (r.location) tags.push('<span class="tag">' + esc(r.location) + '</span>');

  const detail = list(r.roles, 'Open roles') + list(r.green, 'Reasons to look closer') +
    list(r.red, 'Reasons for caution') + list(r.people, 'On the SEC filing') +
    (r.rationale ? '<h4>Why this score</h4><p>' + esc(r.rationale) + '</p>' : '') +
    (r.summary && r.summary !== r.what ? '<h4>Summary</h4><p>' + esc(r.summary) + '</p>' : '') +
    (links ? '<h4>Links</h4><p>' + links + '</p>' : '');

  const saved = (LABELS[r.id] || {}).saved === true;

  return '<div class="card' + (r.score >= 85 ? ' hot' : '') + (saved ? ' saved' : '') +
    '" data-id="' + esc(r.id) + '">' +
    '<div class="head"><span class="score">' + r.score + '</span>' +
    '<span class="name">' + esc(r.name) + '</span>' +
    '<button class="save" type="button" aria-pressed="' + saved + '">' +
      (saved ? '★ saved' : '☆ save') + '</button>' +
    '<span class="meta">' + esc(r.amountLabel) + (r.date ? ' · ' + esc(r.date) : '') + '</span></div>' +
    (r.what ? '<p class="what">' + esc(r.what) + '</p>' : '') +
    (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') +
    (detail ? '<details><summary>Details</summary><div class="detail">' + detail + '</div></details>' : '') +
    '</div>';
}

function render() {
  const q = $('q').value.toLowerCase().trim();
  const min = Number($('minScore').value);
  const hiringOnly = $('hiringOnly').checked;
  const sort = $('sort').value;

  let out = ROWS.filter((r) => {
    if (r.score < min) return false;
    if (hiringOnly && r.hiring === 0) return false;
    if (!q) return true;
    return (r.name + ' ' + r.what + ' ' + r.summary + ' ' + r.roles.join(' ') + ' ' + r.location)
      .toLowerCase().includes(q);
  });

  out.sort((a, b) =>
    sort === 'amount' ? (b.amount || 0) - (a.amount || 0)
    : sort === 'date' ? String(b.date).localeCompare(String(a.date))
    : b.score - a.score);

  $('list').innerHTML = out.map(card).join('');
  $('count').textContent = out.length + ' of ' + ROWS.length;
  $('empty').hidden = out.length > 0;

  // innerHTML replaced every node, so the old observations are gone with them.
  observer.disconnect();
  timers.clear();
  document.querySelectorAll('.card').forEach((c) => observer.observe(c));
}

['q', 'minScore', 'hiringOnly', 'sort'].forEach((id) =>
  $(id).addEventListener(id === 'q' ? 'input' : 'change', render));

$('list').addEventListener('click', (e) => {
  const btn = e.target.closest('.save');
  if (!btn) return;
  const cardEl = btn.closest('.card');
  const id = cardEl.dataset.id;
  const saved = !((LABELS[id] || {}).saved);
  // Saving implies having seen it, even if the observer has not fired yet.
  mark(id, { saved, seen: true });
  btn.setAttribute('aria-pressed', String(saved));
  btn.textContent = saved ? '★ saved' : '☆ save';
  cardEl.classList.toggle('saved', saved);
});

// The toggle event does not bubble, so it has to be captured.
$('list').addEventListener('toggle', (e) => {
  if (e.target.tagName !== 'DETAILS' || !e.target.open) return;
  const id = e.target.closest('.card').dataset.id;
  mark(id, { opened: true, seen: true });
}, true);

$('save').addEventListener('click', saveLabels);

render();
updateGradedCount();
</script>
</body>
</html>
`;
}
