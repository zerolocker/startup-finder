/**
 * Every path the app reads or writes, resolved from the repo root.
 *
 * Centralized so a future agent can move the data layout in one edit, and so
 * commands work no matter which directory they are invoked from.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file's location (src/paths.ts -> ..). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_DIR = join(ROOT, 'config');
export const PROFILE_PATH = join(CONFIG_DIR, 'profile.yaml');

export const DATA_DIR = join(ROOT, 'data');
/** Raw upstream payloads. Gitignored, safe to delete at any time. */
export const CACHE_DIR = join(DATA_DIR, 'cache');
/** Parsed Form D filings, append-only. Committed. */
export const FILINGS_PATH = join(DATA_DIR, 'filings.jsonl');
/** Parsed news items, append-only. Committed. */
export const NEWS_PATH = join(DATA_DIR, 'news.jsonl');
/** Merged company records. Rewritten each merge. Committed. */
export const COMPANIES_PATH = join(DATA_DIR, 'companies.jsonl');
/** Companies with prefilter + LLM scores. Rewritten each score. Committed. */
export const SCORED_PATH = join(DATA_DIR, 'scored.jsonl');
/** Deep-research dossiers, keyed by company id. Append-only. Committed. */
export const DOSSIERS_PATH = join(DATA_DIR, 'dossiers.jsonl');
/** One record per pipeline run, for reproducibility and cost tracking. */
export const RUNS_PATH = join(DATA_DIR, 'runs.jsonl');

export const REPORTS_DIR = join(ROOT, 'reports');
/**
 * Run metadata for the dashboard — window, cost, runId. A few hundred bytes.
 * Everything else the dashboard shows it reads straight out of `data/`.
 */
export const REPORT_META_PATH = join(REPORTS_DIR, 'meta.json');
/**
 * The dashboard shell. At the repo root so relative fetches of `data/*.jsonl`
 * resolve both under a local static server and on GitHub Pages served from the
 * repo root.
 */
export const DASHBOARD_PATH = join(ROOT, 'index.html');
