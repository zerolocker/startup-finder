/**
 * LLM access via the Claude Code CLI in headless mode (`claude -p`).
 *
 * Why the CLI rather than the Anthropic API? See docs/DECISIONS.md ADR-003.
 * Short version: it runs on the user's existing Claude subscription with no
 * separate API key to manage, and it gets first-class web search for free,
 * which the research stage depends on.
 *
 * ## What "cost" means here
 *
 * With no ANTHROPIC_API_KEY set, `claude` authenticates via OAuth against the
 * user's subscription. **Nothing is billed to a card.** The `total_cost_usd`
 * the CLI reports is a dollar-*equivalent* of the tokens used, and the real
 * scarce resource is the subscription's rate limit.
 *
 * We still track and cap it, because it is the best available proxy for how
 * much of that limit a run consumes. Read every "$" in this file as "plan
 * usage, expressed in dollar-equivalents" — not as money leaving an account.
 *
 * Spend is **tracked and reported, never enforced.** There is no cap: a run
 * uses whatever the work needs and tells you what it used. See ADR-011 for why
 * the hard cap was removed. The two remaining guards against a runaway run are
 * the per-stage item limits (`--limit`, `--research`) and the disk cache.
 *
 * Two things here are load-bearing and should not be removed casually:
 *
 *   1. **Disk caching.** A research call is ~$0.13-equivalent and ~15s.
 *      Re-running the pipeline without a cache would re-spend that usage for
 *      every company every time.
 *   2. **The sandbox cwd.** `claude` reads CLAUDE.md from its working
 *      directory. Run from the repo root it would ingest *this project's* dev
 *      instructions into every scoring prompt — irrelevant, costly, and
 *      confusing. We run it from an empty scratch directory instead.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { hashId } from '../util/text.ts';
import { log } from '../util/log.ts';
import { CACHE_DIR } from '../paths.ts';

export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

export interface ClaudeOptions {
  model?: ModelAlias;
  /** Tools to pre-approve. Leave empty for pure text generation (fastest). */
  allowedTools?: string[];
  timeoutMs?: number;
  /** Set false to bypass the cache for this call. */
  cache?: boolean;
}

export interface ClaudeResult {
  text: string;
  costUsd: number;
  ms: number;
  cached: boolean;
}

/** Shape of `claude -p --output-format json`. Only the fields we rely on. */
interface ClaudeCliEnvelope {
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  subtype?: string;
  api_error_status?: string | null;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

/**
 * Plan usage accumulated by this process, in dollar-equivalents.
 *
 * Purely an odometer. Nothing reads it to decide whether to make a call — see
 * ADR-011. It exists so the run summary, `runs.jsonl`, and the report header
 * can tell the user what a run actually consumed.
 */
let totalSpentUsd = 0;

/** Zero the odometer at the start of a run. */
export function resetSpend(): void {
  totalSpentUsd = 0;
}

/** Plan usage so far this process, in dollar-equivalents. */
export function spentUsd(): number {
  return totalSpentUsd;
}

// ---------------------------------------------------------------------------
// Sandbox working directory
// ---------------------------------------------------------------------------

let sandboxDir: string | null = null;

/**
 * An empty directory for `claude` to run in, so it inherits no project context.
 * Created once per process.
 */
async function getSandbox(): Promise<string> {
  if (sandboxDir) return sandboxDir;
  sandboxDir = await mkdtemp(join(tmpdir(), 'startup-finder-llm-'));
  return sandboxDir;
}

// ---------------------------------------------------------------------------
// Core invocation
// ---------------------------------------------------------------------------

function cacheKey(prompt: string, opts: ClaudeOptions): string {
  return hashId(JSON.stringify([prompt, opts.model ?? 'sonnet', opts.allowedTools ?? []]));
}

async function readLlmCache(key: string): Promise<ClaudeResult | null> {
  try {
    const raw = await readFile(join(CACHE_DIR, 'llm', `${key}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { text: string; costUsd: number };
    return { text: parsed.text, costUsd: 0, ms: 0, cached: true };
  } catch {
    return null;
  }
}

async function writeLlmCache(key: string, result: ClaudeResult): Promise<void> {
  const dir = join(CACHE_DIR, 'llm');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), JSON.stringify({ text: result.text, costUsd: result.costUsd }), 'utf8');
}

/** Run one prompt through `claude -p` and return its text output. */
export async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  const { model = 'sonnet', allowedTools = [], timeoutMs = 180_000, cache = true } = opts;

  const key = cacheKey(prompt, opts);
  if (cache) {
    const hit = await readLlmCache(key);
    if (hit) {
      log.debug('llm cache hit');
      return hit;
    }
  }

  return withRetry(() => invoke(prompt, { model, allowedTools, timeoutMs }, key, cache));
}

/**
 * Retry transient CLI failures with backoff.
 *
 * Observed in practice: under concurrency 3, roughly 1 call in 60 fails with a
 * non-zero exit or an API error and succeeds immediately on retry. Without this,
 * a failed scoring batch silently drops 8 companies from the run — which is
 * exactly the kind of quiet data loss that is hard to notice in a report.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const backoff = 1000 * 2 ** (attempt - 1);
        log.debug(`claude call failed (attempt ${attempt}/${attempts}), retrying in ${backoff}ms: ${String(err)}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The actual subprocess call. Split out so the reservation can be released. */
async function invoke(
  prompt: string,
  opts: { model: ModelAlias; allowedTools: string[]; timeoutMs: number },
  key: string,
  cache: boolean,
): Promise<ClaudeResult> {
  const { model, allowedTools, timeoutMs } = opts;
  const cwd = await getSandbox();
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--model',
    model,
    // Do not load MCP servers we did not ask for; they cost startup time.
    '--strict-mcp-config',
  ];
  if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);

  const started = Date.now();
  const envelope = await new Promise<ClaudeCliEnvelope>((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude: ${err.message}. Is the Claude Code CLI installed and on PATH?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ClaudeCliEnvelope);
      } catch {
        reject(new Error(`claude returned non-JSON output: ${stdout.slice(0, 300)}`));
      }
    });
  });

  const ms = Date.now() - started;
  const costUsd = envelope.total_cost_usd ?? 0;
  totalSpentUsd += costUsd;

  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new Error(`claude reported an error: ${envelope.subtype ?? 'unknown'} ${envelope.api_error_status ?? ''}`);
  }

  const result: ClaudeResult = { text: envelope.result, costUsd, ms, cached: false };
  if (cache) await writeLlmCache(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or ```json fences often enough that demanding
 * clean output is not worth the retries. We take the outermost balanced
 * braces, which handles both.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace scanning
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new Error(`no JSON object found in response: ${text.slice(0, 200)}`);
}

export interface JsonOptions extends ClaudeOptions {
  /** Attempts including the first. Default 2. */
  retries?: number;
}

/**
 * Run a prompt and parse the response against a Zod schema.
 *
 * On a schema violation we retry once with the validation errors appended to
 * the prompt, which recovers the large majority of failures. Persistent
 * failures throw — a caller that wants to skip the item should catch.
 */
export async function runClaudeJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  opts: JsonOptions = {},
): Promise<{ value: T; costUsd: number; ms: number }> {
  const { retries = 2, ...rest } = opts;
  let totalCost = 0;
  let totalMs = 0;
  let lastError = '';

  for (let attempt = 1; attempt <= retries; attempt++) {
    const fullPrompt =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYour previous response was rejected by schema validation:\n${lastError}\nRespond again with ONLY the corrected JSON object.`;

    // Never serve a cached response to a corrective retry — it would return
    // the same invalid text forever.
    const result = await runClaude(fullPrompt, { ...rest, cache: rest.cache !== false && attempt === 1 });
    totalCost += result.costUsd;
    totalMs += result.ms;

    try {
      const parsed = schema.safeParse(extractJson(result.text));
      if (parsed.success) return { value: parsed.data, costUsd: totalCost, ms: totalMs };
      lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (err) {
      lastError = String(err);
    }
    log.debug(`llm json attempt ${attempt}/${retries} failed: ${lastError}`);
  }

  throw new Error(`LLM did not return valid JSON after ${retries} attempts: ${lastError}`);
}

/** True if the Claude CLI is on PATH. Used for a friendly preflight error. */
export async function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
