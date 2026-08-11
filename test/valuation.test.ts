import { describe, expect, it } from 'vitest';
import {
  resolveValuation,
  valuationLabel,
  valuationSortValue,
  type ValuationInput,
} from '../src/pipeline/valuation.ts';
import type { Dossier, FundingEvent } from '../src/types.ts';

function funding(overrides: Partial<FundingEvent> = {}): FundingEvent {
  return {
    date: '2026-08-01',
    amountUsd: 19_300_000,
    round: null,
    investors: [],
    source: 'edgar',
    sourceUrl: 'https://sec.test/x',
    ...overrides,
  };
}

/** Minimal dossier — only the fields a given test actually cares about. */
function dossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    summary: '',
    product: '',
    team: '',
    funding: '',
    openRoles: [],
    techStack: [],
    competitors: [],
    redFlags: [],
    greenFlags: [],
    links: [],
    ...overrides,
  };
}

function input(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return { latestFunding: funding(), evidence: [], ...overrides };
}

describe('reported valuations', () => {
  it('wins over the derived estimate', () => {
    const result = resolveValuation(
      input({
        dossier: dossier({
          valuation: {
            amountUsd: 2_000_000_000,
            basis: 'post-money',
            asOf: '2026-08-04',
            sourceUrl: 'https://techcrunch.test/happyrobot',
          },
        }),
      }),
    );
    expect(result.kind).toBe('reported');
    expect(valuationLabel(result)).toBe('$2.0B');
  });

  it('is discarded when it has no source URL', () => {
    // A valuation nobody can check is the most expensive kind of wrong this app
    // can print (CLAUDE.md rule 1). The schema requires the URL, but dossiers on
    // disk are read back without revalidation, so this has to be caught here.
    const result = resolveValuation(
      input({
        dossier: dossier({
          valuation: { amountUsd: 999_000_000, basis: 'unspecified', asOf: null, sourceUrl: '' },
        }),
      }),
    );
    expect(result.kind).toBe('estimated');
  });
});

describe('no basis to estimate from', () => {
  it('returns unknown when the raise is undisclosed', () => {
    const result = resolveValuation(input({ latestFunding: funding({ amountUsd: null }) }));
    expect(result).toEqual({ kind: 'unknown', reason: 'no disclosed raise to derive from' });
  });

  it('returns unknown when there is no funding event at all', () => {
    expect(resolveValuation(input({ latestFunding: null })).kind).toBe('unknown');
  });

  it('treats a zero raise as unknown, never as a $0 valuation', () => {
    // Rule 6: null means unknown, never 0. A 0 here would divide to 0 and rank
    // the company as worthless rather than unmeasured.
    expect(resolveValuation(input({ latestFunding: funding({ amountUsd: 0 }) })).kind).toBe('unknown');
  });

  it('skips token and SAFT raises, where dilution math is meaningless', () => {
    // Real case: Vangrid's $9M "SAFT (token-based seed round)" in the 2026-08-10
    // run. Buying tokens does not buy a share of the company, so raise ÷ dilution
    // describes nothing.
    const result = resolveValuation(
      input({ dossier: dossier({ funding: 'Raised $9M via a SAFT closing in tranches.' }) }),
    );
    expect(result).toEqual({
      kind: 'unknown',
      reason: 'token/SAFT raise — equity dilution math does not apply',
    });
  });

  it('still estimates for an equity company that merely mentions blockchain', () => {
    // The instrument is what breaks the math, not the subject matter.
    const result = resolveValuation(
      input({ dossier: dossier({ product: 'Blockchain analytics for banks.' }) }),
    );
    expect(result.kind).toBe('estimated');
  });
});

describe('the arithmetic', () => {
  it('divides the raise by the dilution band, low dilution giving the high bound', () => {
    const result = resolveValuation(input({ latestFunding: funding({ round: 'Series A' }) }));
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    expect(result.estimate.lowUsd).toBeCloseTo(19_300_000 / 0.25, 0);
    expect(result.estimate.highUsd).toBeCloseTo(19_300_000 / 0.15, 0);
    expect(valuationLabel(result)).toBe('~$77.2M–$128.7M est.');
  });

  it('shows its working in the method string', () => {
    const result = resolveValuation(input({ latestFunding: funding({ round: 'Series A' }) }));
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    expect(result.estimate.method).toBe('$19.3M raise ÷ 15–25% dilution (series a)');
  });
});

describe('dilution band selection', () => {
  const bandFor = (round: string | null): [number, number] => {
    const result = resolveValuation(input({ latestFunding: funding({ amountUsd: 10_000_000, round }) }));
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    return [result.estimate.lowUsd, result.estimate.highUsd];
  };

  it('gives later rounds a narrower, higher band than seed', () => {
    const [seedLow] = bandFor('Seed');
    const [lateLow] = bandFor('Series D');
    expect(lateLow).toBeGreaterThan(seedLow);
  });

  it('matches pre-seed before seed', () => {
    expect(bandFor('Pre-Seed')).not.toEqual(bandFor('Seed'));
  });

  it('collapses Series C and beyond into one late band', () => {
    expect(bandFor('Series C')).toEqual(bandFor('Series F'));
  });

  it('falls back to the widest band for an unrecognised label', () => {
    // "Growth" and "Bridge" tell us nothing about dilution, so they must not be
    // silently priced as if they were a Series A.
    expect(bandFor('Growth')).toEqual(bandFor(null));
  });
});

describe('caveats', () => {
  const caveats = (over: Partial<ValuationInput>): string[] => {
    const result = resolveValuation(input(over));
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    return result.estimate.caveats;
  };

  it('warns that a Form D figure is capital sold so far', () => {
    expect(caveats({}).join(' ')).toMatch(/sold so far/);
  });

  it('warns when the filing is an amendment', () => {
    expect(caveats({ evidence: ['Form D/A amendment (follow-on close)'] }).join(' ')).toMatch(/cumulative/);
  });

  it('warns when the raise was reported in a non-USD currency', () => {
    // Amounts are stored unconverted (docs/READING_THE_REPORT.md), so a €39.9M
    // raise produces a euro-denominated estimate wearing a dollar sign.
    expect(caveats({ evidence: ['Headline: Neuraspace lands €15.6M'] }).join(' ')).toMatch(/non-USD/);
  });

  it('warns when there is no round label', () => {
    expect(caveats({}).join(' ')).toMatch(/No round label/);
  });

  it('drops the round-label caveat once the stage is known', () => {
    expect(caveats({ latestFunding: funding({ round: 'Seed' }) }).join(' ')).not.toMatch(/No round label/);
  });
});

describe('recovering a round label from the dossier', () => {
  it('adopts a historical round whose amount matches the raise being priced', () => {
    const result = resolveValuation(
      input({
        dossier: dossier({
          fundingHistory: [
            { date: '2026-08', round: 'Series B', amountUsd: 19_300_000, leadInvestor: null, investors: [], sourceUrl: null },
          ],
        }),
      }),
    );
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    expect(result.estimate.method).toMatch(/series b/);
  });

  it('ignores a historical round with a different amount', () => {
    // Otherwise a Series B raise gets labelled "Series A" simply because that is
    // the newest round the press happened to write up.
    const result = resolveValuation(
      input({
        dossier: dossier({
          fundingHistory: [
            { date: '2024-01', round: 'Series A', amountUsd: 5_000_000, leadInvestor: null, investors: [], sourceUrl: null },
          ],
        }),
      }),
    );
    if (result.kind !== 'estimated') throw new Error('expected an estimate');
    expect(result.estimate.method).toMatch(/stage unknown/);
  });
});

describe('labels and sorting', () => {
  it('marks every estimate with ~ and est. so a sorted column cannot disguise it', () => {
    expect(valuationLabel(resolveValuation(input()))).toMatch(/^~.*est\.$/);
  });

  it('renders an em dash when nothing is known', () => {
    expect(valuationLabel(resolveValuation(input({ latestFunding: null })))).toBe('—');
  });

  it('sorts estimates on the midpoint of their range', () => {
    const result = resolveValuation(input({ latestFunding: funding({ round: 'Series A' }) }));
    expect(valuationSortValue(result)).toBeCloseTo((19_300_000 / 0.25 + 19_300_000 / 0.15) / 2, 0);
  });

  it('sorts unknowns to the bottom', () => {
    expect(valuationSortValue(resolveValuation(input({ latestFunding: null })))).toBe(0);
  });
});
