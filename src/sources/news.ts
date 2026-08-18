/**
 * Funding-news ingestion from RSS/Atom feeds.
 *
 * News is the complement to EDGAR (src/sources/edgar.ts). Where Form D is
 * comprehensive but says nothing about *what a company does*, news is
 * selective but rich: round labels, investor names, and a sentence of context.
 *
 * News alone would be a bad spine — it is biased toward companies that already
 * have PR, which is close to the opposite of the "find it before everyone
 * else" goal. It earns its place by enriching EDGAR rows and by catching
 * non-US rounds, which never appear in Form D at all.
 */

import { XMLParser } from 'fast-xml-parser';
import type { NewsItem } from '../types.ts';
import { BROWSER_USER_AGENT, fetchText, mapWithConcurrency } from '../util/http.ts';
import { hashId, stripHtml } from '../util/text.ts';
import { log } from '../util/log.ts';

export interface Feed {
  slug: string;
  url: string;
  /** Shown in reports. */
  label: string;
  /**
   * If true, every item is assumed funding-related and skips the keyword gate.
   * Use for feeds that are exclusively funding announcements.
   */
  allFunding?: boolean;
}

/**
 * The feed list. All of these were verified reachable when added; a feed that
 * starts failing is logged and skipped rather than failing the run, because
 * publishers change or block feed URLs regularly.
 *
 * Adding a feed is the cheapest way to widen coverage — see docs/DATA_SOURCES.md.
 */
export const FEEDS: Feed[] = [
  { slug: 'techcrunch-venture', url: 'https://techcrunch.com/category/venture/feed/', label: 'TechCrunch Venture' },
  { slug: 'techcrunch-startups', url: 'https://techcrunch.com/category/startups/feed/', label: 'TechCrunch Startups' },
  { slug: 'crunchbase-news', url: 'https://news.crunchbase.com/feed/', label: 'Crunchbase News' },
  { slug: 'venturebeat', url: 'https://venturebeat.com/feed/', label: 'VentureBeat' },
  { slug: 'tech-eu', url: 'https://tech.eu/feed/', label: 'Tech.eu' },
  { slug: 'eu-startups', url: 'https://www.eu-startups.com/feed/', label: 'EU-Startups' },
  { slug: 'sifted', url: 'https://sifted.eu/feed', label: 'Sifted' },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

/** Headline/summary words that indicate a funding event. */
const FUNDING_KEYWORDS =
  /\b(raise[sd]?|raising|funding|funded|secures?|secured|closes?|closed|lands?|landed|nets?|netted|bags?|snags?|seed round|series\s+[a-j]\b|pre-seed|pre-series|led by|round|valuation|investment|backs?|backed)\b/i;

/** Money in a headline: "$20M", "$1.2 billion", "€15M", "£4m". */
const AMOUNT_RE = /([$€£])\s?(\d+(?:[.,]\d+)?)\s*(k|m|b|bn|thousand|million|billion)?\b/i;

/** Round label: "Series A", "seed", "pre-seed", "Series B-1". */
const ROUND_RE = /\b(pre-seed|seed|series\s+[a-j](?:-\d)?|growth|bridge|extension)\b/i;

/**
 * Roundups, listicles, and market-summary pieces.
 *
 * These match every funding keyword but describe no single company, and the
 * headline parser will happily turn "July funding: European startups raised
 * €4B" into a company called "July funding: European startups". Filtering them
 * at ingest is much cleaner than trying to detect them downstream.
 */
const ROUNDUP_RE =
  /(round[- ]?up|weekly|monthly|this week|last week|biggest (funding )?rounds|top \d+|\d+ (startups|companies|deals|rounds)|here are|we tracked|in review|recap|newsletter|digest|briefing|^\w+ funding:)/i;

/**
 * A VC firm closing a *fund*, not a startup closing a *round*.
 *
 * These use identical vocabulary ("closes $250M", "raises $3B") but the
 * subject is an investor, so they produce a company record for a VC firm.
 * "White Star Capital closes $250M Fund IV" is the canonical example.
 */
const FUND_ANNOUNCEMENT_RE =
  /(\bfund\s+(i{1,3}|iv|v|vi{1,3}|ix|x{1,3}|\d+)\b|\b(new|debut|maiden|inaugural)\s+fund\b|\bclos(es|ed)\s+.{0,30}\bfund\b|\bto (back|invest in)\b.{0,40}\bstartups\b|\braises?\b.{0,30}\b(new capital|to invest)\b|\blaunches\b.{0,25}\b(fund|investment arm)\b)/i;

/**
 * A headline that *ends* on the word "fund" — "Accel raises $800m for ninth
 * early-stage Europe fund", "... raises enlarged $800M early-stage fund". Both
 * reached research in a real run and came back scored 3 and 5 as "not an
 * operating company" — the ordinal and adjectival forms miss every named
 * pattern above.
 *
 * Anchoring to the end keeps "Acme raises $5M to fund expansion" out, where
 * `fund` is the verb. The attribution guard below is the other half: a fund can
 * also end a headline as the *investor*, and dropping those loses real rounds.
 */
const FUND_TAIL_RE = /\bfunds?\s*$/i;

/**
 * "... backed by EU's Scaleup Fund", "... led by Foo Fund" — here the trailing
 * fund is who wrote the cheque, not what was raised. Without this,
 * "Lovable raises $400m backed by EU's Scaleup Fund" is discarded as a fund
 * announcement.
 */
const INVESTOR_ATTRIBUTION_RE = /\b(backed|led|supported|joined|co-led)\s+by\b|\bfrom\b/i;

/**
 * An M&A story, not a funding round.
 *
 * "SpaceX officially closes its Cursor acquisition" hits the funding
 * vocabulary on "closes", and the subject parser then invented a company
 * called "SpaceX officially" whose dossier came back describing Cursor — a
 * full research call spent on an entity that does not exist. Neither party
 * belongs in an issue: the acquirer is not raising, and the target is being
 * absorbed rather than hiring on new money.
 *
 * Only inflected forms count, for the same reason the subject parser rejects
 * bare stems: "Acme raises $5M to acquire rivals" is a funding headline, and
 * matching the bare infinitive would throw it away.
 */
const ACQUISITION_RE = /\b(acquisitions?|acquires|acquired|acqui-?hires?|takeover|merger|merges\s+with)\b/i;

/**
 * Verbs that open a clause the subject parser must stop at.
 *
 * Deliberately disjoint from the funding verbs: those already terminate the
 * subject, these are the ones a headline can slip in *before* them. Inflected
 * forms only, for the reason spelled out in extractHeadlineFacts — bare stems
 * like "plan", "target", and "eye" are ordinary nouns that appear in names.
 */
const CLAUSE_VERB_RE =
  /\b(confirms|confirmed|reveals|revealed|unveils|unveiled|hits|reaches|reached|tops|topped|eyes|plans|targets|weighs|becomes|became|acquires|acquired|buys|bought|sells|sold|says|said)\b/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Xml = Record<string, any>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    const o = node as Xml;
    if (typeof o['#text'] === 'string') return o['#text'];
  }
  return String(node);
}

/** Parse an RSS 2.0 or Atom document into NewsItems. */
export function parseFeed(xml: string, feed: Feed): NewsItem[] {
  const doc = parser.parse(xml) as Xml;
  const items: NewsItem[] = [];

  // --- RSS 2.0 ---
  for (const item of asArray(doc?.rss?.channel?.item)) {
    const url = textOf(item.link).trim();
    const title = stripHtml(textOf(item.title));
    if (!url || !title) continue;
    items.push({
      id: hashId(url),
      title,
      url,
      publishedAt: toIso(textOf(item.pubDate) || textOf(item['dc:date'])),
      source: feed.slug,
      summary: stripHtml(textOf(item.description) || textOf(item['content:encoded'])).slice(0, 1200),
    });
  }

  // --- Atom ---
  for (const entry of asArray(doc?.feed?.entry)) {
    const linkNode = asArray(entry.link).find((l: Xml) => !l?.['@_rel'] || l['@_rel'] === 'alternate') ?? entry.link;
    const url = String(linkNode?.['@_href'] ?? textOf(linkNode)).trim();
    const title = stripHtml(textOf(entry.title));
    if (!url || !title) continue;
    items.push({
      id: hashId(url),
      title,
      url,
      publishedAt: toIso(textOf(entry.published) || textOf(entry.updated)),
      source: feed.slug,
      summary: stripHtml(textOf(entry.summary) || textOf(entry.content)).slice(0, 1200),
    });
  }

  return items;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Does this item look like a funding announcement about ONE company?
 *
 * Roundups are rejected even on feeds marked `allFunding`, because the problem
 * with them is not relevance but that they have no single subject to extract.
 */
export function isFundingNews(item: NewsItem, feed: Feed): boolean {
  if (isRoundup(item.title) || isFundAnnouncement(item.title) || isAcquisition(item.title)) return false;
  if (feed.allFunding) return true;
  return FUNDING_KEYWORDS.test(item.title) || AMOUNT_RE.test(item.title);
}

/** True for listicles, weekly wraps, and market summaries. */
export function isRoundup(title: string): boolean {
  return ROUNDUP_RE.test(title);
}

/** True when the subject is a VC raising a fund rather than a startup raising a round. */
export function isFundAnnouncement(title: string): boolean {
  if (FUND_ANNOUNCEMENT_RE.test(title)) return true;
  return FUND_TAIL_RE.test(title) && !INVESTOR_ATTRIBUTION_RE.test(title);
}

/** True when the headline is about one company buying another, not raising. */
export function isAcquisition(title: string): boolean {
  return ACQUISITION_RE.test(title);
}

export interface HeadlineFacts {
  company: string | null;
  amountUsd: number | null;
  round: string | null;
}

/**
 * Pull company, amount, and round out of a headline with regexes.
 *
 * This is intentionally a cheap first pass, not the final word — the LLM stage
 * sees the full headline and can correct it. Getting ~70% right for free is
 * enough to make merging with EDGAR work, and costs nothing per item.
 *
 * Non-USD amounts are NOT converted; they are returned at face value, which is
 * close enough for bucketing and avoids a live FX dependency.
 */
export function extractHeadlineFacts(title: string): HeadlineFacts {
  const amountMatch = AMOUNT_RE.exec(title);
  let amountUsd: number | null = null;
  if (amountMatch) {
    const n = Number(amountMatch[2]?.replace(/,/g, '') ?? '');
    const unit = (amountMatch[3] ?? '').toLowerCase();
    const scale = unit.startsWith('b') ? 1e9 : unit.startsWith('m') ? 1e6 : unit.startsWith('k') || unit.startsWith('t') ? 1e3 : 1;
    if (Number.isFinite(n)) amountUsd = n * scale;
  }

  const roundMatch = ROUND_RE.exec(title);
  const round = roundMatch?.[1]
    ? roundMatch[1].replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  // The company is almost always the subject, i.e. the text before the verb.
  //
  // Only INFLECTED verb forms count ("raises"/"raised", never "raise"). The
  // bare stems are all common nouns or adjectives, and accepting them produced
  // three bogus companies on real headlines:
  //   "The browser is where attacks land."  -> "The browser is where attacks"
  //   "How to build secure ... AI"          -> "How to build"
  //   "QMUL spinouts looking to raise"      -> "QMUL spinouts looking to"
  // A genuine funding headline is always "X raises" or "X raised", so requiring
  // inflection costs nothing and removes the whole class.
  const verbMatch = /^(.*?)\s+\b(raises|raised|secures|secured|closes|closed|lands|landed|nets|netted|bags|snags|announces|announced|scores|picks up|pulls in|banks)\b/i.exec(
    title,
  );
  let company = verbMatch?.[1]?.trim() ?? null;

  // A headline can hang two clauses off one subject:
  //   "Lovable confirms new $13.3B valuation, raises another $400M"
  // The match above is non-greedy but "confirms" is not a funding verb, so it
  // runs on to "raises" and the subject swallows the whole first clause. That
  // produced a second company named "Lovable confirms new $13.3B valuation"
  // alongside the real "Lovable" — one story, two dossiers, twice the spend.
  // Cutting at the first clause verb restores the actual subject.
  if (company) {
    const clause = CLAUSE_VERB_RE.exec(company);
    // Index 0 means the "clause verb" *is* the subject — a company really named
    // Eyes or Targets. Cutting there would leave nothing, turning a rare name
    // into a rejection, so only cut when something precedes it.
    if (clause && clause.index > 0) company = company.slice(0, clause.index).trim();
  }
  if (company) company = cleanCompanyName(company);

  return { company, amountUsd, round };
}

/**
 * Strip the editorial scaffolding journalists wrap around company names.
 *
 * "Glasgow-based Mironid"    -> "Mironid"
 * "Chip startup Olix"        -> "Olix"
 * "Exclusive: Acme"          -> "Acme"
 * "London’s Safehire.ai"     -> "Safehire.ai"
 * "OpenAI-backed Thrive"     -> "Thrive"
 * "ETH Zurich spin-off Aisot" -> "Aisot"
 *
 * Returns null when what's left is not plausibly a name, which is better than
 * emitting a garbage name that then fails to match anything in EDGAR.
 */
export function cleanCompanyName(raw: string): string | null {
  let company = raw;

  // A headline opening with a quotation mark is an interview or a pull-quote,
  // never a funding announcement subject.
  if (/^[“”"‘’']/.test(company.trim())) return null;

  // "Exclusive: ...", "Breaking — ..."
  company = company.replace(/^(exclusive|breaking|report|update|opinion)\s*[:—–-]\s*/i, '');
  // Possessive locality: "London's Safehire.ai", "Berlin’s Foo"
  company = company.replace(/^[A-Z][\w.-]+(?:’|')s\s+/, '');
  // Hyphenated locality: "Glasgow-based Mironid", "SF-based Acme"
  company = company.replace(/^[\w.'-]+[- ]based\s+/i, '');
  // Investor attribution: "OpenAI-backed Thrive Holdings", "a16z-backed Foo".
  // The backer is not the subject, and leaving it on splits one company across
  // two records the next time the same startup is written up without it.
  company = company.replace(/^[\w.&'-]+[- ]backed\s+/i, '');
  // Descriptor nouns: "Chip startup Olix", "Defense tech Hadrian", "AI company Foo",
  // "ETH Zurich spin-off Aisot Technologies"
  company = company.replace(
    /^(?:[\w.&-]+\s+){0,3}?\b(startup|scaleup|company|firm|platform|maker|developer|provider|unicorn|venture|tech|spin-?offs?|spin-?outs?)\s+/i,
    '',
  );
  company = company.trim().replace(/^[,\-–—:]+|[,\-–—:]+$/g, '').trim();

  if (!company) return null;

  // A subject made only of category words names no company — the headline left
  // the name to the article body. "Edtech platform raises $4.5M" is real news
  // about a real company, but "Edtech platform" is not its name.
  const CATEGORY_WORDS =
    /^(edtech|fintech|healthtech|insurtech|proptech|adtech|legaltech|deeptech|biotech|climatetech|agritech|foodtech|regtech|martech|hrtech|ai|ml|saas|b2b|b2c|platform|startup|scaleup|company|firm|app|tool|service|marketplace|network|group|studio|lab|labs|maker|provider|developer|business|venture|tech)$/i;
  if (company.split(/\s+/).every((w) => CATEGORY_WORDS.test(w.replace(/[^\w]/g, '')))) return null;

  // A subject ending in a function word is a truncated clause, not a name:
  // "QMUL spinouts looking to".
  if (/\b(to|for|in|on|at|by|of|with|and|or|from|as|into)$/i.test(company)) return null;

  // A possessive that survived the prefix strip means the subject is a person
  // or a description, not a name: "Travis Kalanick's robotics company".
  if (/(?:’|')s\s/.test(company)) return null;

  // Ending in a generic noun means we captured a description, not a name
  // ("Travis Kalanick's robotics company").
  if (/\b(company|startup|firm|investor|business)$/i.test(company)) return null;

  // A role noun ANYWHERE means the subject is a person, not a company:
  // "Repeat founder Ryan Williams", "Ex-Google engineer Jane Doe". The noun
  // sits mid-string here, so a trailing-only check does not catch it.
  if (/\b(founders?|co-?founders?|ceo|cto|coo|cfo|exec(utive)?s?|engineers?|veterans?|alumni?|boss|chief)\b/i.test(company)) {
    return null;
  }

  // Ending in an investor-firm noun means this is a VC, not a portfolio company.
  if (/\b(capital|ventures?|partners|fund|management)$/i.test(company)) return null;

  // An "X backer Y" construction names the investor, not the startup:
  // "Monzo and Lovable backer Accel raises enlarged $800M early-stage fund".
  // The noun sits mid-string, so the trailing check above does not see it.
  if (/\bbackers?\b/i.test(company)) return null;

  // A money figure inside the subject means a clause was captured rather than
  // a name — no company is called "... $13.3B valuation". This backstops the
  // clause-verb cut in extractHeadlineFacts for phrasings it does not know.
  if (AMOUNT_RE.test(company)) return null;

  // A "subject" longer than ~5 words is a sentence fragment, not a name.
  if (company.split(/\s+/).length > 5) return null;
  // Needs at least one capitalized token or a dotted domain to be a name.
  if (!/[A-Z]/.test(company) && !/\.\w{2,}/.test(company)) return null;

  return company;
}

export interface NewsIngestResult {
  items: NewsItem[];
  stats: { fetched: number; funding: number; perFeed: Record<string, number>; failed: string[] };
}

/** Fetch every feed and return the items that look like funding news. */
export async function ingestNews(feeds: readonly Feed[] = FEEDS): Promise<NewsIngestResult> {
  const perFeed: Record<string, number> = {};
  const failed: string[] = [];
  let fetched = 0;
  const items: NewsItem[] = [];

  await mapWithConcurrency(feeds, 4, async (feed) => {
    try {
      // Feeds update constantly; a short TTL keeps reruns cheap but fresh.
      const xml = await fetchText(feed.url, { userAgent: BROWSER_USER_AGENT, cacheTtlMs: 60 * 60 * 1000 });
      const parsed = parseFeed(xml, feed);
      fetched += parsed.length;
      const funding = parsed.filter((item) => isFundingNews(item, feed));
      perFeed[feed.slug] = funding.length;
      items.push(...funding);
      log.debug(`${feed.slug}: ${funding.length}/${parsed.length} funding items`);
    } catch (err) {
      // One dead feed must not fail the run.
      failed.push(feed.slug);
      log.warn(`feed ${feed.slug} failed, skipping`, String(err));
    }
  });

  // Dedupe across feeds that syndicate the same story.
  const byId = new Map<string, NewsItem>();
  for (const item of items) byId.set(item.id, item);
  const unique = [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  log.info(`News: ${unique.length} funding items from ${feeds.length - failed.length} feeds`);
  return { items: unique, stats: { fetched, funding: unique.length, perFeed, failed } };
}
