/**
 * SEC EDGAR Form D ingestion.
 *
 * Form D is the closest thing to a free, complete, structured registry of US
 * private fundraising. Almost every company raising under Reg D must file one
 * within 15 days of first sale. That makes it our *spine*: comprehensive and
 * unbiased, unlike tech press, which only covers what it finds interesting.
 *
 * The catch: Form D says nothing about round labels ("Series A"), investors,
 * valuation, or what the company actually does. It gives you a name, a dollar
 * amount, a coarse industry bucket, and the officers. Everything else has to
 * come from news (src/sources/news.ts) or research (src/pipeline/research.ts).
 *
 * The other catch: most Form D filers are not startups. On a typical day ~150
 * Form Ds are filed and the large majority are pooled investment funds, real
 * estate SPVs, and co-investment vehicles. Filtering those out is most of the
 * work here — see isLikelyOperatingStartup().
 */

import { XMLParser } from 'fast-xml-parser';
import type { Address, FormDFiling, RelatedPerson } from '../types.ts';
import { fetchText, mapWithConcurrency, SEC_USER_AGENT } from '../util/http.ts';
import { log } from '../util/log.ts';

const ARCHIVES = 'https://www.sec.gov/Archives';

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep everything as strings; we coerce deliberately
  trimValues: true,
});

// ---------------------------------------------------------------------------
// Filtering: which Form D filers are plausibly operating startups
// ---------------------------------------------------------------------------

/**
 * Compare industries on a canonical form.
 *
 * EDGAR spells these with the word "and" — "Oil and Gas", "REITS and Finance" —
 * while this list was written with ampersands, so those two exclusions never
 * fired and their filings were researched at ~$0.28 each. Normalizing both
 * sides fixes the pair that was caught and the ones that were not yet:
 * "Airlines & Airports" and "Lodging & Conventions" have the same shape.
 */
const canonicalIndustry = (s: string): string =>
  s.toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();

/**
 * Industry buckets that are essentially never an operating tech startup.
 * Form D's taxonomy is coarse, so this is the single most effective filter.
 */
const EXCLUDED_INDUSTRIES = new Set([
  'Pooled Investment Fund',
  'Commercial',
  'Construction',
  'REITS & Finance',
  'Residential',
  'Other Real Estate',
  'Oil & Gas',
  'Coal Mining',
  'Agriculture',
  'Investing',
  'Investment Banking',
  'Commercial Banking',
  'Insurance',
  'Airlines & Airports',
  'Lodging & Conventions',
  'Restaurants',
].map(canonicalIndustry));

/** Industries that make a Limited Partnership look like a fund, not a business. */
const FUND_LIKE_INDUSTRIES = new Set([
  'Pooled Investment Fund',
  'Investing',
  'Investment Banking',
  'Other Real Estate',
  'Residential',
  'Commercial',
  'REITS & Finance',
  'Other Banking and Financial Services',
].map(canonicalIndustry));

/**
 * Name patterns for investment vehicles. These are matched against the raw
 * entity name. Tuned to be specific: "Capital" alone would wrongly drop real
 * startups (e.g. "Capital One"), so it only counts alongside fund-ish context.
 */
const FUND_NAME_PATTERNS: RegExp[] = [
  /\b(fund|funds)\b/i,
  /\bco[- ]?invest(ment|ors)?\b/i,
  /\bspv\b/i,
  /\binvestors?,?\s*(llc|lp|l\.p\.|inc)?\s*$/i,
  /\bpartners,?\s*(l\.?p\.?|llc)?\s*$/i,
  /\bcapital\s+(partners|management|group|fund)/i,
  /\bventures?\s+(i{1,3}|iv|v|vi{1,3}|ix|x{1,3}|\d+)\b/i,
  /\bseries\s+[a-z0-9]{1,4}\s*$/i,
  /\ba series of\b/i, // "Chapul II, a series of Capitalize Investments LLC"
  /\bfeeder\b/i,
  /\btrust\b/i,
  /\bholdings?\s+(l\.?p\.?|llc)\s*$/i,
  /\bopportunit(y|ies)\s+(fund|lp|llc)/i,
  /\breal\s+estate\b/i,
  /\bproperty\b/i,
  /\bapartments?\b/i,
  /\bmultifamily\b/i,
];

/**
 * Entity types that are never operating companies on their own.
 *
 * Measured: on a real day this rule was the *only* one that cost recall. An
 * audit re-judged all 175 filings the filter dropped and found exactly one real
 * company among them — `Vehlo Holdings, LP`, auto-repair payments software —
 * dropped for being an LP. The industry-code rules had a false-negative rate of
 * 0/160, because a filer's self-reported industry is structured data rather than
 * a guess about them.
 *
 * So an LP is only excluded when its industry *also* looks fund-like. A plain LP
 * in an operating industry now survives.
 */
const EXCLUDED_ENTITY_TYPES = new Set(['Limited Partnership']);

export interface FilterVerdict {
  keep: boolean;
  reason: string;
}

/**
 * Decide whether a parsed filing looks like an operating startup rather than an
 * investment vehicle.
 *
 * This is a heuristic and it is deliberately biased toward *exclusion*: a false
 * negative costs one missed company, while a false positive wastes an LLM call
 * and pollutes the report with real-estate SPVs. Adjust the patterns above if
 * you find it dropping things it shouldn't — and add a test case in
 * test/edgar.test.ts when you do.
 */
export function isLikelyOperatingStartup(filing: FormDFiling): FilterVerdict {
  if (filing.industryGroup && EXCLUDED_INDUSTRIES.has(canonicalIndustry(filing.industryGroup))) {
    return { keep: false, reason: `industry "${filing.industryGroup}" is an investment/real-asset bucket` };
  }
  if (
    filing.entityType &&
    EXCLUDED_ENTITY_TYPES.has(filing.entityType) &&
    // An LP alone is not evidence of a fund; an LP filing under a fund-ish or
    // unstated industry is. See the note on EXCLUDED_ENTITY_TYPES.
    (filing.industryGroup == null || FUND_LIKE_INDUSTRIES.has(canonicalIndustry(filing.industryGroup)))
  ) {
    return { keep: false, reason: `entity type "${filing.entityType}" with a fund-like industry` };
  }
  for (const pattern of FUND_NAME_PATTERNS) {
    if (pattern.test(filing.entityName)) {
      return { keep: false, reason: `name matches investment-vehicle pattern ${pattern}` };
    }
  }
  return { keep: true, reason: 'passes operating-company heuristics' };
}

// ---------------------------------------------------------------------------
// Daily index → filing references
// ---------------------------------------------------------------------------

export interface FilingRef {
  formType: string;
  companyName: string;
  cik: string;
  filedDate: string;
  /** Path like "edgar/data/1798621/0001798621-26-000003.txt". */
  path: string;
}

/** EDGAR publishes one index per business day, under the calendar quarter. */
function dailyIndexUrl(date: Date): string {
  const y = date.getUTCFullYear();
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  const stamp = `${y}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  return `${ARCHIVES}/edgar/daily-index/${y}/QTR${q}/form.${stamp}.idx`;
}

/**
 * Parse a form.idx file. It is fixed-width-ish but ragged, so we split on runs
 * of 2+ spaces rather than trusting column offsets, which have shifted before.
 */
export function parseFormIndex(text: string, formTypes: readonly string[]): FilingRef[] {
  const wanted = new Set(formTypes);
  const out: FilingRef[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('-') || line.startsWith(' ')) continue;
    const parts = line.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 5) continue;
    const [formType, companyName, cik, filedDate, path] = parts as [string, string, string, string, string];
    if (!wanted.has(formType)) continue;
    if (!/^\d{8}$/.test(filedDate)) continue;
    out.push({
      formType,
      companyName,
      cik,
      filedDate: `${filedDate.slice(0, 4)}-${filedDate.slice(4, 6)}-${filedDate.slice(6, 8)}`,
      path,
    });
  }
  return out;
}

/** Turn "edgar/data/1798621/0001798621-26-000003.txt" into the XML doc URL. */
export function primaryDocUrl(path: string): { url: string; accessionNumber: string } {
  const file = path.split('/').pop() ?? '';
  const accessionNumber = file.replace(/\.txt$/, '');
  const bare = accessionNumber.replace(/-/g, '');
  const cik = path.split('/')[2] ?? '';
  return { url: `${ARCHIVES}/edgar/data/${cik}/${bare}/primary_doc.xml`, accessionNumber };
}

/** Human-facing EDGAR page for a filing. */
function filingIndexUrl(cik: string, accessionNumber: string): string {
  const bare = accessionNumber.replace(/-/g, '');
  return `${ARCHIVES}/edgar/data/${cik}/${bare}/${accessionNumber}-index.htm`;
}

// ---------------------------------------------------------------------------
// XML → FormDFiling
// ---------------------------------------------------------------------------

/** fast-xml-parser gives a scalar for one child and an array for many. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Form D amounts are strings and may literally be "Indefinite" (open-ended
 * offerings). Treat anything non-numeric as unknown rather than 0 — a 0 would
 * silently rank a company as having raised nothing.
 */
function asAmount(value: unknown): number | null {
  const s = asString(value);
  if (s == null) return null;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Xml = Record<string, any>;

/** Parse a Form D primary_doc.xml into our domain shape. */
export function parseFormD(xml: string, ctx: { cik: string; filedDate: string; accessionNumber: string }): FormDFiling | null {
  const doc = parser.parse(xml) as Xml;
  const submission = doc?.edgarSubmission;
  if (!submission) return null;

  const issuer = submission.primaryIssuer ?? {};
  const offering = submission.offeringData ?? {};
  const amounts = offering.offeringSalesAmounts ?? {};
  const addr = issuer.issuerAddress ?? {};

  const entityName = asString(issuer.entityName);
  if (!entityName) return null;

  const relatedPersons: RelatedPerson[] = asArray(submission.relatedPersonsList?.relatedPersonInfo).map(
    (person: Xml) => {
      const n = person?.relatedPersonName ?? {};
      const name = [asString(n.firstName), asString(n.middleName), asString(n.lastName)]
        .filter(Boolean)
        .join(' ');
      return {
        name,
        relationships: asArray(person?.relatedPersonRelationshipList?.relationship).map(String),
      };
    },
  ).filter((p) => p.name !== '');

  const address: Address | null = asString(addr.city)
    ? {
        street: [asString(addr.street1), asString(addr.street2)].filter(Boolean).join(', ') || null,
        city: asString(addr.city),
        state: asString(addr.stateOrCountry),
        zip: asString(addr.zipCode),
      }
    : null;

  const isAmendment = String(offering.typeOfFiling?.newOrAmendment?.isAmendment ?? 'false') === 'true';

  return {
    cik: ctx.cik.padStart(10, '0'),
    accessionNumber: ctx.accessionNumber,
    entityName,
    filedDate: ctx.filedDate,
    dateOfFirstSale: asString(offering.typeOfFiling?.dateOfFirstSale?.value),
    industryGroup: asString(offering.industryGroup?.industryGroupType),
    totalOfferingAmount: asAmount(amounts.totalOfferingAmount),
    totalAmountSold: asAmount(amounts.totalAmountSold),
    totalRemaining: asAmount(amounts.totalRemaining),
    investorCount: asAmount(offering.investors?.totalNumberAlreadyInvested),
    isAmendment,
    jurisdictionOfIncorporation: asString(issuer.jurisdictionOfInc),
    entityType: asString(issuer.entityType),
    revenueRange: asString(issuer.issuerSize?.revenueRange),
    relatedPersons,
    address,
    filingUrl: filingIndexUrl(ctx.cik, ctx.accessionNumber),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on an automatic lookback. One HTTP request per filing, throttled
 * to ~8/s for the SEC, means ~160 filings/day of window — 90 days is already
 * ~30 minutes. Beyond that the user should decide deliberately.
 */
export const MAX_AUTO_LOOKBACK_DAYS = 90;

export interface LookbackDecision {
  days: number;
  /** Human-readable explanation, logged so coverage is never a mystery. */
  reason: string;
  /** True when the gap was larger than we are willing to fetch automatically. */
  clamped: boolean;
  /** Days of history that will NOT be fetched because of the clamp. */
  uncoveredDays: number;
}

/**
 * Choose the lookback window when the user did not pass `--days`.
 *
 * The window used to be a fixed N days back from *today*, which silently lost
 * everything between runs: run on day 1 and again on day 100 with the default
 * of 7, and days 2-93 were never fetched. For a tool meant to run like a
 * newsletter that is a real defect, and exactly the kind of loss the user
 * cannot detect from the output.
 *
 * So we derive the window from the newest filing already on disk. `filedDate`
 * is the day a filing appeared in EDGAR, so the newest one marks the last day
 * we successfully read an index — self-healing, and it needs no extra state
 * file that could drift from reality.
 *
 * @param latestFiledDate newest `filedDate` in data/filings.jsonl, or null on a
 *   first run.
 */
export function autoLookbackDays(
  latestFiledDate: string | null,
  now: Date = new Date(),
  opts: { defaultDays?: number; overlapDays?: number; maxDays?: number } = {},
): LookbackDecision {
  const { defaultDays = 7, overlapDays = 2, maxDays = MAX_AUTO_LOOKBACK_DAYS } = opts;

  const parsed = latestFiledDate ? Date.parse(`${latestFiledDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(parsed)) {
    return {
      days: defaultDays,
      reason: `no prior filings on disk — using the default ${defaultDays}-day window`,
      clamped: false,
      uncoveredDays: 0,
    };
  }

  const elapsed = Math.floor((now.getTime() - parsed) / (24 * 60 * 60 * 1000));
  // A couple of days of overlap: a day whose filings were all filtered out as
  // funds leaves no trace in filings.jsonl and would otherwise look "covered".
  const needed = Math.max(defaultDays, elapsed + overlapDays);

  if (needed > maxDays) {
    return {
      days: maxDays,
      reason: `last filing was ${elapsed} days ago; capped at ${maxDays} days`,
      clamped: true,
      uncoveredDays: needed - maxDays,
    };
  }

  return {
    days: needed,
    reason:
      elapsed <= 0
        ? `already current — using a ${needed}-day window`
        : `last filing was ${elapsed} days ago — widening the window to ${needed} days to close the gap`,
    clamped: false,
    uncoveredDays: 0,
  };
}

export interface EdgarIngestOptions {
  /** How many days back from today to scan. */
  days: number;
  /** Parallel primary_doc.xml fetches. Keep low — the SEC throttles hard. */
  concurrency?: number;
  /** Include Form D/A amendments (follow-on closes) as well as new Form Ds. */
  includeAmendments?: boolean;
}

export interface EdgarIngestResult {
  filings: FormDFiling[];
  /** Counts of what was dropped and why, so filtering stays debuggable. */
  stats: { indexRows: number; parsed: number; kept: number; dropped: Record<string, number> };
}

/**
 * The UTC dates a `--days N` window should scan, newest first.
 *
 * The window **ends yesterday, not today**. EDGAR publishes the daily index for
 * a filing day only after that day closes, so today's index does not exist for
 * essentially the whole of today — measured 2026-08-12 04:51 UTC, the indexes
 * for Aug 10 and Aug 11 were both up and Aug 12 was still absent.
 *
 * Counting today against the window made `--days N` quietly deliver N−1 usable
 * days, and `--days 1` deliver nothing at all. That is not a rounding error: a
 * run at 06:45 UTC with `--days 4` missed a full business day of 156 filings,
 * because the newest day it asked for had not been published yet.
 *
 * Yesterday is the right anchor but is not a guarantee either — before roughly
 * 03:00 UTC yesterday's index may also still be pending — so callers must keep
 * tolerating a missing day rather than treating it as an error.
 */
export function indexDatesFor(days: number, now: Date = new Date()): Date[] {
  const dates: Date[] = [];
  for (let i = 1; i <= days; i++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - i);
    dates.push(date);
  }
  return dates;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Fetch and parse recent Form D filings.
 *
 * Weekends and holidays have no index file; a 404 there is expected and skipped
 * rather than treated as an error.
 */
export async function ingestEdgar(opts: EdgarIngestOptions): Promise<EdgarIngestResult> {
  const { days, concurrency = 4, includeAmendments = true } = opts;
  const formTypes = includeAmendments ? ['D', 'D/A'] : ['D'];

  const dates = indexDatesFor(days);
  const refs: FilingRef[] = [];
  const missing: string[] = [];
  for (const date of dates) {
    const url = dailyIndexUrl(date);
    try {
      // Index files are immutable once published, so cache them for a week.
      const text = await fetchText(url, { userAgent: SEC_USER_AGENT, cacheTtlMs: 7 * 24 * 3600 * 1000 });
      const dayRefs = parseFormIndex(text, formTypes);
      refs.push(...dayRefs);
      log.debug(`${url.split('/').pop()}: ${dayRefs.length} Form D`);
    } catch (err) {
      missing.push(ymd(date));
      log.debug(`no index for ${ymd(date)} (weekend/holiday?)`, String(err));
    }
  }

  // Name the actual dates. "in the last N days" hid which days were really
  // read, which is how a missing business day went unnoticed.
  const oldest = dates[dates.length - 1];
  const newest = dates[0];
  const span = newest && oldest ? `${ymd(oldest)}..${ymd(newest)}` : 'no days';
  log.info(`EDGAR: ${refs.length} Form D filings across ${span} (${days} day window ending yesterday)`);
  // Otherwise this stage is ~a minute of silence, indistinguishable from a hang.
  if (refs.length > 0) {
    log.info(`Fetching ${refs.length} filing documents from the SEC — roughly ${Math.ceil(refs.length / 8)}s`);
  }
  if (missing.length > 0) {
    // Weekends dominate this list and are unremarkable; a weekday is not.
    const weekdays = missing.filter((d) => {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      return dow !== 0 && dow !== 6;
    });
    log.debug(`no index for ${missing.length} day(s): ${missing.join(', ')}`);
    if (weekdays.length > 0) {
      log.warn(
        `No SEC index for ${weekdays.length} weekday(s): ${weekdays.join(', ')}. ` +
          `Holiday, or not published yet — re-run later to pick them up.`,
      );
    }
  }

  const dropped: Record<string, number> = {};
  const kept: FormDFiling[] = [];
  let parsed = 0;
  let done = 0;

  await mapWithConcurrency(refs, concurrency, async (ref) => {
    const { url, accessionNumber } = primaryDocUrl(ref.path);
    try {
      const xml = await fetchText(url, { userAgent: SEC_USER_AGENT, cacheTtlMs: 30 * 24 * 3600 * 1000 });
      const filing = parseFormD(xml, { cik: ref.cik, filedDate: ref.filedDate, accessionNumber });
      if (!filing) {
        dropped['unparseable'] = (dropped['unparseable'] ?? 0) + 1;
        return;
      }
      parsed++;
      const verdict = isLikelyOperatingStartup(filing);
      if (verdict.keep) kept.push(filing);
      else {
        const bucket = verdict.reason.startsWith('industry')
          ? 'excluded industry'
          : verdict.reason.startsWith('entity type')
            ? 'fund entity type'
            : 'fund-like name';
        dropped[bucket] = (dropped[bucket] ?? 0) + 1;
      }
    } catch (err) {
      dropped['fetch failed'] = (dropped['fetch failed'] ?? 0) + 1;
      log.debug(`failed ${url}`, String(err));
    } finally {
      log.progress(`EDGAR ${++done}/${refs.length} filings`);
    }
  });
  log.progressDone();

  return { filings: kept, stats: { indexRows: refs.length, parsed, kept: kept.length, dropped } };
}
