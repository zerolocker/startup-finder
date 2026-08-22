import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/report/html.ts';

describe('renderDashboard', () => {
  const html = renderDashboard();

  it('has no external requests, so it works offline once served', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  // The point of the shell. Inlining the corpus made every run commit a ~520 KB
  // page that was 97% a copy of records already on disk. If this regresses,
  // repo growth quietly returns.
  it('carries no data, only the shell', () => {
    expect(html).not.toContain('const ROWS = [');
    expect(html.length).toBeLessThan(30_000);
  });

  // One issue, one fetch — which is the whole reason runs are sharded.
  it('reads the run index and exactly one shard', () => {
    expect(html).toContain("fetch('data/index.json')");
    expect(html).toContain("'data/runs/' + entry.date + '.jsonl'");
  });

  it('lets you switch issues without reloading everything', () => {
    expect(html).toContain('id="run"');
    expect(html).toContain("URLSearchParams(location.search).get('run')");
  });

  // A null assessment means research failed. That is a defect worth seeing, so
  // it must sort to the bottom rather than disappear.
  it('keeps companies whose research failed visible', () => {
    expect(html).toContain('Not assessed');
    expect(html).toContain('a ? Math.round(a.fit) : -1');
  });

  it('shows every company by default rather than a top slice', () => {
    expect(html).toMatch(/<option value="0" selected>any<\/option>/);
  });

  it('asks search engines not to index it', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex/);
  });

  it('explains how to fix the file:// case rather than rendering blank', () => {
    expect(html).toContain('python3 -m http.server');
  });

  // The controls bar sets display:flex, which outranks the UA stylesheet's
  // [hidden] rule — without this it sat on top of its own error message.
  it('can actually hide the controls it marks hidden', () => {
    expect(html).toMatch(/\[hidden\]\s*{\s*display:\s*none\s*!important/);
  });
});

describe('renderDashboard filtering', () => {
  const html = renderDashboard();

  // "any" excluded every unassessed company, because they carry -1 rather than
  // a score. That hid exactly the rows the dashboard exists to surface.
  it('treats "any" as any, including companies with no score yet', () => {
    expect(html).toContain('if (min > 0 && (!r.assessed || r.score < min)) return false;');
  });

  // An unresearched company has not been judged either way.
  it('counts "not real companies" over assessed rows only', () => {
    expect(html).toContain('assessed.filter((r) => !r.operating)');
  });
});

describe('renderDashboard — grading', () => {
  const html = renderDashboard();

  // Scrolling is not evidence: it cannot tell "read it and moved on" from "eyes
  // glazed over it". Every grade is now a click, so the machinery that turned a
  // scroll into a 0 is gone rather than merely unused.
  it('infers nothing from scrolling', () => {
    expect(html).not.toContain('IntersectionObserver');
    expect(html).not.toContain('rootMargin');
    expect(html).not.toMatch(/#list:not\(:empty\)::after/);
    expect(html).not.toMatch(/\bseen\b\s*:/);
  });

  // A company nobody clicked is absent, never a 0 — filling those in would teach
  // an eval that whatever the ranker buried deserved burying.
  it('exports only companies that were actually judged', () => {
    expect(html).toContain('const isLabelled = (l) => !!(l.saved || l.passed || l.opened);');
    expect(html).toContain('.filter(([, l]) => isLabelled(l))');
  });

  // A later filter or search moves the row, so the position is fixed on the
  // first label rather than recomputed.
  it('records rank on the click that labels the company', () => {
    expect(html).toContain('const rank = prev.rank ?? rankOf(id);');
    expect(html).toMatch(/const rankOf = \(id\) => \{/);
  });

  // Opening the details implies a 1, which overstates a read that ended in a no.
  it('lets "not interested" take an opened card back down to 0', () => {
    expect(html).toContain('const gradeOf = (l) => (l.saved ? 2 : l.passed ? 0 : l.opened ? 1 : 0);');
    expect(html).toContain('> not interested</button>');
  });

  // Both on at once would export a grade that contradicts the other button.
  it('makes save and "not interested" clear each other', () => {
    expect(html).toContain(
      'mark(id, { saved: isSave ? on : false, passed: isSave ? false : on });');
  });

});

describe('renderDashboard — card layout', () => {
  const html = renderDashboard();

  // Adding the stripe on click reflowed the list under the cursor.
  it('reserves the accent stripe on every card so saving does not reflow', () => {
    expect(html).toMatch(/\.card \{[^}]*border-left: 3px solid transparent/s);
    expect(html).toContain('.card.saved { border-left-color: var(--good); }');
    expect(html).not.toMatch(/\.card\.saved \{ border-left: 3px/);
  });

  // The label stays "save" and only the star fills in, so the pill cannot
  // change width — no min-width needed, and no dead space inside it.
  it('keeps the save label a constant width without padding the pill out', () => {
    expect(html).not.toMatch(/\.save \{[^}]*min-width:/s);
    expect(html).toContain(".save .star, .pass .mark { display: inline-block; width: 1em;");
    expect(html).not.toContain("'★ saved'");
    // Bolding the pressed label made the pill 1px wider.
    expect(html).not.toMatch(/\.save\[aria-pressed=true\][^}]*font-weight/);
  });

  // The search input is flex:1, so a counter that grows steals its space and
  // shifts the whole row.
  it('reserves room for the grading counter so the control bar cannot reflow', () => {
    expect(html).toMatch(/#graded \{[^}]*min-width: 17\.5rem/s);
    expect(html).toMatch(/#graded \{[^}]*tabular-nums/s);
    expect(html).toMatch(/\.count \{[^}]*tabular-nums/s);
  });

  it('renders the counter at zero rather than appearing later', () => {
    expect(html).toContain("n(0) + ' not interested · ' + n(1) + ' opened · ' + n(2) + ' saved'");
  });

  // Pinned to the right edge these read as a footnote, which is the wrong weight
  // for the first facts about a company.
  it('puts funding, date and location on one left-aligned line, not a right rail', () => {
    expect(html).toContain("const facts = [r.amountLabel, r.date, r.location].filter(Boolean)");
    expect(html).not.toMatch(/\.meta \{[^}]*margin-left: auto/s);
    expect(html).not.toMatch(/\.meta \{[^}]*text-align: right/s);
    expect(html).not.toContain('<span class="tag">\' + esc(r.location)');
  });

  // The two questions the card exists to answer should not cost a click.
  it('renders Summary and Why this score outside Details, summary first', () => {
    const always = html.slice(html.indexOf('const always ='), html.indexOf('const meta ='));
    expect(always).toContain('<h4>Summary</h4>');
    expect(always).toContain('<h4>Why this score</h4>');
    expect(always.indexOf('Summary')).toBeLessThan(always.indexOf('Why this score'));
    // The Details panel keeps the rest and must not carry these back.
    const detail = html.slice(html.indexOf('const detail = list('), html.indexOf('const always ='));
    expect(detail).not.toContain('Why this score');
    expect(detail).not.toContain('<h4>Summary</h4>');
  });

  // They live outside .detail now, so the label style has to reach them.
  it('styles section labels at the card level, not only inside Details', () => {
    expect(html).toMatch(/\.card h4 \{[^}]*text-transform: uppercase/s);
    expect(html).not.toMatch(/\.detail h4 \{/);
  });

  // An outlined pill in the head means "button". These are labels, so they have
  // to look like a different kind of thing, not the same kind in another colour.
  it('styles the badges as non-interactive: filled, unoutlined, no pointer', () => {
    expect(html).toMatch(/\.tag \{[^}]*background: var\(--line\)/s);
    expect(html).toMatch(/\.tag \{[^}]*cursor: default/s);
    expect(html).not.toMatch(/\.tag \{[^}]*border:/s);
    expect(html).not.toMatch(/\.tag[^{]*:hover/);
    // The buttons keep the outline that says they can be pressed.
    expect(html).toMatch(/\.save, \.pass \{[^}]*border: 1px solid var\(--line\)/s);
  });

  it('puts open roles and confidence in the head, the warning on its own row', () => {
    const head = html.slice(html.indexOf("'<div class=\"head\">"), html.indexOf("(meta ?"));
    expect(head).toContain('headTags');
    expect(html).toMatch(/const headTags =[\s\S]*?open role[\s\S]*?confidence/);
    // The warning is deliberately not promoted — it negates everything above it.
    expect(html).toMatch(/const tags = \[\];\s*if \(!r\.operating\)/);
    expect(html.slice(html.indexOf('const headTags ='), html.indexOf('const tags = ['))).not.toContain('operating');
  });

  // Filing links are provenance nobody clicks through to, and they are the bulk
  // of them; the ones that say what the company is belong next to the facts.
  it('lifts every link except the SEC filings up beside the facts', () => {
    expect(html).toContain('const isFiling = (l) => /^sec\\b/i.test(l.label);');
    expect(html).toContain('r.links.filter((l) => !isFiling(l))');
    expect(html).toContain("sourceLinks.filter((x) => !x.edgar)");
    // Details keeps the filings and the EDGAR source, and nothing else.
    expect(html).toContain('const links = [...r.links.filter(isFiling), ...sourceLinks.filter((x) => x.edgar)]');
    expect(html).toContain("const meta = (facts ? '<span class=\"facts\">' + facts + '</span>' : '') + headLinks;");
  });

  it('puts "not interested" beside save in the head, not in Details', () => {
    const head = html.slice(html.indexOf("'<div class=\"head\">"), html.indexOf("(meta ?"));
    expect(head).toContain('class="save"');
    expect(head).toContain('class="pass"');
    expect(head.indexOf('class="save"')).toBeLessThan(head.indexOf('class="pass"'));
  });

  // An SEC address is frequently the filing agent's, so the researched HQ wins.
  it('prefers the researched headquarters over the filing address', () => {
    expect(html).toContain("a?.headquarters?.trim() || titleCase(c.location || '')");
  });
});

describe('renderDashboard — location formatting', () => {
  // EDGAR shouts its cities. The researched headquarters is properly cased
  // already, so only the fallback needs help.
  it('cases down the SEC address fallback', () => {
    const html = renderDashboard();
    expect(html).toContain('titleCase(c.location');
    expect(html).toMatch(/const titleCase = \(s\) =>/);
  });
});
