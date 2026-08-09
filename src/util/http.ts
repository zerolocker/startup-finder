/**
 * HTTP fetching with the three things every ingest here needs:
 * per-host rate limiting, retries with backoff, and an on-disk cache.
 *
 * The cache matters more than it looks. Re-running the pipeline while
 * developing would otherwise hammer sec.gov and get you blocked — and the SEC
 * blocks by IP, for 10 minutes, with no warning. Cached responses live under
 * data/cache/ and are gitignored.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashId } from './text.ts';
import { log } from './log.ts';
import { CACHE_DIR } from '../paths.ts';

/**
 * The SEC requires a descriptive User-Agent with contact info and throttles
 * above 10 req/s. We stay well under. Override the contact via SF_CONTACT.
 * https://www.sec.gov/os/webmaster-faq#developers
 */
export const SEC_USER_AGENT = `startup-finder/0.1 (${process.env.SF_CONTACT ?? 'startup-finder@example.com'})`;

/** Browser-ish UA. Some publisher CDNs 403 anything that looks scripted. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Minimum gap between requests to a given host, in ms. */
const HOST_DELAY_MS: Record<string, number> = {
  'www.sec.gov': 120,
  'data.sec.gov': 120,
  'efts.sec.gov': 120,
};
const DEFAULT_DELAY_MS = 200;

/** Serializes requests per host so the delay is actually respected. */
const hostQueues = new Map<string, Promise<unknown>>();

function throttle<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const delay = HOST_DELAY_MS[host] ?? DEFAULT_DELAY_MS;
  const prior = hostQueues.get(host) ?? Promise.resolve();
  const next = prior.then(async () => {
    const result = await fn();
    await new Promise((r) => setTimeout(r, delay));
    return result;
  });
  // Keep the chain alive even if one request rejects.
  hostQueues.set(host, next.catch(() => undefined));
  return next;
}

export interface FetchOptions {
  userAgent?: string;
  /** Cache lifetime. 0 disables caching for this call. Default 12h. */
  cacheTtlMs?: number;
  /** Attempts including the first. Default 3. */
  retries?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  fetchedAt: number;
  status: number;
  body: string;
}

async function readCache(key: string, ttlMs: number): Promise<string | null> {
  if (ttlMs <= 0) return null;
  try {
    const raw = await readFile(join(CACHE_DIR, `${key}.json`), 'utf8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > ttlMs) return null;
    return entry.body;
  } catch {
    return null;
  }
}

async function writeCache(key: string, status: number, body: string): Promise<void> {
  const file = join(CACHE_DIR, `${key}.json`);
  await mkdir(dirname(file), { recursive: true });
  const entry: CacheEntry = { fetchedAt: Date.now(), status, body };
  await writeFile(file, JSON.stringify(entry), 'utf8');
}

/**
 * Fetch a URL as text, with caching, throttling, and retries.
 * Throws on a non-2xx response after exhausting retries.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const {
    userAgent = SEC_USER_AGENT,
    cacheTtlMs = 12 * 60 * 60 * 1000,
    retries = 3,
    timeoutMs = 30_000,
  } = opts;

  const key = hashId(url);
  const cached = await readCache(key, cacheTtlMs);
  if (cached !== null) {
    log.debug(`cache hit ${url}`);
    return cached;
  }

  const host = new URL(url).host;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = await throttle(host, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': userAgent, Accept: '*/*' },
            signal: controller.signal,
            redirect: 'follow',
          });
          const text = await res.text();
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status} for ${url}`);
            // 4xx other than 429 will not fix themselves; fail fast.
            (err as Error & { fatal?: boolean }).fatal =
              res.status >= 400 && res.status < 500 && res.status !== 429;
            throw err;
          }
          await writeCache(key, res.status, text);
          return text;
        } finally {
          clearTimeout(timer);
        }
      });
      return body;
    } catch (err) {
      lastError = err;
      if ((err as Error & { fatal?: boolean }).fatal) break;
      if (attempt < retries) {
        const backoff = 500 * 2 ** (attempt - 1);
        log.warn(`fetch failed (attempt ${attempt}/${retries}), retrying in ${backoff}ms`, String(err));
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Fetch and JSON-parse. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}

/**
 * Run tasks with bounded concurrency, preserving input order in the output.
 * Used everywhere we fan out over hundreds of filings or LLM calls.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
