import { describe, expect, it } from 'vitest';
import { describeCompany, renderDigest } from '../src/report/markdown.ts';
import { renderDashboard } from '../src/report/html.ts';
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
  const html = renderDashboard([company()], OPTS);

  it('is a self-contained document with no external requests', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet[^>]*href="http/);
  });

  it('embeds the row data for client-side filtering', () => {
    expect(html).toContain('const ROWS =');
    expect(html).toContain('Inferra Inc.');
  });

  it('cannot be broken out of the script block by a crafted company name', () => {
    // Names come from SEC filings and RSS — anyone can file a Form D with a
    // crafted entity name. A raw JSON.stringify would let "</script>" close the
    // element and turn the rest into live HTML.
    const payload = '</script><img src=x onerror=alert(1)>';
    const evil = renderDashboard([company({ name: payload })], OPTS);

    expect(evil).not.toContain('</script><img');
    expect(evil).toContain('\\u003c/script\\u003e');
    // Exactly one real script element remains.
    expect(evil.match(/<\/script>/g)).toHaveLength(1);
  });

  it('round-trips the escaped name back to the original string', () => {
    const payload = '</script>&<>"';
    const evil = renderDashboard([company({ name: payload })], OPTS);
    // Anchored to the line: a greedy dot-all match would run past the data
    // into the page's own script body.
    const json = /^const ROWS = (\[.*\]);$/m.exec(evil)?.[1];
    expect(json).toBeDefined();
    expect((JSON.parse(json!) as Array<{ name: string }>)[0]?.name).toBe(payload);
  });

  it('renders an empty run without throwing', () => {
    expect(() => renderDashboard([], OPTS)).not.toThrow();
  });
});
