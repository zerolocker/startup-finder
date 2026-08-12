#!/usr/bin/env -S npx tsx
/**
 * Command-line entry point.
 *
 * A run is one day. It fetches that day's filings and funding news, builds one
 * company record each, researches and scores every one of them on the web, and
 * writes a self-contained issue to `data/runs/<date>.jsonl`.
 *
 *   sf run       everything — the normal entry point
 *   sf ingest    fetch and merge a day into a shard, no LLM
 *   sf research  research and score the shard's companies  (all the plan usage)
 *   sf report    rewrite index.html and data/index.json    (no LLM, instant)
 *
 * The stages are separately runnable so you can re-research or re-render against
 * a shard already on disk rather than re-fetching.
 *
 * "Plan usage" means your Claude subscription's rate limit, not money — see the
 * note at the top of src/llm/claude.ts.
 *
 * See docs/ARCHITECTURE.md for how the pieces fit together.
 */

import { parseArgs } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import type { RunCompany, RunIndexEntry } from './types.ts';
import { DASHBOARD_PATH, INDEX_PATH, RUNS_DIR, runShardPath } from './paths.ts';
import { readAll, writeAll } from './store/jsonl.ts';
import { ingestEdgar } from './sources/edgar.ts';
import { ingestNews } from './sources/news.ts';
import { mergeSources } from './pipeline/merge.ts';
import { buildResearchPrompt, fitOf, researchCompanies } from './pipeline/research.ts';
import { renderDashboard } from './report/html.ts';
import { loadProfile } from './config.ts';
import { isClaudeAvailable, resetSpend, spentUsd } from './llm/claude.ts';
import { log } from './util/log.ts';
import { formatUsd } from './util/text.ts';

const USAGE = `startup-finder — find recently-funded startups worth your time

Usage: pnpm sf <command> [options]

Commands:
  run             Ingest, research, and report one day (the normal entry point)
  ingest          Fetch a day into data/runs/<date>.jsonl, no LLM
  research        Research and score that shard's companies
  report          Rewrite index.html and data/index.json
  runs            List the runs on disk
  show <id>       Print everything known about one company
  prompt          Print the exact research prompt for one company, no LLM call

Options:
  --date <d>      Which run to act on, YYYY-MM-DD. Defaults to the newest shard,
                  or yesterday for a fresh ingest.
  --days <n>      Days of filings to ingest (default 1). SEC publishes a day's
                  index only after it closes, so a window always ends yesterday.
  --limit <n>     Cap companies researched. A safety valve for an unusually
                  heavy day; unbounded by default, because every company found
                  is meant to be scored.
  --model <name>  haiku | sonnet | opus (default sonnet)
  --quiet         Only log warnings and errors

Examples:
  pnpm sf run                      # yesterday's filings, researched and scored
  pnpm sf run --limit 5            # a cheap trial run
  pnpm sf research --date 2026-08-11 --limit 3
`;

// ---------------------------------------------------------------------------
// Run index — data/index.json, newest first.
// ---------------------------------------------------------------------------

async function readIndex(): Promise<RunIndexEntry[]> {
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8')) as RunIndexEntry[];
  } catch {
    return [];
  }
}

async function writeIndex(entries: RunIndexEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(INDEX_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The run a bare command should act on: the newest shard, else yesterday. */
async function resolveDate(explicit: string | undefined): Promise<string> {
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) throw new Error(`--date must be YYYY-MM-DD (got "${explicit}")`);
    return explicit;
  }
  const index = await readIndex();
  return index[0]?.date ?? yesterday();
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function readShard(date: string): Promise<RunCompany[]> {
  return readAll<RunCompany>(runShardPath(date));
}

async function writeShard(date: string, companies: readonly RunCompany[]): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
  // By id, not by score: a stable order means git stores what actually changed
  // rather than a reordering of the whole file.
  await writeAll(runShardPath(date), [...companies].sort((a, b) => a.id.localeCompare(b.id)));
}

/** Fetch a day and write its shard, with every company still unassessed. */
async function stageIngest(days: number, date: string): Promise<RunCompany[]> {
  const [edgar, news] = await Promise.all([ingestEdgar({ days }), ingestNews()]);
  log.info(`Filings kept: ${edgar.filings.length}. Dropped: ${JSON.stringify(edgar.stats.dropped)}`);

  const { companies, stats } = mergeSources(edgar.filings, news.items);
  log.info(`Merged ${companies.length} companies (${stats.fromEdgar} from filings, ${stats.fromNews} from news)`);

  // Anything already assessed keeps its assessment, so re-running ingest after
  // research does not throw away what the research cost.
  const existing = new Map((await readShard(date)).map((c) => [c.id, c]));
  const shard: RunCompany[] = companies.map((c) => {
    const prior = existing.get(c.id);
    return { ...c, assessment: prior?.assessment ?? null, researchedAt: prior?.researchedAt ?? null };
  });

  await writeShard(date, shard);
  return shard;
}

/** Research and score every unassessed company in the shard. */
async function stageResearch(
  date: string,
  limit: number | undefined,
  model: 'haiku' | 'sonnet' | 'opus',
): Promise<RunCompany[]> {
  const shard = await readShard(date);
  if (shard.length === 0) {
    log.warn(`No shard for ${date} — run \`pnpm sf ingest\` first.`);
    return [];
  }

  const pending = shard.filter((c) => !c.assessment);
  const targets = limit === undefined ? pending : pending.slice(0, limit);
  if (targets.length < pending.length) {
    log.warn(`--limit ${limit}: researching ${targets.length} of ${pending.length} unassessed companies`);
  }
  if (targets.length === 0) {
    log.info(`All ${shard.length} companies in the ${date} run are already assessed.`);
    return shard;
  }

  const profile = await loadProfile();
  const { companies: assessed } = await researchCompanies(targets, profile, { model });

  const byId = new Map(assessed.map((c) => [c.id, c]));
  const merged = shard.map((c) => byId.get(c.id) ?? c);
  await writeShard(date, merged);
  return merged;
}

/**
 * Rewrite the dashboard shell and the run index. No LLM, no network.
 *
 * `costUsd` is what *this* invocation spent, and it accumulates onto whatever
 * the run had already cost. Re-rendering used to overwrite the figure with 0,
 * which quietly erased what a run had spent — the one number worth keeping,
 * since plan usage is the scarce resource.
 */
async function stageReport(date: string, costUsd: number, windowDays: number): Promise<RunIndexEntry> {
  const shard = await readShard(date);
  const index = await readIndex();
  const prior = index.find((e) => e.date === date);
  const entry: RunIndexEntry = {
    date,
    windowDays,
    companies: shard.length,
    assessed: shard.filter((c) => c.assessment).length,
    costUsd: (prior?.costUsd ?? 0) + costUsd,
    generatedAt: new Date().toISOString(),
  };

  await writeIndex([...index.filter((e) => e.date !== date), entry]);
  await writeFile(DASHBOARD_PATH, renderDashboard(), 'utf8');

  log.info(`Run ${date}: ${entry.assessed}/${entry.companies} assessed`);
  log.info(`Wrote ${DASHBOARD_PATH} — serve the repo root to view it`);
  return entry;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRuns(): Promise<void> {
  const index = await readIndex();
  if (index.length === 0) {
    process.stdout.write('No runs yet. Try `pnpm sf run`.\n');
    return;
  }
  const total = index.reduce((sum, e) => sum + e.costUsd, 0);
  const lines = index.map(
    (e) =>
      `  ${e.date}  ${String(e.companies).padStart(4)} companies  ` +
      `${String(e.assessed).padStart(4)} assessed  $${e.costUsd.toFixed(2)}`,
  );
  process.stdout.write(`${lines.join('\n')}\n\n  ${index.length} runs · $${total.toFixed(2)}-equiv total\n`);
}

async function cmdShow(id: string, date: string): Promise<void> {
  const company = (await readShard(date)).find((c) => c.id === id);
  if (!company) {
    log.warn(`No company "${id}" in the ${date} run. Try \`pnpm sf runs\`.`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(company, null, 2)}\n`);
}

async function cmdPrompt(date: string): Promise<void> {
  const shard = await readShard(date);
  if (shard.length === 0) {
    log.warn(`No shard for ${date} — run \`pnpm sf ingest\` first.`);
    return;
  }
  process.stdout.write(`${buildResearchPrompt(shard[0]!, await loadProfile())}\n`);
}

async function cmdRun(opts: {
  days: number;
  date: string;
  limit: number | undefined;
  model: 'haiku' | 'sonnet' | 'opus';
}): Promise<void> {
  if (!(await isClaudeAvailable())) {
    log.error('The `claude` CLI is not on your PATH. Install Claude Code first.');
    process.exitCode = 1;
    return;
  }
  resetSpend();
  const started = Date.now();

  await stageIngest(opts.days, opts.date);
  const companies = await stageResearch(opts.date, opts.limit, opts.model);
  const entry = await stageReport(opts.date, spentUsd(), opts.days);

  const top = [...companies].sort((a, b) => fitOf(b) - fitOf(a)).slice(0, 10);
  process.stdout.write(
    [
      '',
      `Done in ${((Date.now() - started) / 1000).toFixed(0)}s · plan usage ~$${entry.costUsd.toFixed(2)}-equiv`,
      '',
      'Best of this run:',
      ...top.map((c) => {
        const fit = String(Math.round(fitOf(c))).padStart(3);
        const amount = formatUsd(c.latestFunding?.amountUsd ?? null).padStart(7);
        const what = (c.assessment?.whatTheyDo ?? 'not assessed').slice(0, 62);
        return `  ${fit}  ${amount}  ${c.name.slice(0, 32).padEnd(32)}  ${what}`;
      }),
      '',
      '  serve the repo root and open index.html to read the issue',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      days: { type: 'string', default: '1' },
      limit: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.quiet) process.env['SF_LOG_LEVEL'] = 'warn';

  const model = values.model as string;
  if (!['haiku', 'sonnet', 'opus'].includes(model)) {
    throw new Error(`--model must be haiku, sonnet, or opus (got "${model}")`);
  }
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a positive number (got "${v}")`);
    return n;
  };
  const days = num(values.days, '--days') ?? 1;
  const limit = num(values.limit, '--limit');
  const asModel = model as 'haiku' | 'sonnet' | 'opus';

  switch (command) {
    case 'run':
      // A fresh run covers a new day, so it starts from yesterday rather than
      // from whatever shard happens to be newest.
      await cmdRun({ days, date: values.date ?? yesterday(), limit, model: asModel });
      break;
    case 'ingest': {
      const date = values.date ?? yesterday();
      const shard = await stageIngest(days, date);
      await stageReport(date, 0, days);
      log.info(`${shard.length} companies ready: pnpm sf research --date ${date}`);
      break;
    }
    case 'research': {
      const date = await resolveDate(values.date);
      resetSpend();
      await stageResearch(date, limit, asModel);
      await stageReport(date, spentUsd(), days);
      break;
    }
    case 'report':
      await stageReport(await resolveDate(values.date), 0, days);
      break;
    case 'runs':
      await cmdRuns();
      break;
    case 'show': {
      const id = positionals[1];
      if (!id) throw new Error('usage: pnpm sf show <company-id>');
      await cmdShow(id, await resolveDate(values.date));
      break;
    }
    case 'prompt':
      await cmdPrompt(await resolveDate(values.date));
      break;
    default:
      process.stdout.write(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
