import { describe, expect, it } from 'vitest';
import { byFundingRecency } from '../src/cli.ts';
import type { RunCompany } from '../src/types.ts';

const c = (id: string, date: string | null): RunCompany =>
  ({
    id,
    latestFunding: date ? { date, amountUsd: null, round: null, source: 'edgar' } : null,
  }) as unknown as RunCompany;

// A rate limit routinely cuts research short, and the shard is stored in id
// order so git can diff it. Whoever is at the front of this sort is who gets
// researched — so it has to be the freshest money, not the alphabet.
describe('byFundingRecency', () => {
  const sorted = (xs: RunCompany[]) => [...xs].sort(byFundingRecency).map((x) => x.id);

  it('puts the most recently funded first', () => {
    expect(sorted([c('old', '2026-06-01'), c('new', '2026-08-10'), c('mid', '2026-07-04')])).toEqual([
      'new', 'mid', 'old',
    ]);
  });

  it('does not fall back to alphabetical order', () => {
    // "aaa" would win on id order; it must not, because it is the stalest.
    expect(sorted([c('aaa', '2026-01-01'), c('zzz', '2026-08-10')])[0]).toBe('zzz');
  });

  it('sinks companies with no known funding date rather than dropping them', () => {
    expect(sorted([c('unknown', null), c('dated', '2026-08-10')])).toEqual(['dated', 'unknown']);
  });

  it('is stable on ties, so a rerun researches the same companies', () => {
    expect(sorted([c('b', '2026-08-10'), c('a', '2026-08-10')])).toEqual(['a', 'b']);
  });
});
