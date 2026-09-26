/**
 * The dashboard — the app's only output, built for a phone first.
 *
 * **It contains no data.** It reads `data/index.json` to find the runs, then
 * fetches exactly one shard, `data/runs/<date>.jsonl`, and renders every company
 * in it. One issue, one fetch. An earlier version inlined the corpus into every
 * page, so each run committed a ~520 KB copy of records already on disk.
 *
 * The behaviour lives in `web/` as plain files — model.js (pure logic, shared
 * with tests and the media stage), app.js (the DOM) and style.css — inlined
 * here into one self-contained page, so an update can never serve a new page
 * with a stale script.
 *
 * `fetch` is blocked on `file://`, so the page has to be served: GitHub Pages
 * for the phone, `python3 -m http.server` at a desk. Opened directly, it
 * renders an error naming the fix.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const web = (name: string): string => readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8');

/**
 * The page holds a GitHub token, and renders text from SEC filings — which
 * anyone can write — and from the model. So only this exact script may run
 * (no inline handlers, no `javascript:` links), and the only thing it may talk
 * to besides its own data is the GitHub API. Images are the exception: every
 * company's pictures live on its own site.
 */
function contentSecurityPolicy(script: string): string {
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  return [
    "default-src 'self'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    'img-src https: data:',
    "connect-src 'self' https://api.github.com",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function renderDashboard(): string {
  // One module: model.js exports, app.js calls them. Export declarations are
  // legal in an inline module and simply go unused.
  const script = `\n${web('model.js')}\n${web('app.js')}\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(script)}">
<!-- The repo is public, but a list of who someone is tracking does not need to
     be search-indexed. -->
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Digest">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161615" media="(prefers-color-scheme: dark)">
<title>Startup digest</title>
<style>
${web('style.css')}</style>
</head>
<body>
<header class="topbar">
  <select id="run" aria-label="Issue"></select>
  <div class="seg" role="group" aria-label="View">
    <button type="button" data-mode="deck" aria-pressed="true">Deck</button>
    <button type="button" data-mode="list" aria-pressed="false">List</button>
  </div>
  <button type="button" class="sync off" id="sync" title="Where grades are saved"><span class="dot"></span><span class="txt">Not synced</span></button>
</header>
<div class="progress" id="progress"></div>

<main>
  <section class="deck" id="deck" hidden aria-label="Companies, one per slide"></section>

  <section class="list-view" id="listView">
    <div class="sub" id="sub">Loading…</div>
    <div class="controls" hidden id="controls">
      <input type="search" id="q" placeholder="Search name, description, roles…" autocomplete="off">
      <label>Min fit <select id="minScore">
        <option value="0" selected>any</option><option value="50">50+</option>
        <option value="70">70+</option><option value="85">85+</option>
      </select></label>
      <label><input type="checkbox" id="hiringOnly"> hiring only</label>
      <label><input type="checkbox" id="operatingOnly" checked> real companies only</label>
      <span class="count" id="count"></span>
      <span id="graded"></span>
    </div>
    <div id="list"></div>
    <div class="empty" id="empty" hidden>Nothing matches those filters.</div>
    <footer>
      Scores measure fit against <code>config/profile.yaml</code>, not company quality.<br>
      Every company found in a run is researched and scored, so a low score means the model
      looked and was unimpressed — not that nothing looked.<br>
      Unlinked claims are model-generated — verify before acting. Pictures come from each
      company’s own website. Sources: SEC EDGAR Form D + funding press.
    </footer>
  </section>
</main>

<nav class="actions" id="actions" hidden aria-label="Grade this company">
  <button type="button" id="actPass" aria-pressed="false">✕ Not interested</button>
  <span id="pos"></span>
  <button type="button" id="actSave" aria-pressed="false"><span class="star">☆</span> Save</button>
</nav>

<div class="sheet" id="sheet" hidden>
  <div class="sheet-panel" role="dialog" aria-modal="true">
    <button type="button" id="sheetClose" aria-label="Close">✕</button>
    <div class="sheet-body" id="sheetBody"></div>
  </div>
</div>

<script type="module">${script}</script>
</body>
</html>
`;
}
