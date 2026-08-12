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
