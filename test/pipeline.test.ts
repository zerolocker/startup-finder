import { describe, expect, it } from 'vitest';
import { mergeSources, shouldMerge } from '../src/pipeline/merge.ts';
import { prefilterScore, rankCompanies } from '../src/pipeline/prefilter.ts';
import { buildScorePrompt, effectiveScore } from '../src/pipeline/score.ts';
import { extractJson } from '../src/llm/claude.ts';
import type { Company, FormDFiling, NewsItem, Profile, ScoredCompany } from '../src/types.ts';

const NOW = Date.parse('2026-08-08T00:00:00Z');

const PROFILE: Profile = {
  about: 'engineer',
  intent: ['join'],
  interests: {
    themes: [{ name: 'AI/ML infrastructure', weight: 1 }],
    antiThemes: ['crypto'],
  },
  stage: { minRaiseUsd: 2_000_000, maxRaiseUsd: 150_000_000 },
  geography: { preferred: ['CA'], remoteOk: true },
  notes: [],
};

function filing(overrides: Partial<FormDFiling> = {}): FormDFiling {
  return {
    cik: '0000000001',
    accessionNumber: 'acc-1',
    entityName: 'Acme AI, Inc.',
    filedDate: '2026-08-01',
    dateOfFirstSale: '2026-07-28',
    industryGroup: 'Other Technology',
    totalOfferingAmount: 10_000_000,
    totalAmountSold: 10_000_000,
    totalRemaining: 0,
    investorCount: 5,
    isAmendment: false,
    jurisdictionOfIncorporation: 'DELAWARE',
    entityType: 'Corporation',
    revenueRange: null,
    relatedPersons: [
      { name: 'Ada Lovelace', relationships: ['Executive Officer'] },
      { name: 'Alan Turing', relationships: ['Director'] },
      { name: 'Grace Hopper', relationships: ['Director'] },
    ],
    address: { street: null, city: 'San Francisco', state: 'CA', zip: null },
    filingUrl: 'https://sec.test/acme',
    ...overrides,
  };
}

function newsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'news-1',
    title: 'Acme AI raises $10M Series A led by Foundry',
    url: 'https://news.test/acme',
    publishedAt: '2026-08-02T00:00:00Z',
    source: 'test',
    summary: 'Acme AI builds inference infrastructure.',
    ...overrides,
  };
}

describe('mergeSources', () => {
  it('creates one company per filing', () => {
    const { companies } = mergeSources([filing()], []);
    expect(companies).toHaveLength(1);
    expect(companies[0]?.name).toBe('Acme AI, Inc.');
    expect(companies[0]?.latestFunding?.amountUsd).toBe(10_000_000);
  });

  it('merges a news item into the matching EDGAR company', () => {
    const { companies, stats } = mergeSources([filing()], [newsItem()]);
    expect(companies).toHaveLength(1);
    expect(stats.newsMerged).toBe(1);
    const company = companies[0]!;
    expect(company.sources.map((s) => s.kind).sort()).toEqual(['edgar', 'news']);
    // The round label can only come from the news side.
    expect(company.fundingEvents.some((e) => e.round === 'Series A')).toBe(true);
  });

  it('creates a standalone company for news with no EDGAR match', () => {
    const { companies, stats } = mergeSources([], [newsItem({ title: 'Zeta raises $8M seed' })]);
    expect(stats.fromNews).toBe(1);
    expect(companies[0]?.name).toBe('Zeta');
  });

  it('does not double-count a filing seen twice', () => {
    const { companies } = mergeSources([filing(), filing()], []);
    expect(companies).toHaveLength(1);
    expect(companies[0]?.fundingEvents).toHaveLength(1);
  });

  it('absorbs a follow-on filing into the same company', () => {
    const { companies } = mergeSources(
      [filing(), filing({ accessionNumber: 'acc-2', dateOfFirstSale: '2026-08-05', totalAmountSold: 15_000_000 })],
      [],
    );
    expect(companies).toHaveLength(1);
    expect(companies[0]?.fundingEvents).toHaveLength(2);
    // Newest first, so latestFunding is the follow-on.
    expect(companies[0]?.latestFunding?.amountUsd).toBe(15_000_000);
  });

  it('preserves firstSeenAt across reruns', () => {
    const first = mergeSources([filing()], []).companies;
    const original = first[0]!.firstSeenAt;
    const second = mergeSources([filing()], [], first).companies;
    expect(second[0]?.firstSeenAt).toBe(original);
  });

  it('unions officers without duplicating them', () => {
    const { companies } = mergeSources(
      [
        filing(),
        filing({
          accessionNumber: 'acc-2',
          relatedPersons: [
            { name: 'Ada Lovelace', relationships: ['Executive Officer'] },
            { name: 'Katherine Johnson', relationships: ['Director'] },
          ],
        }),
      ],
      [],
    );
    expect(companies[0]?.people.map((p) => p.name)).toEqual([
      'Ada Lovelace',
      'Alan Turing',
      'Grace Hopper',
      'Katherine Johnson',
    ]);
  });
});

describe('shouldMerge', () => {
  const company = mergeSources([filing()], []).companies[0]!;

  it('matches on normalized name', () => {
    expect(shouldMerge('Acme AI', company)).toBe(true);
    expect(shouldMerge('Acme AI Inc.', company)).toBe(true);
  });

  it('refuses near-misses, which would fabricate a merged company', () => {
    expect(shouldMerge('Acme AI Labs Systems', company)).toBe(false);
    expect(shouldMerge('Acme', company)).toBe(false);
  });

  it('refuses names too short to be distinctive', () => {
    expect(shouldMerge('AI', company)).toBe(false);
  });
});

describe('prefilterScore', () => {
  const score = (c: Company) => prefilterScore(c, PROFILE, NOW);
  const base = () => mergeSources([filing()], []).companies[0]!;

  it('rewards a recent, well-sized, on-theme round', () => {
    expect(score(base()).total).toBeGreaterThan(60);
  });

  it('penalizes stale funding', () => {
    const old = base();
    old.latestFunding!.date = '2025-01-01';
    expect(score(old).breakdown['recency']).toBe(0);
  });

  it('penalizes anti-theme companies', () => {
    const crypto = base();
    crypto.name = 'Acme Blockchain Token Inc';
    crypto.evidence.push('Headline: Acme Blockchain raises for token launch');
    expect(score(crypto).breakdown['antiTheme']).toBeLessThan(0);
    expect(score(crypto).total).toBeLessThan(score(base()).total);
  });

  it('treats an unknown amount as uncertain rather than disqualifying', () => {
    const unknown = base();
    unknown.latestFunding!.amountUsd = null;
    expect(score(unknown).breakdown['amount']).toBeGreaterThan(0);
    expect(score(unknown).notes.join(' ')).toContain('unknown');
  });

  it('rewards corroboration by both SEC and press', () => {
    const both = mergeSources([filing()], [newsItem()]).companies[0]!;
    expect(score(both).breakdown['corroborated']).toBeGreaterThan(0);
    expect(score(both).total).toBeGreaterThan(score(base()).total);
  });

  it('rewards a preferred location', () => {
    const elsewhere = base();
    elsewhere.location = 'Austin, TX';
    expect(score(base()).breakdown['geography']).toBeGreaterThan(score(elsewhere).breakdown['geography']!);
  });

  it('flags single-officer shells', () => {
    const shell = base();
    shell.people = [{ name: 'Solo Founder', relationships: ['Executive Officer'] }];
    expect(score(shell).notes.join(' ')).toContain('one officer');
  });
});

describe('rankCompanies', () => {
  it('orders best first', () => {
    const good = mergeSources([filing()], []).companies[0]!;
    const bad = mergeSources([filing({ entityName: 'Crypto Coin Mining Corp', accessionNumber: 'b' })], []).companies[0]!;
    const ranked = rankCompanies([bad, good], PROFILE, NOW);
    expect(ranked[0]?.company.name).toBe('Acme AI, Inc.');
  });
});

describe('effectiveScore', () => {
  const company = mergeSources([filing()], []).companies[0]!;
  const scored = (llmFit: number | null): ScoredCompany => ({
    ...company,
    prefilter: { total: 90, breakdown: {}, notes: [] },
    llm: llmFit == null ? null : {
      fit: llmFit, whatTheyDo: '', matchedInterests: [], concerns: [], rationale: '', confidence: 'high',
    },
  });

  it('uses the LLM score when present', () => {
    expect(effectiveScore(scored(77))).toBe(77);
  });

  it('caps unscored companies so they cannot outrank a validated one', () => {
    expect(effectiveScore(scored(null))).toBeLessThanOrEqual(45);
    expect(effectiveScore(scored(50))).toBeGreaterThan(effectiveScore(scored(null)));
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced object', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object embedded in prose', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('handles nested braces', () => {
    expect(extractJson('prefix {"a":{"b":[1,2]}} suffix')).toEqual({ a: { b: [1, 2] } });
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/no JSON object/);
  });
});

describe('buildScorePrompt', () => {
  const candidates = [
    { company: mergeSources([filing()], []).companies[0]!, prefilter: { total: 70, breakdown: {}, notes: ['keyword themes: AI/ML'] } },
  ];
  const prompt = buildScorePrompt(candidates, PROFILE);

  it('embeds the profile so scoring reflects the user, not generic taste', () => {
    expect(prompt).toContain(PROFILE.about.trim());
    expect(prompt).toContain('AI/ML infrastructure');
    expect(prompt).toContain('importance 1.00');
  });

  it('states the intent, which changes the evaluation lens', () => {
    expect(prompt).toContain('JOINING a startup as an employee');
    expect(prompt).toContain('As a PLACE TO WORK');
  });

  it('tells the model it has no web access and must admit ignorance', () => {
    // The rule that keeps the app from fabricating product descriptions.
    expect(prompt).toContain('You do NOT\n   have web access here');
    expect(prompt).toContain('Do NOT invent a product description');
  });

  it('separates confidence from score', () => {
    expect(prompt).toContain('A low-confidence score is not a low score');
  });

  it('renders the company facts it actually has', () => {
    expect(prompt).toContain('id: acme-ai');
    expect(prompt).toContain('San Francisco, CA');
    expect(prompt).toContain('Ada Lovelace');
    expect(prompt).toContain('triage notes: keyword themes: AI/ML');
  });

  it('asks for exactly one entry per company', () => {
    expect(prompt).toContain('COMPANIES TO SCORE (1)');
    expect(prompt).toContain('Return exactly 1 entries');
  });

  it('includes anti-themes so mismatches can be scored down', () => {
    expect(prompt).toContain('ACTIVELY NOT INTERESTED IN');
    expect(prompt).toContain('crypto');
  });
});
