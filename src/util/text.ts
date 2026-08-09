/** Text normalization helpers, mostly in service of matching company names. */

import { createHash } from 'node:crypto';

/** Legal suffixes that carry no identity and only hurt name matching. */
const LEGAL_SUFFIXES = [
  'incorporated', 'inc', 'llc', 'l l c', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'lp', 'l p', 'llp', 'plc', 'gmbh', 'sa', 'ag', 'bv', 'nv',
  'pbc', 'holdings', 'holding', 'group', 'technologies', 'technology', 'labs',
  'the',
];

/**
 * Reduce a company name to a comparable form.
 *
 * "Flo Artificial Intelligence, Inc." -> "flo artificial intelligence"
 *
 * Deliberately conservative: it strips punctuation and legal suffixes but does
 * NOT stem or fuzzy-match, because collapsing distinct startups into one record
 * is far worse than keeping two records for the same company.
 */
export function normalizeName(raw: string): string {
  let s = raw.toLowerCase();
  // Strip anything parenthesized — usually "(formerly X)" or a CIK.
  s = s.replace(/\([^)]*\)/g, ' ');
  // Punctuation to spaces, but keep intra-word digits (e.g. "x1").
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** URL-and-filename-safe id derived from a name. */
export function slugify(raw: string): string {
  const s = normalizeName(raw).replace(/\s+/g, '-');
  return s || createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

/** Short stable hash, used for deduping news items by URL. */
export function hashId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/** Strip HTML tags and decode the handful of entities RSS feeds actually use. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "$12.5M" style formatting for reports. `null` renders as "undisclosed". */
export function formatUsd(amount: number | null | undefined): string {
  if (amount == null) return 'undisclosed';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}

/** Truncate on a word boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, s.lastIndexOf(' ', max) || max).trimEnd()}…`;
}
