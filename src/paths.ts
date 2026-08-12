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
/** Raw upstream payloads and LLM responses. Gitignored, safe to delete. */
export const CACHE_DIR = join(DATA_DIR, 'cache');
/**
 * One shard per run: `data/runs/<date>.jsonl`, one RunCompany per line.
 *
 * A run is a self-contained issue. Nothing is cumulative, so the dashboard
 * renders an issue from exactly one fetch and a run's cost in git is its own
 * size rather than a rewrite of everything ever seen.
 */
export const RUNS_DIR = join(DATA_DIR, 'runs');
export const runShardPath = (date: string): string => join(RUNS_DIR, `${date}.jsonl`);
/** The list of runs, newest first. Drives the dashboard's issue picker. */
export const INDEX_PATH = join(DATA_DIR, 'index.json');

/**
 * The dashboard. At the repo root so its relative fetches of `data/` resolve
 * under a local static server and on GitHub Pages served from the root.
 */
export const DASHBOARD_PATH = join(ROOT, 'index.html');
