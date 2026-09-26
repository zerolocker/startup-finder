/**
 * Pictures for the dashboard: each company's own homepage, read for the image
 * it shares on social media, its icon, and any demo video it embeds.
 *
 * Free — no LLM, one cached GET per company — and scraped rather than asked
 * for. A model asked for an image URL writes a plausible one, and a picture of
 * the wrong thing is worse than none (CLAUDE.md, rule 1). The homepage itself
 * is the researched one, and only when research was confident who the company
 * is; see pickHomepage.
 */

import type { CompanyMedia, RunCompany } from '../types.ts';
import { BROWSER_USER_AGENT, fetchText, mapWithConcurrency, warmUrl } from '../util/http.ts';
import { log } from '../util/log.ts';
// Shared with the dashboard, so both agree on which link is the homepage.
import { pickHomepage, screenshotUrl } from '../report/web/model.js';

/** Attributes of one HTML start tag, names lowercased, entities decoded. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/gi, '/');
}

/** Absolute https URL, or null. Relative paths resolve against the page. */
function absolute(raw: string | undefined, base: string): string | null {
  if (!raw || raw.startsWith('data:')) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // The dashboard is served over https, where an http image is blocked.
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

const VIDEO_PATTERNS: [RegExp, (id: string) => string][] = [
  [/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s]*&(?:amp;)?)?v=|shorts\/)([\w-]{11})/, (id) => `https://www.youtube.com/watch?v=${id}`],
  [/youtu\.be\/([\w-]{11})/, (id) => `https://www.youtube.com/watch?v=${id}`],
  [/player\.vimeo\.com\/video\/(\d+)/, (id) => `https://vimeo.com/${id}`],
  [/(?<!player\.)vimeo\.com\/(\d{6,})/, (id) => `https://vimeo.com/${id}`],
  [/loom\.com\/(?:share|embed)\/([0-9a-f]{32})/, (id) => `https://www.loom.com/share/${id}`],
  [/fast\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/(\w{10})/, (id) => `https://fast.wistia.net/embed/iframe/${id}`],
];

/** The first product video the page embeds or links, as a watch URL. */
function findVideo(html: string): string | null {
  let best: { at: number; url: string } | null = null;
  for (const [re, toUrl] of VIDEO_PATTERNS) {
    const m = re.exec(html);
    if (m && (!best || m.index < best.at)) best = { at: m.index, url: toUrl(m[1]!) };
  }
  return best?.url ?? null;
}

/** Largest declared size, e.g. "180x180" -> 180; "any" (SVG) sorts first. */
function iconSize(attrs: Record<string, string>): number {
  if (/\bany\b/i.test(attrs['sizes'] ?? '') || /svg/i.test(attrs['type'] ?? '') || /\.svg(\?|$)/i.test(attrs['href'] ?? '')) {
    return 1024;
  }
  const sizes = [...(attrs['sizes'] ?? '').matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1]));
  return sizes.length ? Math.max(...sizes) : 0;
}

/**
 * Read a homepage's HTML for its pictures. Pure, so it is tested on real
 * pages' markup without the network.
 */
export function extractMedia(html: string, pageUrl: string): Pick<CompanyMedia, 'image' | 'logo' | 'video'> {
  // Only the head carries the meta and link tags, and scanning a whole
  // multi-megabyte bundle with these regexes is slow for nothing.
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 200_000);

  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrsOf(m[0]));
  const meta = (...names: string[]): string | undefined => {
    for (const name of names) {
      const hit = metas.find((a) => (a['property'] ?? a['name'] ?? '').toLowerCase() === name && a['content']);
      if (hit) return hit['content'];
    }
    return undefined;
  };

  // Largest icon wins, and apple-touch-icon beats an icon of the same size:
  // it is drawn for a home screen, which is how the dashboard shows it.
  const icons = [...head.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => attrsOf(m[0]))
    .filter((a) => /(^|\s)(apple-touch-icon(-precomposed)?|icon)(\s|$)/i.test(a['rel'] ?? '') && a['href'])
    .map((a) => ({
      href: a['href']!,
      score: (/apple-touch/i.test(a['rel']!) ? Math.max(iconSize(a), 180) : iconSize(a)) + (/apple-touch/i.test(a['rel']!) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  // A bare favicon.ico is 16-32px: blurry at the size the page draws a logo,
  // and the favicon service fallback on the page does no worse.
  const icon = icons.find((i) => i.score >= 64);

  const video = meta('og:video:secure_url', 'og:video:url', 'og:video');
  return {
    image: absolute(meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), pageUrl),
    logo: absolute(icon?.href, pageUrl),
    video: (video && findVideo(video)) || findVideo(html),
  };
}

/**
 * Fill `media` for every assessed company that has not been looked at yet.
 * Idempotent: a company is visited once, and a failure is recorded as a
 * homepage with no pictures rather than retried every run.
 */
export async function enrichMedia(companies: readonly RunCompany[]): Promise<{ companies: RunCompany[]; visited: number }> {
  const targets = companies.filter((c) => c.assessment && c.media === undefined);
  if (targets.length === 0) return { companies: [...companies], visited: 0 };

  const found = new Map<string, CompanyMedia | null>();
  await mapWithConcurrency(targets, 6, async (c) => {
    const homepage = pickHomepage(c.assessment) as string | null;
    if (!homepage) {
      found.set(c.id, null);
      return;
    }
    let media: CompanyMedia = { homepage, image: null, logo: null, video: null, fetchedAt: new Date().toISOString() };
    try {
      const html = await fetchText(homepage, {
        userAgent: BROWSER_USER_AGENT,
        cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
        retries: 2,
        timeoutMs: 15_000,
      });
      media = { ...media, ...extractMedia(html, homepage) };
    } catch (err) {
      log.debug(`media: ${homepage} unreadable`, String(err));
    }
    // The page falls back to a screenshot when there is no shared image, and
    // the service renders on first request — so make that request now, not
    // when someone is waiting on a phone.
    if (!media.image) await warmUrl(screenshotUrl(homepage) as string);
    found.set(c.id, media);
  });

  const withImage = [...found.values()].filter((m) => m?.image).length;
  const withVideo = [...found.values()].filter((m) => m?.video).length;
  log.info(`Media: ${found.size} companies looked at, ${withImage} with a picture, ${withVideo} with a video`);
  return {
    companies: companies.map((c) => (found.has(c.id) ? { ...c, media: found.get(c.id)! } : c)),
    visited: found.size,
  };
}
