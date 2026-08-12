import { describe, expect, it } from 'vitest';
import { mergeSources, shouldMerge } from '../src/pipeline/merge.ts';
import { buildResearchPrompt, fitOf } from '../src/pipeline/research.ts';
import { extractJson } from '../src/llm/claude.ts';
import type { Assessment, FormDFiling, NewsItem, Profile, RunCompany } from '../src/types.ts';

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

describe('buildResearchPrompt', () => {
  const company = mergeSources([filing()], [newsItem()]).companies[0]!;
  const prompt = buildResearchPrompt(company, PROFILE);

  it('embeds the profile, so scoring reflects this user rather than generic taste', () => {
    expect(prompt).toContain(PROFILE.about.trim());
    expect(prompt).toContain('AI/ML infrastructure');
  });

  it('states the anti-themes', () => {
    expect(prompt).toContain('crypto');
  });

  it('hands over everything already known, so search starts from facts', () => {
    expect(prompt).toContain('Acme AI, Inc.');
    expect(prompt).toContain('San Francisco, CA');
    expect(prompt).toContain('Ada Lovelace');
    expect(prompt).toContain('$10.0M');
  });

  // The failure this stage is most capable of is confident nonsense about a
  // company with a similar name, so the instruction has to survive edits.
  it('tells the model to admit when it cannot identify the company', () => {
    expect(prompt).toMatch(/Unknown/);
    expect(prompt).toMatch(/different company with\s+a similar name/i);
    expect(prompt).toMatch(/never invent/i);
  });

  it('asks for a score and a confidence, not just a dossier', () => {
    expect(prompt).toContain('"fit"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('SCORING BANDS');
  });

  // The web can tell an SPV from a company where a legal name cannot, and the
  // ingest regex is known to let some through.
  it('asks the model to flag entities that are not operating companies', () => {
    expect(prompt).toContain('"isOperatingCompany"');
    expect(prompt).toMatch(/funds, SPVs, holding companies/i);
  });
});

describe('fitOf', () => {
  const base = mergeSources([filing()], []).companies[0]!;
  const withFit = (fit: number | null): RunCompany => ({
    ...base,
    assessment: fit == null ? null : ({ fit } as Assessment),
    researchedAt: null,
  });

  it('uses the assessed fit', () => {
    expect(fitOf(withFit(77))).toBe(77);
  });

  // Research failing is a defect worth seeing, so an unassessed company sinks
  // to the bottom of the list rather than being filtered out of it.
  it('sorts an unassessed company below every assessed one, including a zero', () => {
    expect(fitOf(withFit(null))).toBeLessThan(fitOf(withFit(0)));
  });
});
