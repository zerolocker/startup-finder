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
]);

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

/** Entity types that are essentially never a venture-backed operating company. */
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
  if (filing.industryGroup && EXCLUDED_INDUSTRIES.has(filing.industryGroup)) {
    return { keep: false, reason: `industry "${filing.industryGroup}" is an investment/real-asset bucket` };
  }
  if (filing.entityType && EXCLUDED_ENTITY_TYPES.has(filing.entityType)) {
    return { keep: false, reason: `entity type "${filing.entityType}" is a fund structure` };
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
 * Fetch and parse recent Form D filings.
 *
 * Weekends and holidays have no index file; a 404 there is expected and skipped
 * rather than treated as an error.
 */
export async function ingestEdgar(opts: EdgarIngestOptions): Promise<EdgarIngestResult> {
  const { days, concurrency = 4, includeAmendments = true } = opts;
  const formTypes = includeAmendments ? ['D', 'D/A'] : ['D'];

  const refs: FilingRef[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const url = dailyIndexUrl(date);
    try {
      // Index files are immutable once published, so cache them for a week.
      const text = await fetchText(url, { userAgent: SEC_USER_AGENT, cacheTtlMs: 7 * 24 * 3600 * 1000 });
      const dayRefs = parseFormIndex(text, formTypes);
      refs.push(...dayRefs);
      log.debug(`${url.split('/').pop()}: ${dayRefs.length} Form D`);
    } catch (err) {
      log.debug(`no index for ${date.toISOString().slice(0, 10)} (weekend/holiday?)`, String(err));
    }
  }

  log.info(`EDGAR: ${refs.length} Form D filings in the last ${days} days`);

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
