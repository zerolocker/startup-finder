import { describe, expect, it } from 'vitest';
import { describeCompany, renderDigest } from '../src/report/markdown.ts';
import { renderDashboard, renderDashboardMeta } from '../src/report/html.ts';
import type { Dossier, LlmScore, ResearchedCompany } from '../src/types.ts';

const LLM: LlmScore = {
  fit: 74,
  whatTheyDo: 'Unknown precisely, but the name suggests AI inference.',
  matchedInterests: ['AI/ML infrastructure'],
  concerns: ['Thin evidence'],
  rationale: 'Promising name, solid raise, unverified.',
  confidence: 'low',
};

const DOSSIER: Dossier = {
  summary: 'Inferra runs real-time inference at the edge.',
  product: 'A low-latency inference runtime for edge devices.',
  team: 'Ex-Google engineers.',
  funding: '$19.3M Series A.',
  openRoles: ['Staff Systems Engineer', 'ML Engineer'],
  techStack: ['Rust', 'CUDA'],
  competitors: ['Modal'],
  redFlags: [],
  greenFlags: ['Hiring senior engineers'],
  links: [{ label: 'Homepage', url: 'https://example.test' }],
};

function company(overrides: Partial<ResearchedCompany> = {}): ResearchedCompany {
  return {
    id: 'inferra',
    name: 'Inferra Inc.',
    normalizedName: 'inferra',
    sources: [{ kind: 'edgar', ref: 'acc-1', url: 'https://sec.test/inferra' }],
    latestFunding: {
      date: '2026-08-01',
      amountUsd: 19_300_000,
      round: null,
      investors: [],
      source: 'edgar',
      sourceUrl: 'https://sec.test/inferra',
    },
    fundingEvents: [],
    location: 'Menlo Park, CA',
    people: [{ name: 'Ada Lovelace', relationships: ['Executive Officer'] }],
    evidence: ['SEC industry: Other Technology'],
    firstSeenAt: '2026-08-01T00:00:00Z',
    lastUpdatedAt: '2026-08-01T00:00:00Z',
    prefilter: { total: 70, breakdown: {}, notes: [] },
    llm: LLM,
    dossier: DOSSIER,
    researchedAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

const OPTS = { runId: 'test', windowDays: 10, costUsd: 1.23, totalCandidates: 100 };

describe('describeCompany', () => {
  it('prefers the researched product over the screening guess', () => {
    // The screening stage has no web access and says "Unknown precisely…".
    // Showing that for a company we actually researched wastes the answer.
    expect(describeCompany(company())).toBe(DOSSIER.product);
  });

  it('falls back to the dossier summary when product is empty', () => {
    const c = company({ dossier: { ...DOSSIER, product: '' } });
    expect(describeCompany(c)).toBe(DOSSIER.summary);
  });

  it('falls back to the screening guess when there is no dossier', () => {
    expect(describeCompany(company({ dossier: null }))).toBe(LLM.whatTheyDo);
  });

  it('never returns empty', () => {
    expect(describeCompany(company({ dossier: null, llm: null }))).toBe('—');
  });
});

describe('renderDigest', () => {
  it('includes the company, its score, and its open roles', () => {
    const md = renderDigest([company()], OPTS);
    expect(md).toContain('Inferra Inc.');
    expect(md).toContain('74');
    expect(md).toContain('Staff Systems Engineer');
  });

  it('states the honesty caveat about model-generated claims', () => {
    expect(renderDigest([company()], OPTS)).toContain('verified before you act on it');
  });

  it('omits a zero cost rather than printing $0.00', () => {
    const md = renderDigest([company()], { ...OPTS, costUsd: 0 });
    expect(md).not.toContain('$0.00');
  });

  it('reports researched and featured counts separately', () => {
    const many = Array.from({ length: 20 }, (_, i) => company({ id: `c${i}`, name: `Co ${i}` }));
    const md = renderDigest(many, { ...OPTS, featureCount: 12 });
    expect(md).toContain('20 researched in depth');
    expect(md).toContain('top 12 written up below');
  });

  it('keeps unresearched companies visible in the long tail', () => {
    // Invariant: nothing that survives merge may silently disappear.
    const md = renderDigest([company(), company({ id: 'ghost', name: 'Ghost Co', dossier: null })], OPTS);
    expect(md).toContain('Ghost Co');
  });

  it('renders an empty run without throwing', () => {
    expect(() => renderDigest([], OPTS)).not.toThrow();
  });
});

describe('renderDashboard', () => {
  const html = renderDashboard();

  it('has no external requests, so it works offline once served', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  // The whole point of the shell. Inlining the dataset made every run commit a
  // ~520 KB file that was 97% a copy of records already in data/. If this ever
  // regresses, repo growth quietly doubles again.
  it('contains no data, only the shell', () => {
    expect(html).not.toContain('const ROWS = [');
    expect(html.length).toBeLessThan(30_000);
  });

  it('fetches the committed data files by relative path', () => {
    expect(html).toContain("jsonl('data/scored.jsonl')");
    expect(html).toContain("jsonl('data/dossiers.jsonl')");
    expect(html).toContain("fetch('reports/meta.json')");
  });

  // Carrying no data also removes the injection surface entirely: a crafted
  // SEC entity name can no longer reach the document at build time, because
  // nothing about a company is written into it.
  it('cannot carry a crafted company name into the document', () => {
    expect(html).not.toContain('Inferra');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
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

describe('renderDashboardMeta', () => {
  it('carries the run id, which stamps exported grades', () => {
    const meta = JSON.parse(renderDashboardMeta(OPTS));
    expect(meta.runId).toBe(OPTS.runId);
    expect(meta.windowDays).toBe(OPTS.windowDays);
    expect(typeof meta.generatedAt).toBe('string');
  });

  it('stays small enough to commit every run', () => {
    expect(renderDashboardMeta(OPTS).length).toBeLessThan(500);
  });
});
