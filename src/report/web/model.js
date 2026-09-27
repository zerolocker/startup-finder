/**
 * The dashboard's pure logic — what a row says, what a grade is, how grades
 * merge into data/labels.jsonl, and the numbers behind the cover page.
 *
 * No DOM here. html.ts inlines this file ahead of app.js in one module script,
 * so app.js calls these directly; tests and the media stage import it as a
 * normal module. Plain JS because the browser runs it as written — there is no
 * build step.
 */

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const formatUsd = (a) =>
  a == null ? 'undisclosed'
  : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B'
  : a >= 1e6 ? '$' + (a / 1e6).toFixed(1) + 'M'
  : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'K'
  : '$' + a;

/** "SEATTLE, WA" -> "Seattle, WA". Leaves short tokens (state codes) alone. */
export const titleCase = (s) =>
  s.replace(/[A-Za-z]+/g, (w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));

/**
 * Only http(s) survives. Links are model-written and filings are attacker-
 * writable, and this page holds a GitHub token — a `javascript:` href is XSS.
 */
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** For images: an http one is blocked as mixed content on an https page. */
export function httpsUrl(u) {
  const s = safeUrl(u);
  return s ? s.replace(/^http:/, 'https:') : null;
}

const HOME_LABEL = /\b(home ?page|website|web ?site|company site|official site|site)\b/i;
const SAME_SITE_LABEL = /\b(about|careers?|jobs|docs|documentation|product|pricing|blog)\b/i;

/**
 * Hosts that are never the company's own site, however a link is labelled:
 * registries, press, social, job boards.
 */
const NOT_THE_COMPANY =
  /(^|\.)(sec\.gov|linkedin\.com|crunchbase\.com|pitchbook\.com|tracxn\.com|dealroom\.co|cbinsights\.com|theorg\.com|wikipedia\.org|github\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|substack\.com|techcrunch\.com|prnewswire\.com|businesswire\.com|globenewswire\.com|finsmes\.com|tech\.eu|eu-startups\.com|ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|myworkdayjobs\.com|wellfound\.com|ycombinator\.com|bamboohr\.com|rippling\.com|google\.com|apple\.com|notion\.site)$/i;

/**
 * The company's own homepage, or null.
 *
 * Null when the model was unsure who the company is: a picture from the wrong
 * company's site is worse than no picture (CLAUDE.md, rule 1).
 */
export function pickHomepage(assessment) {
  if (!assessment || !assessment.isOperatingCompany || assessment.confidence === 'low') return null;
  const links = (assessment.links || [])
    .map((l) => ({ label: String(l.label || ''), url: safeUrl(l.url) }))
    .filter((l) => l.url && !NOT_THE_COMPANY.test(new URL(l.url).hostname));

  const home = links.find((l) => HOME_LABEL.test(l.label));
  if (home) return home.url;
  // A careers or docs page on the company's own domain gives the domain.
  const sameSite = links.find((l) => SAME_SITE_LABEL.test(l.label));
  return sameSite ? new URL(sameSite.url).origin + '/' : null;
}

export function toRow(c) {
  const a = c.assessment;
  const m = c.media;
  // `media` is absent on issues written before the media stage existed; the
  // homepage still gives a screenshot and a favicon.
  const homepage = m ? m.homepage : m === null ? null : pickHomepage(a);
  return {
    id: c.id,
    name: c.name,
    // -1 sorts unassessed companies to the bottom without hiding them. A null
    // assessment means research failed, which is a defect worth seeing.
    score: a ? Math.round(a.fit) : -1,
    assessed: !!a,
    operating: a ? a.isOperatingCompany : true,
    what: a ? (a.product || a.whatTheyDo) : 'Not assessed — research failed for this company.',
    oneLiner: a ? a.whatTheyDo : '',
    amount: c.latestFunding?.amountUsd ?? null,
    amountLabel: formatUsd(c.latestFunding?.amountUsd ?? null),
    round: c.latestFunding?.round ?? null,
    date: c.latestFunding?.date || '',
    // The researched HQ beats the filing address, which is often the filing
    // agent's or the state of incorporation rather than where anyone works.
    // EDGAR shouts its cities ("SEATTLE, WA"), so the fallback gets cased down.
    location: a?.headquarters?.trim() || titleCase(c.location || ''),
    confidence: a?.confidence || '',
    hiring: a ? a.openRoles.length : 0,
    roles: a?.openRoles ?? [],
    summary: a?.summary ?? '',
    team: a?.team ?? '',
    funding: a?.funding ?? '',
    interests: a?.matchedInterests ?? [],
    competitors: a?.competitors ?? [],
    techStack: a?.techStack ?? [],
    green: a?.greenFlags ?? [],
    red: [...(a?.redFlags ?? []), ...(a?.concerns ?? [])],
    links: (a?.links ?? []).map((l) => ({ label: l.label, url: safeUrl(l.url) })).filter((l) => l.url),
    sources: c.sources.map((s) => ({ label: s.kind, url: safeUrl(s.url) })).filter((s) => s.url),
    people: c.people.slice(0, 6).map((p) =>
      p.name + (p.relationships.length ? ' (' + p.relationships.join(', ') + ')' : '')),
    rationale: a?.rationale ?? '',
    homepage,
    image: m ? httpsUrl(m.image) : null,
    logo: m ? httpsUrl(m.logo) : null,
    video: m ? safeUrl(m.video) : null,
  };
}

/** Highest fit first; the id breaks ties so every device ranks alike. */
export const byFit = (a, b) => b.score - a.score || a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

export function youtubeId(url) {
  const m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * A live render of the homepage, from WordPress's free screenshot service. The
 * media stage requests each one once so it is rendered before anyone looks.
 */
export const screenshotUrl = (homepage) =>
  'https://s0.wp.com/mshots/v1/' + encodeURIComponent(homepage) + '?w=1200&h=750';

export const faviconUrl = (homepage) =>
  'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(new URL(homepage).hostname);

/**
 * Pictures for a row, best first: the image the company chose, its demo
 * video's thumbnail, then a screenshot of its homepage. The page falls through
 * the list as each fails to load, and ends on a monogram.
 */
export function heroCandidates(r) {
  const out = [];
  if (r.image) out.push(r.image);
  const yt = youtubeId(r.video);
  if (yt) out.push('https://i.ytimg.com/vi/' + yt + '/hqdefault.jpg');
  if (r.homepage) out.push(screenshotUrl(r.homepage));
  return out;
}

export function logoCandidates(r) {
  const out = [];
  if (r.logo) out.push(r.logo);
  if (r.homepage) out.push(faviconUrl(r.homepage));
  return out;
}

/** A stable hue per company, so its monogram looks the same everywhere. */
export function hueOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function initials(name) {
  const words = String(name)
    .replace(/\b(inc|llc|ltd|corp|co|pbc|the)\b\.?/gi, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

// ---------------------------------------------------------------------------
// Grades — 0 = not interested, 1 = opened, 2 = saved.
//
// Every grade is a click. Swiping or scrolling past a company says nothing and
// records nothing: it cannot tell "read it and moved on" from "eyes glazed
// over it". A company nobody judged is absent rather than a 0 — filling those
// in would teach an eval that whatever the ranker buried deserved burying, a
// bias that is invisible and self-confirming.
//
// save and "not interested" clear each other. Opening the details implies a 1,
// and "not interested" overrides it: it is the verdict of someone who read it.
// ---------------------------------------------------------------------------

export const gradeOf = (l) => (l.saved ? 2 : l.passed ? 0 : l.opened ? 1 : 0);

/** True once the company carries a judgement. Nothing else is exportable. */
export const isLabelled = (l) => !!(l.saved || l.passed || l.opened);

/** One label per company per issue: a company graded in two issues is drift. */
export const labelKey = (runId, companyId) => runId + '/' + companyId;

export const stateFromGrade = (g) => ({ saved: g === 2, passed: g === 0, opened: g === 1 });

/** The data/labels.jsonl line for a local label, or null to delete it. */
export function toLabelLine(l) {
  if (!isLabelled(l)) return null;
  return { companyId: l.companyId, grade: gradeOf(l), rank: l.rank, at: l.at, runId: l.runId };
}

export function parseLabels(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw);
      if (l && typeof l.companyId === 'string' && typeof l.runId === 'string') out.push(l);
    } catch {
      // A hand-edited line that no longer parses is left for a human to see.
    }
  }
  return out;
}

/**
 * Apply local changes to the text of data/labels.jsonl.
 *
 * `changes` maps labelKey -> a label line, or null to remove one (a save
 * toggled back off). Untouched lines keep their exact text and position, so
 * git shows what changed rather than a rewrite.
 */
export function mergeLabelFile(text, changes) {
  const pending = new Map(changes);
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let key = null;
    try {
      const l = JSON.parse(raw);
      key = labelKey(l.runId, l.companyId);
    } catch {
      // kept verbatim below
    }
    if (key === null || !pending.has(key)) {
      out.push(raw);
      continue;
    }
    const line = pending.get(key);
    pending.delete(key);
    if (line) out.push(JSON.stringify(line));
  }
  for (const line of pending.values()) if (line) out.push(JSON.stringify(line));
  return out.length ? out.join('\n') + '\n' : '';
}

/** "2 saved, 5 not interested (2026-09-25)" — a commit title. */
export function describeChanges(lines) {
  const kept = lines.filter(Boolean);
  const n = (g) => kept.filter((l) => l.grade === g).length;
  const parts = [
    n(2) && n(2) + ' saved',
    n(0) && n(0) + ' not interested',
    n(1) && n(1) + ' opened',
    lines.length - kept.length && lines.length - kept.length + ' cleared',
  ].filter(Boolean);
  const runs = [...new Set(lines.filter(Boolean).map((l) => l.runId))].sort();
  return 'Grades: ' + (parts.join(', ') || 'no change') + (runs.length ? ' (' + runs.join(', ') + ')' : '');
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** "zerolocker/startup-finder" from https://zerolocker.github.io/startup-finder/. */
export function repoFromLocation(loc) {
  const host = /^([a-z0-9-]+)\.github\.io$/i.exec(loc.hostname || '');
  if (!host) return null;
  const first = (loc.pathname || '').split('/').filter(Boolean)[0];
  // A user site (owner.github.io itself) is served from the repo of that name.
  return host[1] + '/' + (first && !/\.html?$/.test(first) ? first : host[1] + '.github.io');
}

/**
 * GitHub pre-fills the fine-grained token form from these parameters. The
 * repository still has to be picked by hand — the URL cannot say which.
 */
export function tokenSetupUrl(repo) {
  const owner = String(repo || '').split('/')[0] || '';
  const q = new URLSearchParams({
    name: 'Startup digest grades',
    description: 'Lets the startup digest page save grades to ' + (repo || 'the repo'),
    target_name: owner,
    expires_in: '366',
    contents: 'write',
    pull_requests: 'write',
  });
  return 'https://github.com/settings/personal-access-tokens/new?' + q.toString();
}

// ---------------------------------------------------------------------------
// The cover page
// ---------------------------------------------------------------------------

/** "Palo Alto, CA" -> "CA"; "Berlin, Germany" -> "Germany". */
export function regionOf(location) {
  const parts = String(location || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const top = (counts, n) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([label, count]) => ({ label, count }));

/**
 * The numbers the cover page draws, over the rows the reader will actually
 * swipe through. Unassessed rows count as found but never as scored.
 */
export function issueStats(rows) {
  const scored = rows.filter((r) => r.assessed && r.operating);
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, count: 0 }));
  for (const r of scored) bins[Math.min(9, Math.floor(r.score / 10))].count++;

  const themes = new Map();
  const regions = new Map();
  for (const r of scored) {
    for (const t of r.interests) themes.set(t, (themes.get(t) || 0) + 1);
    const reg = regionOf(r.location);
    if (reg) regions.set(reg, (regions.get(reg) || 0) + 1);
  }
  // Form D amounts under $10K are placeholders ($1 is common), not rounds.
  const amounts = scored.map((r) => r.amount).filter((a) => a != null && a >= 1e4);

  return {
    companies: rows.length,
    scored: scored.length,
    strong: scored.filter((r) => r.score >= 70).length,
    hiring: scored.filter((r) => r.hiring > 0).length,
    medianRaise: median(amounts),
    raiseCount: amounts.length,
    bins,
    themes: top(themes, 5),
    regions: top(regions, 5),
    best: [...scored].sort(byFit).slice(0, 3),
  };
}
