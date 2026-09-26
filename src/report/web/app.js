/**
 * The dashboard: a swipeable deck on a phone, a searchable list on a desk,
 * and grades that save themselves to GitHub.
 *
 * html.ts inlines model.js ahead of this file in one module script, so the
 * functions called here without an import — toRow, gradeOf, mergeLabelFile and
 * the rest — are defined there.
 *
 * No inline handlers anywhere: the page's CSP allows only this script, which
 * is what keeps a GitHub token in localStorage safe from text in a filing.
 */

const $ = (id) => document.getElementById(id);

/** localStorage can be absent or throw (private mode, blocked storage). */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

const LABELS_KEY = 'sf-labels-v2';
const GITHUB_KEY = 'sf-github';
const MODE_KEY = 'sf-mode';

let INDEX = [];
let ENTRY = null;
let RUN_ID = 'unknown';
/** Every company in the issue, best first. */
let ROWS = [];
/** ROWS after the filters: what the deck and the list both show, in order. */
let VIEW = [];
let MODE = store.get(MODE_KEY, null) || 'deck';
/** Deck position: 0 is the cover, VIEW.length + 1 the closing slide. */
let SLIDE = 0;
/** Which views need rebuilding before they are next shown. */
let STALE = { deck: true, list: true };

let GITHUB = store.get(GITHUB_KEY, null) || {};
if (!GITHUB.repo) GITHUB.repo = repoFromLocation(location) || '';

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

/** Keyed by labelKey(runId, companyId). `synced` is false until GitHub has it. */
let LABELS = loadLabels();

function loadLabels() {
  const v2 = store.get(LABELS_KEY, null);
  if (v2) return v2;
  // v1 was keyed by company alone, with the issue inside each entry.
  const out = {};
  for (const [id, l] of Object.entries(store.get('sf-labels-v1', {}) || {})) {
    if (!l || !l.runId) continue;
    out[labelKey(l.runId, id)] = {
      companyId: id, runId: l.runId, opened: !!l.opened, saved: !!l.saved, passed: !!l.passed,
      rank: l.rank ?? null, at: l.at, synced: false,
    };
  }
  return out;
}

const saveLabels = () => store.set(LABELS_KEY, LABELS);
const labelFor = (id) => LABELS[labelKey(RUN_ID, id)] || {};

/** Where the row sat in the deck and the list when it was judged. */
const rankOf = (id) => {
  const i = VIEW.findIndex((r) => r.id === id);
  return i < 0 ? null : i + 1;
};

function mark(id, patch) {
  const key = labelKey(RUN_ID, id);
  const prev = LABELS[key] || { companyId: id, runId: RUN_ID, opened: false, saved: false, passed: false, rank: null };
  // Fixed on the first label: a later filter or search would move the row, and
  // the position that matters is the one it had when the judgement was made.
  const rank = prev.rank ?? rankOf(id);
  LABELS[key] = { ...prev, ...patch, rank, at: new Date().toISOString(), synced: false };
  saveLabels();
  paint(id);
  updateCounts();
  Sync.soon();
}

/** save and "not interested" contradict each other, so one clears the other. */
function toggle(id, which) {
  const on = !labelFor(id)[which];
  mark(id, { saved: which === 'saved' ? on : false, passed: which === 'passed' ? on : false });
  return on;
}

/**
 * Fold in the grades already in the repo, so a new phone shows them. A local
 * change not yet saved is newer than anything upstream and wins.
 */
function absorb(text, authoritative) {
  const seen = new Set();
  for (const l of parseLabels(text)) {
    const key = labelKey(l.runId, l.companyId);
    seen.add(key);
    const local = LABELS[key];
    if (local && !local.synced) continue;
    LABELS[key] = {
      companyId: l.companyId, runId: l.runId, ...stateFromGrade(l.grade),
      rank: l.rank ?? null, at: l.at, synced: true,
    };
  }
  // Gone upstream (the skill cleaned it up, say) and not edited here: forget it.
  if (authoritative) {
    for (const [key, l] of Object.entries(LABELS)) if (l.synced && !seen.has(key)) delete LABELS[key];
  }
  saveLabels();
}

function issueCounts() {
  const mine = VIEW.map((r) => labelFor(r.id)).filter(isLabelled).map(gradeOf);
  const n = (g) => mine.filter((x) => x === g).length;
  return { judged: mine.length, saved: n(2), passed: n(0), opened: n(1) };
}

function updateCounts() {
  const c = issueCounts();
  // Rendered even at zero, so it does not appear from nowhere on the first click.
  $('graded').textContent = c.passed + ' not interested · ' + c.opened + ' opened · ' + c.saved + ' saved';
  const end = document.querySelector('.slide.end .tally');
  if (end) end.innerHTML = tallyHtml();
}

/** The Save-grades file, for the review-startups skill when there is no token. */
function exportLabels() {
  const labels = Object.values(LABELS)
    .map(toLabelLine)
    .filter(Boolean)
    .sort((a, b) => a.runId.localeCompare(b.runId) || (a.rank ?? 0) - (b.rank ?? 0));
  if (!labels.length) {
    alert('Nothing graded yet — save or dismiss a few companies first.');
    return;
  }
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), runId: RUN_ID, labels }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'labels.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Saving to GitHub
//
// Grades go to a `grades` branch and reach the default branch through a pull
// request the page opens and merges itself, one per sitting — the same
// branch-and-PR path as every other change here, and it works whether or not
// the default branch is protected. A grade counts as saved only once that PR
// exists; until then it stays queued on this device and survives a closed tab.
// ---------------------------------------------------------------------------

const GRADES_BRANCH = 'grades';
const LABELS_PATH = 'data/labels.jsonl';

const b64encode = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), (ch) => ch.charCodeAt(0)));

async function gh(method, path, body) {
  const res = await fetch('https://api.github.com/repos/' + GITHUB.repo + path, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GITHUB.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.message) || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

let REPO_INFO = null;
const repoInfo = async () => (REPO_INFO ??= await gh('GET', ''));

async function openPr() {
  const owner = GITHUB.repo.split('/')[0];
  const prs = await gh('GET', '/pulls?state=open&head=' + encodeURIComponent(owner + ':' + GRADES_BRANCH));
  return prs[0] || null;
}

async function readLabelsFile(ref) {
  try {
    const f = await gh('GET', '/contents/' + LABELS_PATH + '?ref=' + encodeURIComponent(ref));
    return { text: b64decode(f.content || ''), sha: f.sha };
  } catch (err) {
    if (err.status === 404) return { text: '', sha: null };
    throw err;
  }
}

/** A sitting starts its branch at the tip of the default branch. */
async function resetBranch(base) {
  const sha = (await gh('GET', '/git/ref/heads/' + encodeURIComponent(base))).object.sha;
  try {
    await gh('PATCH', '/git/refs/heads/' + GRADES_BRANCH, { sha, force: true });
  } catch (err) {
    if (err.status !== 422 && err.status !== 404) throw err;
    await gh('POST', '/git/refs', { ref: 'refs/heads/' + GRADES_BRANCH, sha });
  }
}

async function pushGrades() {
  const snapshot = Object.entries(LABELS)
    .filter(([, l]) => !l.synced)
    .map(([key, l]) => ({ key, at: l.at, line: toLabelLine(l) }));
  if (!snapshot.length) return;

  const base = (await repoInfo()).default_branch;
  const pr = await openPr();
  if (!pr) await resetBranch(base);

  let committed = false;
  for (let attempt = 1; ; attempt++) {
    const file = await readLabelsFile(GRADES_BRANCH);
    const text = mergeLabelFile(file.text, snapshot.map((s) => [s.key, s.line]));
    if (text === file.text) break;
    try {
      await gh('PUT', '/contents/' + LABELS_PATH, {
        message: describeChanges(snapshot.map((s) => s.line)),
        content: b64encode(text),
        branch: GRADES_BRANCH,
        ...(file.sha ? { sha: file.sha } : {}),
      });
      committed = true;
      break;
    } catch (err) {
      // 409: the file moved under us. Re-read and re-apply.
      if (err.status !== 409 || attempt >= 3) throw err;
    }
  }
  if (committed && !pr) {
    await gh('POST', '/pulls', {
      title: 'Grades from the startup digest',
      head: GRADES_BRANCH,
      base,
      body: 'Grades recorded in the digest page. The page merges this itself when the sitting ends.',
    });
  }

  // Only now: until the pull request exists, a reset would drop the commit.
  // A grade changed while this ran keeps its new `at` and goes next time.
  for (const s of snapshot) {
    const l = LABELS[s.key];
    if (!l || l.at !== s.at) continue;
    if (s.line) l.synced = true;
    else delete LABELS[s.key];
  }
  saveLabels();
}

async function publishGrades() {
  const pr = await openPr();
  if (!pr) return;
  const merge = (method) => gh('PUT', '/pulls/' + pr.number + '/merge', { merge_method: method, commit_title: pr.title + ' (#' + pr.number + ')' });
  try {
    await merge('squash');
  } catch (err) {
    if (err.status !== 405 || !/squash/i.test(err.message)) throw err;
    await merge('merge');
  }
  // The next sitting starts a fresh branch. Already gone if the repo deletes
  // merged branches itself.
  await gh('DELETE', '/git/refs/heads/' + GRADES_BRANCH).catch(() => {});
}

const Sync = {
  state: 'idle', // idle | busy | ok | error | auth
  note: '',
  timer: 0,
  since: 0,
  running: null,
  again: null,

  ready: () => !!(GITHUB.token && GITHUB.repo),
  pending: () => Object.values(LABELS).filter((l) => !l.synced).length,

  /** Quiet for 20s, or at most two minutes behind while grading steadily. */
  soon() {
    renderSync();
    if (!this.ready() || this.state === 'auth') return;
    const now = Date.now();
    if (!this.since) this.since = now;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), Math.min(20_000, Math.max(0, this.since + 120_000 - now)));
  },

  /** `publish` also merges the sitting's pull request. */
  async run({ publish = false } = {}) {
    if (!this.ready()) return;
    if (this.running) {
      this.again = { publish: publish || !!this.again?.publish };
      return;
    }
    clearTimeout(this.timer);
    this.since = 0;
    this.running = (async () => {
      try {
        if (this.pending()) {
          this.state = 'busy';
          renderSync();
          await pushGrades();
        }
        this.state = 'ok';
        this.note = '';
        if (publish) {
          try {
            await publishGrades();
          } catch (err) {
            if (err.status === 401) throw err;
            // Saved either way: the grades are in the open pull request.
            this.note = 'Saved in a pull request that could not be merged yet (' + err.message + '). It will be tried again.';
          }
        }
      } catch (err) {
        this.state = err.status === 401 || err.status === 403 || err.status === 404 ? 'auth' : 'error';
        this.note = err.message || String(err);
        if (this.state === 'error') this.timer = setTimeout(() => this.run(), 60_000);
      }
    })();
    await this.running;
    this.running = null;
    renderSync();
    if (this.again) {
      const next = this.again;
      this.again = null;
      await this.run(next);
    }
  },
};

function renderSync() {
  const btn = $('sync');
  const pending = Sync.pending();
  let text, cls;
  if (!Sync.ready()) [text, cls] = ['Not synced', 'off'];
  else if (Sync.state === 'auth') [text, cls] = ['Reconnect', 'bad'];
  else if (Sync.state === 'busy') [text, cls] = ['Saving…', 'busy'];
  else if (Sync.state === 'error') [text, cls] = ['Offline · ' + pending, 'warn'];
  else if (pending) [text, cls] = ['Saving soon · ' + pending, 'busy'];
  else [text, cls] = ['Saved', 'ok'];
  btn.className = 'sync ' + cls;
  btn.querySelector('.txt').textContent = text;
  for (const el of document.querySelectorAll('.sync-status')) el.textContent = statusLine();
}

function statusLine() {
  const pending = Sync.pending();
  if (!Sync.ready()) {
    return pending
      ? pending + ' grade' + (pending === 1 ? '' : 's') + ' kept on this device only.'
      : 'Grades are kept on this device only.';
  }
  if (Sync.state === 'auth') return 'GitHub refused the token: ' + Sync.note;
  if (Sync.state === 'error') return 'Could not reach GitHub (' + Sync.note + '). ' + pending + ' waiting; retrying.';
  if (Sync.note) return Sync.note;
  return pending ? pending + ' waiting to save.' : 'Every grade is saved to ' + GITHUB.repo + '.';
}

async function loadRemoteLabels() {
  try {
    if (Sync.ready()) {
      const pr = await openPr();
      const ref = pr ? GRADES_BRANCH : (await repoInfo()).default_branch;
      absorb((await readLabelsFile(ref)).text, true);
    } else {
      const res = await fetch('data/labels.jsonl', { cache: 'no-store' });
      if (res.ok) absorb(await res.text(), false);
    }
  } catch (err) {
    // Offline, or no grades yet: local ones still show.
    if (err.status === 401 || err.status === 403) {
      Sync.state = 'auth';
      Sync.note = err.message;
    }
  }
  for (const r of VIEW) paint(r.id);
  updateCounts();
  renderSync();
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * Walks an <img> down its candidate list. A load that is too small counts as a
 * failure: a 16px favicon is worse than a monogram, and the screenshot service
 * answers with a small placeholder while it renders.
 */
function onImage(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.srcs) return;
  const logo = img.classList.contains('logo');
  const shot = img.src.includes('/mshots/');
  if (e.type === 'load') {
    const min = logo ? 48 : shot ? 1000 : 200;
    if (img.naturalWidth >= min) {
      img.classList.add('ok');
      return;
    }
    // A screenshot still rendering: one more look before giving up on it.
    if (shot && !img.dataset.retried) {
      img.dataset.retried = '1';
      setTimeout(() => { img.src = img.src + '&retry=1'; }, 6000);
      return;
    }
  }
  const srcs = JSON.parse(img.dataset.srcs);
  const i = Number(img.dataset.i || 0) + 1;
  if (i < srcs.length) {
    img.dataset.i = String(i);
    img.src = srcs[i];
  } else {
    img.remove();
  }
}

function picture(srcs, cls, alt) {
  if (!srcs.length) return '';
  return '<img class="' + cls + '" src="' + esc(srcs[0]) + '" data-srcs="' + esc(JSON.stringify(srcs)) +
    '" alt="' + esc(alt) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
}

/** Monogram underneath, pictures on top: whatever fails, something shows. */
function logoHtml(r, cls = '') {
  return '<span class="logo-box ' + cls + '" style="--h:' + hueOf(r.id) + '" aria-hidden="true">' +
    '<span class="mono">' + esc(initials(r.name)) + '</span>' + picture(logoCandidates(r), 'logo', '') + '</span>';
}

function heroHtml(r) {
  // No homepage, nothing to show: a slide-sized monogram would be decoration.
  if (!heroCandidates(r).length) return '';
  const play = r.video
    ? '<a class="play" href="' + esc(r.video) + '" target="_blank" rel="noopener">▶ Watch video</a>'
    : '';
  return '<figure class="hero" style="--h:' + hueOf(r.id) + '">' +
    '<span class="hero-mono" aria-hidden="true">' + esc(initials(r.name)) + '</span>' +
    picture(heroCandidates(r), 'hero-img', 'From ' + r.name + '’s website') + play + '</figure>';
}

// ---------------------------------------------------------------------------
// Pieces shared by the deck and the list
// ---------------------------------------------------------------------------

const anchor = (l) => '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
// Filing links are provenance, not somewhere anyone clicks through to. Matched
// loosely because the label is model-written: "SEC Form D Filing", "SEC filing".
const isFiling = (l) => /^sec\b/i.test(l.label);

function list(items, title, cls = '') {
  if (!items || !items.length) return '';
  return '<h4>' + title + '</h4><ul class="' + cls + '">' + items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>';
}

function ring(r) {
  const c = 2 * Math.PI * 22;
  const frac = r.assessed ? Math.max(0, Math.min(100, r.score)) / 100 : 0;
  return '<svg class="ring' + (r.score >= 85 ? ' hot' : '') + '" viewBox="0 0 56 56" role="img" aria-label="Fit ' +
    (r.assessed ? r.score : 'unknown') + ' of 100">' +
    '<circle cx="28" cy="28" r="22" class="track"/>' +
    '<circle cx="28" cy="28" r="22" class="fill" stroke-dasharray="' + (c * frac).toFixed(1) + ' ' + c.toFixed(1) +
    '" transform="rotate(-90 28 28)"/>' +
    '<text x="28" y="33.5" text-anchor="middle">' + (r.assessed ? r.score : '—') + '</text></svg>';
}

function factsHtml(r) {
  const facts = [
    r.amount != null ? r.amountLabel + (r.round ? ' ' + r.round : '') : '',
    r.date ? shortDate(r.date) : '',
    r.location,
  ].filter(Boolean);
  const chips = facts.map((f) => '<span class="chip">' + esc(f) + '</span>');
  if (r.hiring > 0) chips.push('<span class="chip hiring">' + r.hiring + ' open role' + (r.hiring > 1 ? 's' : '') + '</span>');
  if (r.confidence) chips.push('<span class="chip">' + esc(r.confidence) + ' confidence</span>');
  // Rare, and it means ignore everything above it, so it is worth the colour.
  if (!r.operating) chips.push('<span class="chip warn">not an operating company</span>');
  return '<div class="chips">' + chips.join('') + '</div>';
}

function linksHtml(r) {
  const sources = r.sources.map((x) => ({ label: x.label === 'news' ? 'News source' : 'SEC filing', url: x.url, edgar: x.label === 'edgar' }));
  const own = [...r.links.filter((l) => !isFiling(l)), ...sources.filter((x) => !x.edgar)];
  return own.length ? '<div class="links">' + own.map(anchor).join('') + '</div>' : '';
}

/** Everything else research found — the Details panel and the deck's sheet. */
function detailHtml(r) {
  const filings = [...r.links.filter(isFiling), ...r.sources.filter((x) => x.label === 'edgar').map((x) => ({ label: 'EDGAR', url: x.url }))];
  const para = (title, text) => (text ? '<h4>' + title + '</h4><p>' + esc(text) + '</p>' : '');
  return para('Summary', r.summary) + (r.what !== r.oneLiner ? para('Product', r.what) : '') + para('Team', r.team) + para('Funding', r.funding) +
    list(r.roles, 'Open roles') + list(r.green, 'Reasons to look closer', 'good') +
    list(r.red, 'Reasons for caution', 'bad') +
    (r.competitors.length ? para('Competitors', r.competitors.join(', ')) : '') +
    (r.techStack.length ? para('Tech stack', r.techStack.join(', ')) : '') +
    list(r.people, 'On the SEC filing') +
    (filings.length ? '<h4>Filings</h4><p class="filings">' + filings.map(anchor).join(' · ') + '</p>' : '');
}

function shortDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function longDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

function histogram(bins) {
  const W = 320, H = 132, base = H - 20, top = 10;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const slot = W / bins.length;
  const bw = Math.min(24, slot - 6);
  const bars = bins.map((b, i) => {
    const h = (b.count / max) * (base - top);
    const x = i * slot + (slot - bw) / 2;
    const y = base - h;
    const rr = Math.min(4, h);
    const d = h <= 0 ? '' :
      'M' + x + ',' + base + 'V' + (y + rr) + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y +
      'H' + (x + bw - rr) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + rr) + 'V' + base + 'Z';
    const label = b.from + '–' + (b.from + 9 + (b.from === 90 ? 1 : 0)) + ': ' + b.count + ' compan' + (b.count === 1 ? 'y' : 'ies');
    // The hit area is the whole slot, taller than the bar, so a tap finds it.
    return '<g class="col"><title>' + label + '</title>' +
      '<rect class="hit" x="' + i * slot + '" y="0" width="' + slot + '" height="' + base + '"/>' +
      (d ? '<path class="bar' + (b.from >= 70 ? ' hi' : '') + '" d="' + d + '"/>' : '') +
      (b.from >= 70 && b.count ? '<text class="cap" x="' + (x + bw / 2) + '" y="' + (y - 4) + '" text-anchor="middle">' + b.count + '</text>' : '') +
      '</g>';
  }).join('');
  const tick = (v) => '<text class="tick" x="' + (v / 100) * W + '" y="' + (H - 4) + '" text-anchor="' +
    (v === 0 ? 'start' : v === 100 ? 'end' : 'middle') + '">' + v + '</text>';
  return '<svg class="hist" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Fit scores, in bands of ten">' +
    bars + '<line class="base" x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '"/>' +
    tick(0) + tick(50) + tick(70) + tick(100) + '</svg>';
}

function hbars(items) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return '<ul class="hbars">' + items.map((i) =>
    '<li><span class="lab">' + esc(i.label) + '</span><span class="row"><span class="track">' +
    '<span class="bar" style="width:' + ((i.count / max) * 100).toFixed(1) + '%"></span></span>' +
    '<span class="val">' + i.count + '</span></span></li>').join('') + '</ul>';
}

function coverHtml() {
  const s = issueStats(VIEW);
  const tile = (value, label) => '<div class="kpi"><div class="v">' + value + '</div><div class="l">' + label + '</div></div>';
  const filtered = VIEW.length < ROWS.length
    ? '<p class="note">Showing ' + VIEW.length + ' of ' + ROWS.length + ' — filters are on in the list view.</p>' : '';
  const best = s.best.map((r) =>
    '<button class="pick" type="button" data-jump="' + esc(r.id) + '">' + logoHtml(r, 'sm') +
    '<span class="pick-name">' + esc(r.name) + '<small>' + esc(r.oneLiner) + '</small></span>' +
    '<span class="pick-fit">' + r.score + '</span></button>').join('');
  return '<article class="slide cover"><div class="inner">' +
    '<div class="kicker">Startup digest</div>' +
    '<h1>' + esc(longDate(ENTRY.date)) + '</h1>' +
    '<p class="lede">' + s.companies + ' companies raised money. ' +
    (s.strong ? s.strong + ' fit you at 70 or better.' : 'None fit you at 70 or better.') + '</p>' + filtered +
    '<div class="kpis">' +
    tile(s.scored, 'researched') + tile(s.strong, 'fit 70+') + tile(s.hiring, 'hiring') +
    tile(s.medianRaise == null ? '—' : formatUsd(s.medianRaise), 'median raise') + '</div>' +
    (s.best.length ? '<h3>Top picks</h3><div class="picks">' + best + '</div>' : '') +
    '<figure class="chart"><figcaption>How well they fit you <span>70+ highlighted</span></figcaption>' + histogram(s.bins) + '</figure>' +
    (s.themes.length ? '<figure class="chart"><figcaption>What they work on</figcaption>' + hbars(s.themes) + '</figure>' : '') +
    (s.regions.length ? '<figure class="chart"><figcaption>Where they are</figcaption>' + hbars(s.regions) + '</figure>' : '') +
    '<button class="start" type="button" data-go="1">Start reviewing →</button>' +
    '<p class="hint">Swipe between companies. ★ saves, ✕ passes, and swiping on records nothing — so a company you skip stays ungraded, not rejected.</p>' +
    '</div></article>';
}

function slideHtml(r, i) {
  const l = labelFor(r.id);
  const green = r.green.slice(0, 2).map((g) => '<li>' + esc(g) + '</li>').join('');
  const red = r.red.slice(0, 2).map((g) => '<li>' + esc(g) + '</li>').join('');
  return '<article class="slide co' + stateClass(l) + '" data-id="' + esc(r.id) + '" aria-label="' + (i + 1) + ' of ' + VIEW.length + '">' +
    '<div class="inner">' + heroHtml(r) +
    '<div class="title">' + logoHtml(r) + '<h2>' + esc(r.name) + '</h2>' + ring(r) + '</div>' +
    '<div class="verdict" aria-live="polite">' + verdictText(l) + '</div>' +
    factsHtml(r) +
    // The one-sentence answer to "what is this"; the longer product text is
    // one tap away in the sheet.
    '<p class="lead">' + esc(r.oneLiner || r.what) + '</p>' +
    (r.interests.length ? '<div class="tags">' + r.interests.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
    (r.rationale ? '<h4>Why this score</h4><p>' + esc(r.rationale) + '</p>' : '') +
    (green || red ? '<div class="flags">' + (green ? '<ul class="good">' + green + '</ul>' : '') + (red ? '<ul class="bad">' + red + '</ul>' : '') + '</div>' : '') +
    linksHtml(r) +
    '<button class="more" type="button" data-more="' + esc(r.id) + '">Everything research found ›</button>' +
    '</div></article>';
}

function tallyHtml() {
  const c = issueCounts();
  return 'You judged <b>' + c.judged + '</b> of ' + VIEW.length + ': ' + c.saved + ' saved, ' +
    c.passed + ' not interested, ' + c.opened + ' opened.';
}

function endHtml() {
  const older = INDEX.find((e) => e.date < ENTRY.date);
  return '<article class="slide end"><div class="inner">' +
    '<h2>That’s the issue.</h2><p class="tally">' + tallyHtml() + '</p>' +
    '<p class="note sync-status">' + esc(statusLine()) + '</p>' +
    (Sync.ready() ? '' : '<button class="start ghost" type="button" data-settings>Save grades to GitHub…</button>') +
    '<button class="start" type="button" data-go="0">Back to the cover</button>' +
    (older ? '<button class="start ghost" type="button" data-issue="' + esc(older.date) + '">Previous issue: ' + esc(shortDate(older.date)) + ' →</button>' : '') +
    '</div></article>';
}

const stateClass = (l) => (l.saved ? ' saved' : l.passed ? ' passed' : '');
const verdictText = (l) => (l.saved ? '★ Saved' : l.passed ? '✕ Not interested' : l.opened ? 'Opened' : '');

function renderDeck() {
  const deck = $('deck');
  deck.innerHTML = coverHtml() + VIEW.map(slideHtml).join('') + endHtml();
  goTo(Math.min(SLIDE, VIEW.length + 1), false);
}

function goTo(i, smooth = true) {
  const deck = $('deck');
  arrive(Math.max(0, Math.min(i, VIEW.length + 1)));
  deck.scrollTo({ left: SLIDE * deck.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
}

function arrive(i) {
  const wasEnd = SLIDE === VIEW.length + 1;
  SLIDE = i;
  updateActions();
  // Reaching the end is the natural close of a sitting.
  if (MODE === 'deck' && VIEW.length && SLIDE === VIEW.length + 1 && !wasEnd) Sync.run({ publish: true });
}

function currentRow() {
  return SLIDE >= 1 && SLIDE <= VIEW.length ? VIEW[SLIDE - 1] : null;
}

function updateActions() {
  const r = currentRow();
  const bar = $('actions');
  bar.hidden = MODE !== 'deck' || !r;
  $('progress').style.width = VIEW.length ? (Math.min(SLIDE, VIEW.length) / VIEW.length) * 100 + '%' : '0';
  if (!r) return;
  const l = labelFor(r.id);
  $('pos').textContent = SLIDE + ' / ' + VIEW.length;
  $('actPass').setAttribute('aria-pressed', String(!!l.passed));
  $('actSave').setAttribute('aria-pressed', String(!!l.saved));
  $('actSave').querySelector('.star').textContent = l.saved ? '★' : '☆';
}

/** Grades from the deck's thumb bar; a verdict moves on to the next company. */
function actOnCurrent(which) {
  const r = currentRow();
  if (!r) return;
  if (!toggle(r.id, which)) return;
  // A verdict from inside the details sheet: the sheet would otherwise go on
  // showing this company over the next one.
  closeSheet();
  setTimeout(() => goTo(SLIDE + 1), 260);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function card(r) {
  const l = labelFor(r.id);
  const always =
    (r.summary && r.summary !== r.what ? '<h4>Summary</h4><p>' + esc(r.summary) + '</p>' : '') +
    (r.rationale ? '<h4>Why this score</h4><p>' + esc(r.rationale) + '</p>' : '');
  return '<div class="card' + (r.score >= 85 ? ' hot' : '') + stateClass(l) + (r.operating ? '' : ' dim') +
    '" data-id="' + esc(r.id) + '">' +
    '<div class="card-top">' + logoHtml(r, 'sm') +
    '<div class="card-title"><span class="name">' + esc(r.name) + '</span>' + factsHtml(r) + '</div>' +
    '<span class="score">' + (r.assessed ? r.score : '—') + '</span></div>' +
    (r.what ? '<p class="what">' + esc(r.what) + '</p>' : '') +
    '<div class="card-actions">' +
    '<button class="save" type="button" aria-pressed="' + !!l.saved + '"><span class="star">' + (l.saved ? '★' : '☆') + '</span> save</button>' +
    '<button class="pass" type="button" aria-pressed="' + !!l.passed + '"><span class="mark">' + (l.passed ? '●' : '○') + '</span> not interested</button>' +
    linksHtml(r) + '</div>' +
    always +
    '<details><summary>Details</summary><div class="detail">' + detailHtml(r) + '</div></details>' +
    '</div>';
}

function renderList() {
  $('list').innerHTML = VIEW.map(card).join('');
  $('empty').hidden = VIEW.length > 0;
}

/** Brings one company's buttons and classes back in line with LABELS. */
function paint(id) {
  const l = labelFor(id);
  const sel = '[data-id="' + CSS.escape(id) + '"]';
  for (const el of document.querySelectorAll('.card' + sel + ', .slide' + sel)) {
    el.classList.toggle('saved', !!l.saved);
    el.classList.toggle('passed', !!l.passed);
    const save = el.querySelector('.save');
    if (save) {
      save.setAttribute('aria-pressed', String(!!l.saved));
      save.querySelector('.star').textContent = l.saved ? '★' : '☆';
    }
    const pass = el.querySelector('.pass');
    if (pass) {
      pass.setAttribute('aria-pressed', String(!!l.passed));
      pass.querySelector('.mark').textContent = l.passed ? '●' : '○';
    }
    const verdict = el.querySelector('.verdict');
    if (verdict) verdict.textContent = verdictText(l);
  }
  if (currentRow()?.id === id) updateActions();
}

// ---------------------------------------------------------------------------
// Filters, modes, sheet
// ---------------------------------------------------------------------------

function applyFilters() {
  const q = $('q').value.toLowerCase().trim();
  const min = Number($('minScore').value);
  const hiringOnly = $('hiringOnly').checked;
  const operatingOnly = $('operatingOnly').checked;
  const keep = currentRow()?.id;

  VIEW = ROWS.filter((r) => {
    if (operatingOnly && !r.operating) return false;
    // An unassessed company has no score, not a score of -1. "any" has to mean
    // any, or research failures vanish from the one view meant to show them.
    if (min > 0 && (!r.assessed || r.score < min)) return false;
    if (hiringOnly && r.hiring === 0) return false;
    if (!q) return true;
    return (r.name + ' ' + r.what + ' ' + r.summary + ' ' + r.roles.join(' ') + ' ' + r.location)
      .toLowerCase().includes(q);
  });
  $('count').textContent = VIEW.length + ' of ' + ROWS.length;
  // Stay on the same company across a filter change when it survives it.
  const at = keep ? VIEW.findIndex((r) => r.id === keep) : -1;
  SLIDE = at >= 0 ? at + 1 : SLIDE && Math.min(SLIDE, VIEW.length + 1);
  // Only the view on screen is rebuilt; the other catches up when shown, so
  // typing a search does not rebuild sixty slides per keystroke.
  STALE = { deck: true, list: true };
  renderMode();
  updateCounts();
}

function renderMode() {
  if (!ENTRY || !STALE[MODE]) return; // nothing loaded yet
  STALE[MODE] = false;
  if (MODE === 'deck') renderDeck();
  else renderList();
}

function setMode(mode) {
  MODE = mode === 'list' ? 'list' : 'deck';
  store.set(MODE_KEY, MODE);
  document.body.classList.toggle('deck-mode', MODE === 'deck');
  $('deck').hidden = MODE !== 'deck';
  $('listView').hidden = MODE !== 'list';
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === MODE));
  renderMode();
  if (MODE === 'deck') goTo(SLIDE, false);
  updateActions();
}

function openSheet(html, onOpen) {
  $('sheetBody').innerHTML = html;
  $('sheet').hidden = false;
  document.body.classList.add('sheet-open');
  $('sheetBody').scrollTop = 0;
  if (onOpen) onOpen();
}

function closeSheet() {
  $('sheet').hidden = true;
  document.body.classList.remove('sheet-open');
}

function openDetails(id) {
  const r = ROWS.find((x) => x.id === id);
  if (!r) return;
  openSheet('<div class="sheet-head">' + logoHtml(r, 'sm') + '<h2>' + esc(r.name) + '</h2></div>' + detailHtml(r) + linksHtml(r));
  mark(id, { opened: true });
}

function openSettings() {
  const url = tokenSetupUrl(GITHUB.repo);
  openSheet(
    '<h2>Save grades to GitHub</h2>' +
    '<p class="note sync-status">' + esc(statusLine()) + '</p>' +
    (Sync.ready() ? '' :
      '<p>Grades are kept on this device until the page can save them to <code>' + esc(GITHUB.repo || 'your repo') +
      '</code>, where the review-startups skill and every later session read them. That takes a GitHub token, once per device.</p>' +
      '<ol class="steps"><li><a href="' + esc(url) + '" target="_blank" rel="noopener">Create a token on GitHub</a>. ' +
      'Everything is filled in except one thing: under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <b>' +
      esc((GITHUB.repo || '').split('/')[1] || 'this repo') + '</b>.</li>' +
      '<li>Press <b>Generate token</b>, copy it, and paste it below.</li></ol>' +
      '<p class="fine">It can only write to that one repository, and it stays on this device. On an iPhone, a home-screen icon keeps its own storage — paste the token there too if you use one.</p>') +
    '<label class="field">Token<input id="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"' +
    (GITHUB.token ? ' value="••••••••"' : '') + '></label>' +
    '<label class="field">Repository<input id="repoInput" type="text" autocomplete="off" spellcheck="false" value="' + esc(GITHUB.repo) + '"></label>' +
    '<div class="sheet-actions"><button class="start" type="button" id="tokenSave">' + (GITHUB.token ? 'Save now' : 'Connect') + '</button>' +
    (GITHUB.token ? '<button class="start ghost" type="button" id="tokenForget">Forget the token</button>' : '') + '</div>' +
    '<p class="note" id="tokenMsg" role="status"></p>' +
    '<h4>Without a token</h4><p>Download the grades as a file and hand it to the review-startups skill on your computer.</p>' +
    '<button class="start ghost" type="button" id="exportBtn">Download grades file</button>',
  );
}

async function connect() {
  const msg = $('tokenMsg');
  const token = $('tokenInput').value.trim();
  const repo = $('repoInput').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    msg.textContent = 'Repository should look like owner/name.';
    return;
  }
  const changed = token && !/^•+$/.test(token);
  const prev = GITHUB;
  GITHUB = { token: changed ? token : GITHUB.token, repo };
  REPO_INFO = null;
  if (!GITHUB.token) {
    GITHUB = prev;
    msg.textContent = 'Paste a token first.';
    return;
  }
  msg.textContent = 'Checking…';
  try {
    await repoInfo();
  } catch (err) {
    // A token GitHub refused must not be left in use.
    GITHUB = prev;
    REPO_INFO = null;
    msg.textContent = err.status === 404
      ? 'That token cannot see ' + repo + '. Check the repository is picked under Repository access.'
      : 'GitHub said: ' + err.message;
    return;
  }
  store.set(GITHUB_KEY, GITHUB);
  Sync.state = 'idle';
  msg.textContent = 'Connected. Saving…';
  await loadRemoteLabels();
  await Sync.run({ publish: true });
  msg.textContent = Sync.state === 'ok' ? 'Connected — grades now save by themselves.' : statusLine();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const jsonl = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
  return (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};

async function loadRun(entry) {
  ENTRY = entry;
  RUN_ID = entry.date;
  $('run').value = entry.date;
  ROWS = (await jsonl('data/runs/' + entry.date + '.jsonl')).map(toRow).sort(byFit);
  const assessed = ROWS.filter((r) => r.assessed);
  // Counted over assessed rows only: an unresearched company has not been
  // judged either way, so calling it "real" would overstate what is known.
  const notReal = assessed.filter((r) => !r.operating).length;
  $('sub').textContent =
    ROWS.length + ' companies found · ' + assessed.length + ' researched' +
    (notReal > 0 ? ' · ' + notReal + ' not real companies' : '') +
    (assessed.length < ROWS.length ? ' · ' + (ROWS.length - assessed.length) + ' not yet researched' : '') +
    (entry.costUsd > 0 ? ' · plan usage ~$' + entry.costUsd.toFixed(2) + '-equiv' : '');
  SLIDE = 0;
  applyFilters();
  const url = new URL(location.href);
  url.searchParams.set('run', entry.date);
  history.replaceState(null, '', url);
}

function wire() {
  ['q', 'minScore', 'hiringOnly', 'operatingOnly'].forEach((id) =>
    $(id).addEventListener(id === 'q' ? 'input' : 'change', applyFilters));

  $('run').addEventListener('change', () => {
    const next = INDEX.find((e) => e.date === $('run').value);
    if (next) loadRun(next);
  });

  for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('sync').addEventListener('click', openSettings);

  // One scroll position is one slide. Read once the scroll settles: mid-swipe
  // positions would flicker the thumb bar through every slide passed.
  let settle = 0;
  $('deck').addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const deck = $('deck');
      const i = Math.round(deck.scrollLeft / Math.max(1, deck.clientWidth));
      if (i !== SLIDE) arrive(i);
    }, 90);
  }, { passive: true });
  window.addEventListener('resize', () => goTo(SLIDE, false));

  $('actPass').addEventListener('click', () => actOnCurrent('passed'));
  $('actSave').addEventListener('click', () => actOnCurrent('saved'));

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go], [data-jump], [data-more], [data-issue], [data-settings], .card .save, .card .pass, #sheetClose, #sheet, #tokenSave, #tokenForget, #exportBtn');
    if (!t) return;
    if (t.id === 'sheet' && e.target !== t) return; // a click inside the panel, not the backdrop
    if (t.dataset.go) goTo(Number(t.dataset.go));
    else if (t.dataset.jump) goTo(VIEW.findIndex((r) => r.id === t.dataset.jump) + 1);
    else if (t.dataset.more) openDetails(t.dataset.more);
    else if (t.dataset.issue) {
      const next = INDEX.find((x) => x.date === t.dataset.issue);
      if (next) loadRun(next);
    } else if ('settings' in t.dataset) openSettings();
    else if (t.id === 'sheetClose' || t.id === 'sheet') closeSheet();
    else if (t.id === 'tokenSave') connect();
    else if (t.id === 'tokenForget') {
      GITHUB = { repo: GITHUB.repo };
      store.set(GITHUB_KEY, GITHUB);
      closeSheet();
      renderSync();
    } else if (t.id === 'exportBtn') exportLabels();
    else {
      const id = t.closest('.card').dataset.id;
      toggle(id, t.classList.contains('save') ? 'saved' : 'passed');
    }
  });

  // The toggle event does not bubble, so it has to be captured.
  $('list').addEventListener('toggle', (e) => {
    if (e.target.tagName !== 'DETAILS' || !e.target.open) return;
    mark(e.target.closest('.card').dataset.id, { opened: true });
  }, true);

  document.addEventListener('load', onImage, true);
  document.addEventListener('error', onImage, true);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') return closeSheet();
    // Enter on a focused button is that button's click, not "open details".
    if (e.key === 'Enter' && e.target.closest('button, a')) return;
    if (MODE !== 'deck' || !$('sheet').hidden) return;
    if (e.key === 'ArrowRight') goTo(SLIDE + 1);
    else if (e.key === 'ArrowLeft') goTo(SLIDE - 1);
    else if (e.key === 's') actOnCurrent('saved');
    else if (e.key === 'x') actOnCurrent('passed');
    else if (e.key === 'Enter' && currentRow()) openDetails(currentRow().id);
  });

  // Leaving the page ends a sitting. Best effort: a phone may freeze the tab
  // before this finishes, and then the next visit finishes it instead.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') Sync.run({ publish: true });
    else if (Sync.pending()) Sync.soon();
  });
}

async function main() {
  try {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('data/index.json -> HTTP ' + res.status);
    INDEX = await res.json();
  } catch (err) {
    $('sub').innerHTML = '<div class="fatal"><b>Could not load the run index.</b><br>' +
      esc(String(err)) + '<br><br>This page reads <code>data/</code> over HTTP, so it cannot ' +
      'run from <code>file://</code>. Serve the repo root and open it from there:<br>' +
      '<code>python3 -m http.server 8000</code></div>';
    return;
  }
  if (!INDEX.length) {
    $('sub').textContent = 'No runs yet. Run: pnpm sf run';
    return;
  }

  const wanted = new URLSearchParams(location.search).get('run');
  const entry = INDEX.find((e) => e.date === wanted) ?? INDEX[0];
  $('run').innerHTML = INDEX
    .map((e) => '<option value="' + esc(e.date) + '">' + esc(shortDate(e.date)) + '</option>')
    .join('');

  wire();
  setMode(MODE);
  await loadRun(entry);
  $('controls').hidden = false;
  renderSync();
  // Grades already in the repo first, then anything a closed tab left queued,
  // and the pull request a sitting left open.
  await loadRemoteLabels();
  if (Sync.ready()) Sync.run({ publish: true });
}

if (typeof document !== 'undefined') main();
