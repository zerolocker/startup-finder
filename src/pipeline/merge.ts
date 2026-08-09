/**
 * Merge source records (Form D filings + news items) into Company records.
 *
 * The hard part is deciding when two records describe the same company.
 * We match on the *normalized* name only, and only on an exact match — see
 * shouldMerge() for why fuzzy matching is deliberately avoided.
 */

import type { Company, FormDFiling, FundingEvent, NewsItem, SourceRef } from '../types.ts';
import { extractHeadlineFacts } from '../sources/news.ts';
import { normalizeName, slugify, truncate } from '../util/text.ts';
import { log } from '../util/log.ts';

/**
 * Should a news item with this extracted name merge into this company?
 *
 * Exact normalized-name equality only. Fuzzy matching (edit distance, token
 * overlap) was considered and rejected: startup names are short, and short
 * strings collide constantly — "Ramp" / "Rampt", "Vercel" / "Vercelo". A wrong
 * merge silently fabricates a company record that mixes two firms' funding and
 * people, which is much worse than the duplicate record you get from a miss.
 *
 * A future agent wanting better recall should add *aliases* (a curated
 * name -> canonical-id map in config/) rather than loosening this comparison.
 */
export function shouldMerge(newsCompanyName: string, company: Company): boolean {
  const normalized = normalizeName(newsCompanyName);
  if (normalized.length < 3) return false; // "AI", "Go" — too generic to trust
  return normalized === company.normalizedName;
}

/** Best available date for a filing: first sale beats filing date. */
function fundingDate(filing: FormDFiling): string {
  return filing.dateOfFirstSale ?? filing.filedDate;
}

/**
 * Amount actually raised. `totalAmountSold` is what investors have wired;
 * `totalOfferingAmount` is what the company hopes to raise. For "did they get
 * funded", sold is the honest number — but a fresh filing often shows sold=0
 * with a large offering, so fall back rather than reporting nothing.
 */
function fundingAmount(filing: FormDFiling): number | null {
  if (filing.totalAmountSold != null && filing.totalAmountSold > 0) return filing.totalAmountSold;
  if (filing.totalOfferingAmount != null && filing.totalOfferingAmount > 0) return filing.totalOfferingAmount;
  return null;
}

function locationOf(filing: FormDFiling): string | null {
  if (!filing.address) return null;
  return [filing.address.city, filing.address.state].filter(Boolean).join(', ') || null;
}

function companyFromFiling(filing: FormDFiling, now: string): Company {
  const event: FundingEvent = {
    date: fundingDate(filing),
    amountUsd: fundingAmount(filing),
    round: null, // Form D never states a round label
    investors: [],
    source: 'edgar',
    sourceUrl: filing.filingUrl,
  };

  const evidence: string[] = [];
  if (filing.industryGroup) evidence.push(`SEC industry: ${filing.industryGroup}`);
  if (filing.revenueRange && filing.revenueRange !== 'Decline to Disclose') {
    evidence.push(`Revenue range: ${filing.revenueRange}`);
  }
  if (filing.investorCount != null) evidence.push(`${filing.investorCount} investors in this round`);
  if (filing.isAmendment) evidence.push('Form D/A amendment (follow-on close)');

  return {
    id: slugify(filing.entityName),
    name: filing.entityName,
    normalizedName: normalizeName(filing.entityName),
    sources: [{ kind: 'edgar', ref: filing.accessionNumber, url: filing.filingUrl }],
    latestFunding: event,
    fundingEvents: [event],
    location: locationOf(filing),
    people: filing.relatedPersons,
    evidence,
    firstSeenAt: now,
    lastUpdatedAt: now,
  };
}

function companyFromNews(name: string, item: NewsItem, now: string): Company {
  const facts = extractHeadlineFacts(item.title);
  const event: FundingEvent = {
    date: item.publishedAt.slice(0, 10),
    amountUsd: facts.amountUsd,
    round: facts.round,
    investors: [],
    source: 'news',
    sourceUrl: item.url,
  };
  return {
    id: slugify(name),
    name,
    normalizedName: normalizeName(name),
    sources: [{ kind: 'news', ref: item.id, url: item.url }],
    latestFunding: event,
    fundingEvents: [event],
    location: null,
    people: [],
    evidence: [`Headline: ${item.title}`, ...(item.summary ? [`Summary: ${truncate(item.summary, 400)}`] : [])],
    firstSeenAt: now,
    lastUpdatedAt: now,
  };
}

/** Add a filing's data to an existing company record, in place. */
function absorbFiling(company: Company, filing: FormDFiling, now: string): void {
  if (company.sources.some((s) => s.kind === 'edgar' && s.ref === filing.accessionNumber)) return;

  company.sources.push({ kind: 'edgar', ref: filing.accessionNumber, url: filing.filingUrl });
  company.fundingEvents.push({
    date: fundingDate(filing),
    amountUsd: fundingAmount(filing),
    round: null,
    investors: [],
    source: 'edgar',
    sourceUrl: filing.filingUrl,
  });
  company.location ??= locationOf(filing);

  // Union of people, deduped by name.
  const seen = new Set(company.people.map((p) => p.name.toLowerCase()));
  for (const person of filing.relatedPersons) {
    if (!seen.has(person.name.toLowerCase())) {
      company.people.push(person);
      seen.add(person.name.toLowerCase());
    }
  }
  if (filing.industryGroup) {
    const line = `SEC industry: ${filing.industryGroup}`;
    if (!company.evidence.includes(line)) company.evidence.push(line);
  }
  company.lastUpdatedAt = now;
}

function absorbNews(company: Company, item: NewsItem, now: string): void {
  if (company.sources.some((s) => s.kind === 'news' && s.ref === item.id)) return;

  const facts = extractHeadlineFacts(item.title);
  company.sources.push({ kind: 'news', ref: item.id, url: item.url });
  company.fundingEvents.push({
    date: item.publishedAt.slice(0, 10),
    amountUsd: facts.amountUsd,
    round: facts.round,
    investors: [],
    source: 'news',
    sourceUrl: item.url,
  });
  company.evidence.push(`Headline: ${item.title}`);
  company.lastUpdatedAt = now;
}

export interface MergeResult {
  companies: Company[];
  stats: { fromEdgar: number; fromNews: number; newsMerged: number; newsUnmatched: number };
}

/**
 * Build the company set.
 *
 * EDGAR filings are processed first so they define the canonical records; news
 * then either enriches a known company or creates a new one (which is how
 * non-US rounds, absent from Form D entirely, enter the pipeline).
 *
 * @param existing previously-known companies, so firstSeenAt survives reruns.
 */
export function mergeSources(
  filings: readonly FormDFiling[],
  news: readonly NewsItem[],
  existing: readonly Company[] = [],
): MergeResult {
  const now = new Date().toISOString();
  const byId = new Map<string, Company>();
  const byNormalized = new Map<string, Company>();

  for (const company of existing) {
    byId.set(company.id, company);
    byNormalized.set(company.normalizedName, company);
  }

  let fromEdgar = 0;
  for (const filing of filings) {
    const id = slugify(filing.entityName);
    const found = byId.get(id);
    if (found) {
      absorbFiling(found, filing, now);
    } else {
      const company = companyFromFiling(filing, now);
      byId.set(company.id, company);
      byNormalized.set(company.normalizedName, company);
      fromEdgar++;
    }
  }

  let newsMerged = 0;
  let newsUnmatched = 0;
  let fromNews = 0;

  for (const item of news) {
    const facts = extractHeadlineFacts(item.title);
    if (!facts.company) {
      newsUnmatched++;
      continue;
    }
    const normalized = normalizeName(facts.company);
    const match = byNormalized.get(normalized);

    if (match && shouldMerge(facts.company, match)) {
      absorbNews(match, item, now);
      newsMerged++;
    } else {
      const company = companyFromNews(facts.company, item, now);
      // Two headlines about the same company in one run.
      const dupe = byId.get(company.id);
      if (dupe) {
        absorbNews(dupe, item, now);
        newsMerged++;
      } else {
        byId.set(company.id, company);
        byNormalized.set(company.normalizedName, company);
        fromNews++;
      }
    }
  }

  // Newest funding first, so latestFunding is unambiguous.
  const companies = [...byId.values()];
  for (const company of companies) {
    company.fundingEvents.sort((a, b) => b.date.localeCompare(a.date));
    company.latestFunding = company.fundingEvents[0] ?? null;
  }

  log.info(
    `Merged: ${companies.length} companies (${fromEdgar} new from EDGAR, ${fromNews} new from news, ${newsMerged} news items enriched existing)`,
  );

  return { companies, stats: { fromEdgar, fromNews, newsMerged, newsUnmatched } };
}
