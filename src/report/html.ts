/**
 * The dashboard — the app's only output.
 *
 * **It contains no data.** It reads `data/index.json` to find the runs, then
 * fetches exactly one shard, `data/runs/<date>.jsonl`, and renders every company
 * in it. One issue, one fetch.
 *
 * That is why runs are sharded. An earlier version inlined the whole cumulative
 * corpus into every dated HTML file, so each run committed a ~520 KB page that
 * was 97% a copy of records already on disk, and the page grew forever. This
 * shell is ~18 KB and changes only when this file does.
 *
 * The cost is that `fetch` is blocked on `file://`, so the page has to be
 * served. Opening it directly renders an error naming the fix.
 */

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- The repo is public, but a list of who someone is tracking does not need to
     be search-indexed. -->
<meta name="robots" content="noindex, nofollow">
<title>Startup digest</title>
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
  /* An explicit display wins over the UA stylesheet's [hidden] rule, so the
     controls bar stayed visible over its own error message without this. */
  [hidden] { display: none !important; }
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
  .card.dim { opacity: .55; }
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
  .tag.warn { color: var(--hot); border-color: currentColor; }
  details { margin-top: .7rem; }
  summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
  summary:hover { color: var(--text); }
  .detail { padding-top: .6rem; font-size: .92rem; }
  .detail h4 { margin: .8rem 0 .25rem; font-size: .8rem; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  .detail ul { margin: .2rem 0; padding-left: 1.1rem; }
  a { color: var(--accent); }
  .empty { text-align: center; color: var(--muted); padding: 3rem 1rem; }
  .fatal { border: 1px solid var(--hot); border-radius: 10px; padding: 1rem 1.15rem; }
  .fatal code { background: var(--bg); padding: .1rem .3rem; border-radius: 4px; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .8rem; text-align: center; }

  /* Grading. Only "saved" needs a click: "seen" comes from the scroll observer
     and "opened" from the <details> toggle, so a normal read-through produces
     labels without grading every company by hand. */
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
  <div class="sub" id="sub">Loading…</div>

  <div class="controls" hidden id="controls">
    <label>Issue <select id="run"></select></label>
    <input type="search" id="q" placeholder="Search name, description, roles…" autocomplete="off">
    <label>Min fit <select id="minScore">
      <option value="0" selected>any</option><option value="50">50+</option>
      <option value="70">70+</option><option value="85">85+</option>
    </select></label>
    <label><input type="checkbox" id="hiringOnly"> hiring only</label>
    <label><input type="checkbox" id="operatingOnly" checked> real companies only</label>
    <span class="count" id="count"></span>
    <span id="graded"></span>
    <button id="save" type="button" title="Export grades for the review-startups skill">Save grades</button>
  </div>

  <div id="list"></div>
  <div class="empty" id="empty" hidden>Nothing matches those filters.</div>

  <footer>
    Scores measure fit against <code>config/profile.yaml</code>, not company quality.<br>
    Every company found in a run is researched and scored, so a low score means the model
    looked and was unimpressed — not that nothing looked.<br>
    Unlinked claims are model-generated — verify before acting. Sources: SEC EDGAR Form D + funding press.<br>
    <a href="docs/ARCHITECTURE.md">How this works</a>
  </footer>
</div>

<script type="module">
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const formatUsd = (a) =>
  a == null ? 'undisclosed'
  : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B'
  : a >= 1e6 ? '$' + (a / 1e6).toFixed(1) + 'M'
  : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'K'
  : '$' + a;

let ROWS = [];
let RUN_ID = 'unknown';

function toRow(c) {
  const a = c.assessment;
  return {
    id: c.id,
    name: c.name,
    // -1 sorts unassessed companies to the bottom without hiding them. A null
    // assessment means research failed, which is a defect worth seeing.
    score: a ? Math.round(a.fit) : -1,
    assessed: !!a,
    operating: a ? a.isOperatingCompany : true,
    what: a ? (a.product || a.whatTheyDo) : 'Not assessed — research failed for this company.',
    amount: c.latestFunding?.amountUsd ?? null,
    amountLabel: formatUsd(c.latestFunding?.amountUsd ?? null),
    date: c.latestFunding?.date || '',
    location: c.location || '',
    confidence: a?.confidence || '',
    hiring: a ? a.openRoles.length : 0,
    roles: a?.openRoles ?? [],
    summary: a?.summary ?? '',
    green: a?.greenFlags ?? [],
    red: [...(a?.redFlags ?? []), ...(a?.concerns ?? [])],
    links: a?.links ?? [],
    sources: c.sources.map((s) => ({ label: s.kind, url: s.url })),
    people: c.people.slice(0, 6).map((p) =>
      p.name + (p.relationships.length ? ' (' + p.relationships.join(', ') + ')' : '')),
    rationale: a?.rationale ?? '',
  };
}

/**
 * Grades for the review-startups skill. 0 = ignored, 1 = opened, 2 = saved.
 *
 * A company is exported ONLY once it has been seen. That distinction is the
 * whole point: "ignored" has to mean "looked at it and moved on", never "never
 * scrolled that far". Treating an unexamined company as a 0 would teach any
 * future eval that whatever the ranker buried deserved to be buried — a bias
 * that is invisible and self-confirming.
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
// second — long enough to exclude rows that flew past during a fast scroll.
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
      if (e.name === 'AbortError') return; // cancelled, not failed
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
  if (!r.operating) tags.push('<span class="tag warn">not an operating company</span>');
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
    (r.operating ? '' : ' dim') + '" data-id="' + esc(r.id) + '">' +
    '<div class="head"><span class="score">' + (r.assessed ? r.score : '—') + '</span>' +
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
  const operatingOnly = $('operatingOnly').checked;

  const out = ROWS.filter((r) => {
    if (operatingOnly && !r.operating) return false;
    // An unassessed company has no score, not a score of -1. "any" has to mean
    // any, or research failures vanish from the one view meant to show them.
    if (min > 0 && (!r.assessed || r.score < min)) return false;
    if (hiringOnly && r.hiring === 0) return false;
    if (!q) return true;
    return (r.name + ' ' + r.what + ' ' + r.summary + ' ' + r.roles.join(' ') + ' ' + r.location)
      .toLowerCase().includes(q);
  });

  $('list').innerHTML = out.map(card).join('');
  $('count').textContent = out.length + ' of ' + ROWS.length;
  $('empty').hidden = out.length > 0;

  // innerHTML replaced every node, so the old observations went with them.
  observer.disconnect();
  timers.clear();
  document.querySelectorAll('.card').forEach((c) => observer.observe(c));
}

const jsonl = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
  return (await res.text()).split('\\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};

async function loadRun(entry) {
  RUN_ID = entry.date;
  ROWS = (await jsonl('data/runs/' + entry.date + '.jsonl')).map(toRow).sort((a, b) => b.score - a.score);
  const assessed = ROWS.filter((r) => r.assessed);
  // Counted over assessed rows only: an unresearched company has not been
  // judged either way, so calling it "real" would overstate what is known.
  const notReal = assessed.filter((r) => !r.operating).length;
  $('sub').textContent =
    entry.date + ' · ' + entry.windowDays + ' day of filings · ' +
    ROWS.length + ' companies found · ' + assessed.length + ' researched' +
    (notReal > 0 ? ' · ' + notReal + ' not real companies' : '') +
    (assessed.length < ROWS.length ? ' · ' + (ROWS.length - assessed.length) + ' not yet researched' : '') +
    (entry.costUsd > 0 ? ' · plan usage ~$' + entry.costUsd.toFixed(2) + '-equiv' : '');
  render();
}

async function main() {
  let index;
  try {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error('data/index.json -> HTTP ' + res.status);
    index = await res.json();
  } catch (err) {
    $('sub').innerHTML = '<div class="fatal"><b>Could not load the run index.</b><br>' +
      esc(String(err)) + '<br><br>This page reads <code>data/</code> over HTTP, so it cannot ' +
      'run from <code>file://</code>. Serve the repo root and open it from there:<br>' +
      '<code>python3 -m http.server 8000</code></div>';
    return;
  }

  if (!index.length) {
    $('sub').textContent = 'No runs yet. Run: pnpm sf run';
    return;
  }

  const wanted = new URLSearchParams(location.search).get('run');
  const entry = index.find((e) => e.date === wanted) ?? index[0];

  $('run').innerHTML = index
    .map((e) => '<option value="' + esc(e.date) + '"' + (e.date === entry.date ? ' selected' : '') +
      '>' + esc(e.date) + ' (' + e.companies + ')</option>')
    .join('');
  $('run').addEventListener('change', () => {
    const next = index.find((e) => e.date === $('run').value);
    if (next) loadRun(next);
  });

  ['q', 'minScore', 'hiringOnly', 'operatingOnly'].forEach((id) =>
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
    mark(e.target.closest('.card').dataset.id, { opened: true, seen: true });
  }, true);

  $('save').addEventListener('click', saveLabels);

  await loadRun(entry);
  $('controls').hidden = false;
  updateGradedCount();
}

main();
</script>
</body>
</html>
`;
}
