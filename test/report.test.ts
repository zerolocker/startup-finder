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
  valuation: null,
  foundedYear: 2021,
  teamSize: 40,
  totalRaisedUsd: 24_300_000,
  fundingHistory: [
    {
      date: '2024-03',
      round: 'Seed',
      amountUsd: 5_000_000,
      leadInvestor: 'Example Capital',
      investors: ['Angel One'],
      sourceUrl: 'https://press.test/inferra-seed',
    },
  ],
  openRoles: ['Staff Systems Engineer', 'ML Engineer'],
  techStack: ['Rust', 'CUDA'],
  competitors: ['Modal'],
  redFlags: [],
  greenFlags: ['Hiring senior engineers'],
  links: [{ label: 'Homepage', url: 'https://example.test' }],
};

/**
 * A dossier as written before valuation and company facts existed.
 *
 * Records in data/dossiers.jsonl are read back without revalidation, so the
 * committed ones genuinely arrive shaped like this — every new field `undefined`
 * rather than `null`. Casting is the point: it reproduces what disk hands us.
 */
const LEGACY_DOSSIER = {
  summary: 'Inferra runs real-time inference at the edge.',
  product: 'A low-latency inference runtime for edge devices.',
  team: 'Ex-Google engineers.',
  funding: '$19.3M Series A.',
  openRoles: ['Staff Systems Engineer'],
  techStack: ['Rust'],
  competitors: [],
  redFlags: [],
  greenFlags: [],
  links: [],
} as Dossier;

const REPORTED_VALUATION = {
  amountUsd: 2_000_000_000,
  basis: 'post-money',
  asOf: '2026-08-04',
  sourceUrl: 'https://press.test/valuation',
} as const;

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

  it('shows the round alongside the raise when press supplied one', () => {
    const c = company({ latestFunding: { ...company().latestFunding!, round: 'Series A' } });
    expect(renderDigest([c], OPTS)).toContain('$19.3M Series A');
  });

  it('surfaces founding year, team size, and lifetime raise', () => {
    const md = renderDigest([company()], OPTS);
    expect(md).toContain('Founded 2021 · ~40 people · $24.3M raised to date');
  });

  it('lists prior rounds with their sources', () => {
    const md = renderDigest([company()], OPTS);
    expect(md).toContain('**Prior rounds**');
    expect(md).toContain('led by Example Capital');
    expect(md).toContain('https://press.test/inferra-seed');
  });
});

describe('valuation in the digest', () => {
  it('prints a reported valuation as a fact, with its link', () => {
    const c = company({ dossier: { ...DOSSIER, valuation: REPORTED_VALUATION } });
    const md = renderDigest([c], OPTS);
    expect(md).toContain('**Valuation** — $2.0B post-money, [reported](https://press.test/valuation)');
    expect(md).not.toContain('$2.0B est.');
  });

  it('marks a derived valuation as an estimate and shows the arithmetic', () => {
    // The formula is the entire justification for printing a number nobody
    // published, so it must travel with the number (ADR-011).
    const md = renderDigest([company()], OPTS);
    expect(md).toContain('**Valuation (estimated)**');
    expect(md).toContain('est.');
    expect(md).toContain('÷');
    expect(md).toContain('dilution');
  });

  it('explains the blank rather than leaving it unexplained', () => {
    const c = company({ latestFunding: null });
    expect(renderDigest([c], OPTS)).toContain('not available (no disclosed raise to derive from)');
  });

  it('keeps the long-tail table free of valuations', () => {
    // Those rows were never examined; a derived range there would imply an
    // analysis that did not happen.
    const md = renderDigest([company(), company({ id: 'ghost', name: 'Ghost Co', dossier: null })], OPTS);
    const longTail = md.slice(md.indexOf('Everything else considered'));
    expect(longTail).not.toContain('est.');
  });
});

describe('dossiers written before these fields existed', () => {
  // The 17 committed dossiers are all in this shape until they are re-researched.
  const legacy = company({ dossier: LEGACY_DOSSIER });

  it('render in the digest without crashing or printing "undefined"', () => {
    const md = renderDigest([legacy], OPTS);
    expect(md).toContain('Inferra Inc.');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('NaN');
  });

  it('render in the dashboard without crashing or printing "undefined"', () => {
    const html = renderDashboard([legacy], OPTS);
    expect(html).toContain('Inferra Inc.');
    expect(html).not.toContain('undefined');
  });

  it('omit the facts line entirely rather than showing empty placeholders', () => {
    expect(renderDigest([legacy], OPTS)).not.toContain('Founded');
  });

  it('still get an estimated valuation, since it derives from the raise alone', () => {
    expect(renderDigest([legacy], OPTS)).toContain('**Valuation (estimated)**');
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

  it('tags each row with its valuation kind, which drives the styling', () => {
    // Both kinds land in the same column, so `kind` is what carries the
    // difference through to the card's class. Read it from the embedded row
    // data rather than the page text — both class names always appear in the
    // stylesheet, so a substring check would pass regardless.
    const kindOf = (page: string): string => {
      const json = /^const ROWS = (\[.*\]);$/m.exec(page)?.[1];
      return (JSON.parse(json!) as Array<{ valuation: { kind: string } }>)[0]!.valuation.kind;
    };
    expect(kindOf(html)).toBe('estimated');
    expect(kindOf(renderDashboard([company({ dossier: { ...DOSSIER, valuation: REPORTED_VALUATION } })], OPTS))).toBe(
      'reported',
    );
    expect(kindOf(renderDashboard([company({ latestFunding: null })], OPTS))).toBe('unknown');
  });

  it('has a style rule for each valuation kind it can emit', () => {
    expect(html).toContain('.tag.val-reported');
    expect(html).toContain('.tag.val-estimated');
  });

  it('offers a valuation sort', () => {
    expect(html).toContain('<option value="valuation">');
  });

  it('carries the derivation into the details panel', () => {
    expect(html).toContain('Not reported. Derived:');
  });
});
