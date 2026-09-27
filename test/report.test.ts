import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/report/html.ts';

const html = renderDashboard();
const script = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.lastIndexOf('</script>'));
const css = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';

describe('renderDashboard', () => {
  it('is one self-contained file, so an update never pairs a new page with a stale script', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  // The point of the shell. Inlining the corpus made every run commit a ~520 KB
  // page that was 97% a copy of records already on disk. If this regresses,
  // repo growth quietly returns.
  it('carries no data, only the shell', () => {
    const shard = readFileSync(new URL('../data/runs/2026-09-25.jsonl', import.meta.url), 'utf8');
    const ids = shard.split('\n').filter(Boolean).map((l) => JSON.parse(l).id as string);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id) => html.includes(`"${id}"`))).toEqual([]);
    expect(html.length).toBeLessThan(120_000);
  });

  // One issue, one fetch — which is the whole reason runs are sharded.
  it('reads the run index and exactly one shard', () => {
    expect(script).toContain("fetch('data/index.json'");
    expect(script).toContain("'data/runs/' + entry.date + '.jsonl'");
  });

  it('lets you switch issues without reloading everything', () => {
    expect(html).toContain('id="run"');
    expect(script).toContain("URLSearchParams(location.search).get('run')");
  });

  it('asks search engines not to index it', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex/);
  });

  it('explains how to fix the file:// case rather than rendering blank', () => {
    expect(script).toContain('python3 -m http.server');
  });

  // A container with an explicit display outranks the UA stylesheet's [hidden]
  // rule — without this the controls sat on top of their own error message.
  it('can actually hide what it marks hidden', () => {
    expect(css).toMatch(/\[hidden\]\s*{\s*display:\s*none\s*!important/);
  });

  it('is laid out for a phone', () => {
    expect(html).toContain('viewport-fit=cover');
    expect(css).toContain('scroll-snap-type: x mandatory');
    expect(css).toContain('env(safe-area-inset-bottom');
  });
});

// The page keeps a GitHub token in localStorage and renders text from SEC
// filings, which anyone can write. These are what keep the two apart.
describe('renderDashboard — security', () => {
  it('lets only its own inline script run', () => {
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('can talk to nothing but its own data and the GitHub API', () => {
    expect(csp).toContain("connect-src 'self' https://api.github.com;");
    expect(csp).toContain("default-src 'self'");
  });

  // The CSP would block them anyway; this keeps a fallback from being written
  // as one and silently never firing.
  it('uses no inline event handlers', () => {
    expect(html).not.toMatch(/\son(error|load|click|change|input|toggle)=/i);
  });

  it('never renders a model-written URL without checking its scheme', () => {
    expect(script).toContain("url.protocol === 'https:' || url.protocol === 'http:'");
    expect(script).toMatch(/links: \(a\?\.links \?\? \[\]\)\.map\(\(l\) => \(\{ label: l\.label, url: safeUrl\(l\.url\) \}\)\)/);
  });
});

describe('renderDashboard — filtering', () => {
  // "any" excluded every unassessed company, because they carry -1 rather than
  // a score. That hid exactly the rows the dashboard exists to surface.
  it('treats "any" as any, including companies with no score yet', () => {
    expect(html).toMatch(/<option value="0" selected>any<\/option>/);
    expect(script).toContain('if (min > 0 && (!r.assessed || r.score < min)) return false;');
  });

  // An unresearched company has not been judged either way.
  it('counts "not real companies" over assessed rows only', () => {
    expect(script).toContain('assessed.filter((r) => !r.operating)');
  });

  // The deck and the list are one ordering, so a rank means the same in both.
  it('feeds the deck and the list from the same filtered list', () => {
    expect(script).toContain('VIEW = ROWS.filter(');
    expect(script).toContain("VIEW.map(slideHtml)");
    expect(script).toContain("VIEW.map(card)");
  });
});

describe('renderDashboard — grading', () => {
  // Scrolling is not evidence: it cannot tell "read it and moved on" from "eyes
  // glazed over it". Swiping the deck is the same, so it grades nothing either.
  it('infers nothing from scrolling or swiping', () => {
    expect(script).not.toContain('IntersectionObserver');
    const onScroll = script.slice(script.indexOf("$('deck').addEventListener('scroll'"), script.indexOf("window.addEventListener('resize'"));
    expect(onScroll).toContain('arrive(i)');
    expect(onScroll).not.toContain('mark(');
    const arrive = script.slice(script.indexOf('function arrive('), script.indexOf('function currentRow('));
    expect(arrive).not.toContain('mark(');
  });

  // A later filter or search moves the row, so the position is fixed on the
  // first label rather than recomputed.
  it('records rank on the click that labels the company', () => {
    expect(script).toContain('const rank = prev.rank ?? rankOf(id);');
    expect(script).toMatch(/const rankOf = \(id\) => \{/);
  });

  // Both on at once would export a grade that contradicts the other button.
  it('makes save and "not interested" clear each other', () => {
    expect(script).toContain("mark(id, { saved: which === 'saved' ? on : false, passed: which === 'passed' ? on : false });");
  });

  it('counts opening the details as opened, in the deck and the list', () => {
    const openDetails = script.slice(script.indexOf('function openDetails('), script.indexOf('function openSettings('));
    expect(openDetails).toContain('mark(id, { opened: true })');
    expect(script).toMatch(/addEventListener\('toggle'[\s\S]*?\{ opened: true \}\)/);
  });

  it('keeps the grade counter at zero rather than appearing later', () => {
    expect(script).toContain("c.passed + ' not interested · ' + c.opened + ' opened · ' + c.saved + ' saved'");
  });

  // A grade is saved only once the pull request that will carry it exists;
  // before that, a reset of the branch would drop the commit.
  it('marks grades saved only after the pull request exists', () => {
    const push = script.slice(script.indexOf('async function pushGrades('), script.indexOf('async function publishGrades('));
    expect(push.indexOf("gh('POST', '/pulls'")).toBeGreaterThan(0);
    expect(push.indexOf('l.synced = true')).toBeGreaterThan(push.indexOf("gh('POST', '/pulls'"));
  });

  it('keeps the file export for use without a token', () => {
    expect(script).toContain("a.download = 'labels.json'");
  });
});

describe('renderDashboard — card layout', () => {
  // Adding the stripe on click reflowed the list under the cursor.
  it('reserves the accent stripe on every card so saving does not reflow', () => {
    expect(css).toMatch(/\.card \{[^}]*border-left: 3px solid transparent/s);
    expect(css).toContain('.card.saved { border-left-color: var(--good); }');
  });

  // The label stays "save" and only the star fills in, so the pill cannot
  // change width.
  it('keeps the save label a constant width', () => {
    expect(css).toContain('.save .star, .pass .mark { display: inline-block; width: 1em;');
    expect(css).not.toMatch(/\.save\[aria-pressed=true\][^}]*font-weight/);
  });

  // An outlined pill means "button". Facts have to look like a different kind
  // of thing from the save and pass buttons beside them.
  it('styles facts as non-interactive: filled, unoutlined, no pointer', () => {
    expect(css).toMatch(/\.chip \{[^}]*background: var\(--line\)/s);
    expect(css).toMatch(/\.chip \{[^}]*cursor: default/s);
    expect(css).not.toMatch(/\.chip \{[^}]*border:/s);
    expect(css).toMatch(/\.save, \.pass \{[^}]*border: 1px solid var\(--line\)/s);
  });

  // The two questions a list card exists to answer should not cost a click.
  it('shows Summary and Why this score on list cards, summary first', () => {
    const card = script.slice(script.indexOf('function card('), script.indexOf('function renderList('));
    expect(card.indexOf('<h4>Summary</h4>')).toBeGreaterThan(0);
    expect(card.indexOf('<h4>Summary</h4>')).toBeLessThan(card.indexOf('<h4>Why this score</h4>'));
  });

  // Filing links are provenance nobody clicks through to; they stay in Details.
  it('keeps SEC filing links out of the links shown beside the facts', () => {
    expect(script).toContain('const isFiling = (l) => /^sec\\b/i.test(l.label);');
    expect(script).toContain('r.links.filter((l) => !isFiling(l))');
  });
});
