/**
 * Valuation: what a company is worth, reported or derived.
 *
 * Nothing upstream supplies this. Form D omits valuation entirely
 * (docs/DATA_SOURCES.md), and ADR-001 rejected the paid databases that would
 * fill it in. So there are exactly two ways to put a number on the page:
 *
 *   1. The research stage found one in press, with a URL. That is a fact.
 *   2. We derive a range from the disclosed raise. That is arithmetic.
 *
 * These must never merge into one number. A reported valuation is evidence; a
 * derived one is a convention applied to a single dollar figure, and the user
 * has to be able to tell which they are looking at at a glance. That is why
 * {@link Valuation} is a discriminated union rather than a nullable number —
 * the compiler will not let a caller render a derived range as a fact.
 *
 * See ADR-011 for why derived valuations are allowed here at all, given that
 * CLAUDE.md rule 1 makes admitting ignorance the default everywhere else.
 *
 * Pure and deterministic: no LLM, no network, no persistence. Estimates are
 * recomputed on every render so they cannot go stale against the raise they
 * were derived from.
 */

import type { Company, Dossier, ValuationEstimate, ValuationFact } from '../types.ts';
import { formatUsd } from '../util/text.ts';

/**
 * Fraction of a company sold in a typical priced round, by stage.
 *
 * These are the standard venture conventions, not measurements — which is
 * precisely why the output is a band and never a point. Later stages dilute
 * less because the company is worth more per dollar raised.
 *
 * `unknown` is the widest band and, in practice, the common case: round labels
 * come only from press, and Form D has no round field at all, so most companies
 * reach this module with `round: null`. That width is honest signal about how
 * little we know — resist the urge to narrow it to make the report look sharper.
 */
const DILUTION_BANDS: Record<string, readonly [number, number]> = {
  'pre-seed': [0.1, 0.2],
  seed: [0.15, 0.25],
  'series a': [0.15, 0.25],
  'series b': [0.12, 0.2],
  later: [0.08, 0.15],
  unknown: [0.1, 0.25],
};

/**
 * Instruments that make dilution math meaningless.
 *
 * A SAFT or token sale does not buy equity, so "raise ÷ dilution" describes
 * nothing. Matching is on the instrument words rather than on crypto topicality
 * generally: an equity-funded company that merely works on blockchain should
 * still get an estimate, while a token raise should not.
 */
const NON_EQUITY_RE = /\bsafts?\b|\btoken[- ](sale|round|based|raise|offering)\b|\bico\b/i;

/** Currency symbols we store at face value without converting. */
const NON_USD_RE = /[€£¥₹]/;

/**
 * What we can say about a company's valuation.
 *
 * `unknown` carries a reason so the report can explain the blank rather than
 * leaving the user wondering whether the app looked.
 */
export type Valuation =
  | { kind: 'reported'; fact: ValuationFact }
  | { kind: 'estimated'; estimate: ValuationEstimate }
  | { kind: 'unknown'; reason: string };

/** Everything the calculation needs. Narrow on purpose, so tests stay small. */
export type ValuationInput = Pick<Company, 'latestFunding' | 'evidence'> & {
  dossier?: Dossier | null;
};

/** Human label for a dilution band, e.g. "15–25%". */
function bandLabel([low, high]: readonly [number, number]): string {
  return `${Math.round(low * 100)}–${Math.round(high * 100)}%`;
}

/**
 * Pick the dilution band for a round label.
 *
 * Anything at Series C or beyond collapses into `later`; the distinctions past
 * that point are smaller than the band width, so pretending to resolve them
 * would be false precision.
 */
function bandFor(round: string | null): { key: string; band: readonly [number, number] } {
  const label = round?.trim().toLowerCase() ?? '';
  if (!label) return { key: 'unknown', band: DILUTION_BANDS.unknown! };

  if (/pre[- ]?seed/.test(label)) return { key: 'pre-seed', band: DILUTION_BANDS['pre-seed']! };
  if (/seed/.test(label)) return { key: 'seed', band: DILUTION_BANDS.seed! };
  if (/series\s*a/.test(label)) return { key: 'series a', band: DILUTION_BANDS['series a']! };
  if (/series\s*b/.test(label)) return { key: 'series b', band: DILUTION_BANDS['series b']! };
  if (/series\s*[c-j]/.test(label)) return { key: 'later', band: DILUTION_BANDS.later! };

  // A label we do not recognise ("Growth", "Bridge") tells us less than nothing
  // about dilution, so fall back to the widest band rather than guessing.
  return { key: 'unknown', band: DILUTION_BANDS.unknown! };
}

/**
 * Recover a round label from the dossier when the merged record lacks one.
 *
 * Only accepted when the historical round's amount matches the raise we are
 * pricing exactly. Without that check we would happily label a Series B raise
 * "Series A" because that was the newest round the press had written up, and
 * then print the wrong label inside `method`.
 */
function roundFromDossier(input: ValuationInput): string | null {
  const amount = input.latestFunding?.amountUsd;
  if (amount == null) return null;
  const match = input.dossier?.fundingHistory?.find((r) => r.amountUsd === amount && r.round);
  return match?.round ?? null;
}

/** Signals that weaken an estimate without invalidating it. */
function caveatsFor(input: ValuationInput, roundKnown: boolean): string[] {
  const caveats: string[] = [];
  const funding = input.latestFunding;
  const evidence = input.evidence.join('\n');

  if (funding?.source === 'edgar') {
    // merge.ts prefers totalAmountSold over totalOfferingAmount, so a round
    // still filling reports only what has been wired so far — which makes the
    // raise, and therefore this estimate, a floor rather than a midpoint.
    caveats.push('Form D reports capital sold so far, so a round still closing understates the raise.');
  }
  if (/Form D\/A amendment/i.test(evidence)) {
    caveats.push('Amended filing — the amount may be a cumulative total across several closes.');
  }
  if (NON_USD_RE.test(evidence)) {
    caveats.push('Raise was reported in a non-USD currency and is stored unconverted, so this range is in that currency.');
  }
  if (!roundKnown) {
    caveats.push('No round label, so the widest dilution band applies.');
  }
  return caveats;
}

/**
 * Resolve the best valuation available for a company.
 *
 * A reported figure always wins: it is someone's actual knowledge of the cap
 * table, where the estimate is a convention applied to one number.
 */
export function resolveValuation(input: ValuationInput): Valuation {
  const reported = input.dossier?.valuation;
  // The schema requires a sourceUrl, but dossiers written by older code are read
  // back without revalidation, so an unattributed figure can still reach here.
  // Drop it rather than print a valuation nobody can check.
  if (reported && reported.sourceUrl) return { kind: 'reported', fact: reported };

  const funding = input.latestFunding;
  const raise = funding?.amountUsd ?? null;
  if (raise == null || raise <= 0) {
    return { kind: 'unknown', reason: 'no disclosed raise to derive from' };
  }

  // Check the dossier prose too: the instrument is usually named there rather
  // than in a headline.
  const haystack = [...input.evidence, input.dossier?.funding ?? '', input.dossier?.summary ?? ''].join('\n');
  if (NON_EQUITY_RE.test(haystack)) {
    return { kind: 'unknown', reason: 'token/SAFT raise — equity dilution math does not apply' };
  }

  const round = funding?.round ?? roundFromDossier(input);
  const { key, band } = bandFor(round);
  const [lowDilution, highDilution] = band;

  // Selling less of the company for the same money implies it is worth more,
  // so the low dilution bound produces the high valuation bound.
  return {
    kind: 'estimated',
    estimate: {
      lowUsd: raise / highDilution,
      highUsd: raise / lowDilution,
      method: `${formatUsd(raise)} raise ÷ ${bandLabel(band)} dilution (${key === 'unknown' ? 'stage unknown' : key})`,
      caveats: caveatsFor(input, key !== 'unknown'),
    },
  };
}

/** The bare range, e.g. "~$77.2M–$128.7M". */
export function valuationRange(estimate: ValuationEstimate): string {
  return `~${formatUsd(estimate.lowUsd)}–${formatUsd(estimate.highUsd)}`;
}

/**
 * One-line label for tables. Estimates always carry `~` and `est.` so a sorted
 * column can never disguise a derived range as a reported number.
 *
 * Use {@link valuationRange} where surrounding prose already says "estimated" —
 * the `est.` suffix is for columns that have no room to explain themselves.
 */
export function valuationLabel(valuation: Valuation): string {
  switch (valuation.kind) {
    case 'reported':
      return formatUsd(valuation.fact.amountUsd);
    case 'estimated':
      return `${valuationRange(valuation.estimate)} est.`;
    case 'unknown':
      return '—';
  }
}

/** Midpoint for sorting. Estimates sort on the middle of their range. */
export function valuationSortValue(valuation: Valuation): number {
  switch (valuation.kind) {
    case 'reported':
      return valuation.fact.amountUsd;
    case 'estimated':
      return (valuation.estimate.lowUsd + valuation.estimate.highUsd) / 2;
    case 'unknown':
      return 0;
  }
}
