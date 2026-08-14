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
import { DASHBOARD_PATH, INDEX_PATH, RUNS_DIR, runLogPath, runShardPath } from './paths.ts';
import { readAll, writeAll } from './store/jsonl.ts';
import { ingestEdgar } from './sources/edgar.ts';
import { ingestNews } from './sources/news.ts';
import { mergeSources } from './pipeline/merge.ts';
import { buildResearchPrompt, fitOf, researchCompanies } from './pipeline/research.ts';
import { renderDashboard } from './report/html.ts';
import { loadProfile } from './config.ts';
import { isClaudeAvailable, resetSpend, spentUsd } from './llm/claude.ts';
import { log, logFilePath, startFileLog } from './util/log.ts';
import { formatUsd } from './util/text.ts';

const USAGE = `startup-finder — find recently-funded startups worth your time

Usage: pnpm sf <command> [options]

Commands:
  run             THE command. Covers every day since the last complete issue,
                  resumes anything a rate limit interrupted, and reports.
                  Safe to run repeatedly; it is idempotent.
  ingest          Fetch a day into data/runs/<date>.jsonl, no LLM
  research        Research and score that shard's companies
  report          Rewrite index.html and data/index.json
  runs            List the runs on disk
  show <id>       Print everything known about one company
  prompt          Print the exact research prompt for one company, no LLM call

Options:
  --date <d>      Act on one specific issue, YYYY-MM-DD. The run command covers
                  everything outstanding without it, so you rarely need this.
  --limit <n>     Cap companies researched per invocation, across all
                  outstanding days. Unbounded by default: a run researches until
                  your plan's rate limit stops it, then leaves the rest for the
                  next run. Set this to keep some window in reserve.
  --refresh       Re-score companies that already have an assessment. Use after
                  editing config/profile.yaml to see the effect.
  --model <name>  haiku | sonnet | opus (default sonnet)
  --quiet         Only log warnings and errors

Examples:
  pnpm sf run                      # the daily command — catches up if you missed days
  pnpm sf run --limit 5            # a cheap trial
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

/**
 * Newest funding first, unknown dates last.
 *
 * A day's filings carry first-sale dates spread over weeks, so this is a real
 * ordering rather than a tie-break — and it decides who gets researched when the
 * rate limit cuts a run short.
 */
export function byFundingRecency(a: RunCompany, b: RunCompany): number {
  const da = a.latestFunding?.date ?? '';
  const db = b.latestFunding?.date ?? '';
  if (da === db) return a.id.localeCompare(b.id); // stable, so reruns match
  if (!da) return 1;
  if (!db) return -1;
  return db.localeCompare(da);
}

/** Research and score every unassessed company in the shard. */
async function stageResearch(
  date: string,
  limit: number | undefined,
  model: 'haiku' | 'sonnet' | 'opus',
  refresh = false,
): Promise<{ companies: RunCompany[]; planLimited: boolean }> {
  const shard = await readShard(date);
  if (shard.length === 0) {
    log.warn(`No shard for ${date} — run \`pnpm sf ingest\` first.`);
    return { companies: [], planLimited: false };
  }

  // --refresh re-scores companies that already have an assessment, which is the
  // only way to see the effect of an edited profile.yaml on a finished issue.
  //
  // Sorted by how recently the money landed, because a rate limit will often cut
  // this list short and the freshest rounds are the ones worth having. The shard
  // itself stays in id order so git can diff it, so the order has to be imposed
  // here rather than read off the file.
  const pending = (refresh ? shard : shard.filter((c) => !c.assessment)).sort(byFundingRecency);
  const targets = limit === undefined ? pending : pending.slice(0, limit);
  if (targets.length < pending.length) {
    log.warn(`--limit ${limit}: researching ${targets.length} of ${pending.length} unassessed companies`);
  }
  if (targets.length === 0) {
    log.info(`All ${shard.length} companies in the ${date} run are already assessed. Use --refresh to re-score.`);
    return { companies: shard, planLimited: false };
  }

  const profile = await loadProfile();
  const { companies: assessed, planLimited } = await researchCompanies(targets, profile, { model });

  const byId = new Map(assessed.map((c) => [c.id, c]));
  const merged = shard.map((c) => byId.get(c.id) ?? c);
  await writeShard(date, merged);
  return { companies: merged, planLimited };
}

/**
 * The days a run should cover: everything from the last completed issue up to
 * yesterday, newest first.
 *
 * Newest first because a rate limit will often stop the run partway, and the
 * most recent issue is the one worth having complete. An incomplete shard is
 * simply a day with unassessed companies, so resuming after a limit and
 * backfilling a day you missed are the same operation — which is what lets one
 * command be the only thing anyone has to run.
 */
const MAX_CATCHUP_DAYS = 7;

/**
 * A run researches until the plan's rate limit stops it.
 *
 * That is deliberate. A day is ~62 companies and ~$18-equivalent, already about
 * a whole Claude Pro five-hour window, so any fixed budget either wastes window
 * or fails to finish a normal day. Letting the limit be the stop condition
 * extracts the most from each window and needs no tuning.
 *
 * It also composes with scheduling: because the window resets every five hours,
 * several routines spaced more than five hours apart drain a backlog at roughly
 * a window each. A run with nothing outstanding makes no LLM calls at all, so
 * the extra routines cost nothing on days when there is nothing to do.
 *
 * `--limit` still caps it for anyone who wants to leave window headroom.
 * MAX_CATCHUP_DAYS remains the outer bound on how much can ever be outstanding.
 */

export function datesToCover(index: readonly RunIndexEntry[], today: Date): string[] {
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - 1); // SEC publishes a day's index after it closes

  // A first run covers yesterday only. Catching up is defined relative to a
  // known last issue; with no history, walking back the full window would
  // research a week of filings — roughly 430 companies — on first use.
  if (index.length === 0) return [end.toISOString().slice(0, 10)];

  const complete = new Set(index.filter((e) => e.companies > 0 && e.assessed >= e.companies).map((e) => e.date));
  const out: string[] = [];
  for (let i = 0; i < MAX_CATCHUP_DAYS; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (complete.has(iso)) break; // reached settled history; everything older is done
    out.push(iso);
  }
  return out;
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

/**
 * The one command anyone runs.
 *
 * Covers every day since the last complete issue, resumes any day left half
 * finished by a rate limit, and reports. It is idempotent and self-healing on
 * purpose: a scheduled routine can call it with no arguments and no knowledge
 * of what happened last time.
 */
async function cmdRun(opts: {
  date: string | undefined;
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

  // Started before any work so a crash mid-run still leaves a trail.
  startFileLog(runLogPath(new Date().toISOString().slice(0, 10)));

  const dates = opts.date ? [opts.date] : datesToCover(await readIndex(), new Date());
  if (dates.length === 0) {
    process.stdout.write('\nAlready up to date. Nothing to run.\n\n');
    return;
  }
  log.info(`Covering ${dates.length} day(s): ${dates.join(', ')}`);
  log.info(`Limit: ${opts.limit ?? 'none — will run until the plan rate limit stops it'}`);

  const covered: RunIndexEntry[] = [];
  let stoppedEarly = false;
  // Unbounded by default: the rate limit is the stop condition.
  let budget = opts.limit ?? Infinity;

  for (const date of dates) {
    if (budget <= 0) {
      log.warn(`--limit ${opts.limit} reached — ${dates.length - covered.length} day(s) left for the next run.`);
      break;
    }
    if ((await readShard(date)).length === 0) await stageIngest(1, date);

    const before = (await readShard(date)).filter((c) => c.assessment).length;
    const { planLimited } = await stageResearch(date, Number.isFinite(budget) ? budget : undefined, opts.model);

    const entry = await stageReport(date, spentUsd(), 1);
    const didThisDay = entry.assessed - before;
    budget -= didThisDay;
    log.info(
      `Day ${date}: researched ${didThisDay} this run, ${entry.assessed}/${entry.companies} assessed overall, ` +
        `$${spentUsd().toFixed(2)} spent so far${planLimited ? ' — PLAN LIMIT REACHED' : ''}`,
    );

    covered.push(entry);
    if (planLimited) {
      stoppedEarly = true;
      break;
    }
  }

  const newest = covered[0];
  const companies = newest ? await readShard(newest.date) : [];
  const top = [...companies]
    .filter((c) => c.assessment?.isOperatingCompany)
    .sort((a, b) => fitOf(b) - fitOf(a))
    .slice(0, 10);
  const missing = covered.reduce((n, e) => n + (e.companies - e.assessed), 0);
  const daysLeft = dates.length - covered.length;

  log.info(
    `RUN SUMMARY ${JSON.stringify({
      outcome: stoppedEarly ? 'stopped-at-plan-limit' : missing > 0 ? 'stopped-at-limit-flag' : 'complete',
      seconds: Math.round((Date.now() - started) / 1000),
      costUsd: Number(spentUsd().toFixed(2)),
      daysCovered: covered.map((e) => e.date),
      daysNotStarted: daysLeft,
      companiesOutstanding: missing,
      issues: covered.map((e) => ({ date: e.date, assessed: e.assessed, of: e.companies })),
    })}`,
  );
  if (logFilePath()) log.info(`Log written to ${logFilePath()}`);

  process.stdout.write(
    [
      '',
      `Done in ${((Date.now() - started) / 1000).toFixed(0)}s · plan usage ~$${spentUsd().toFixed(2)}-equiv`,
      `Issues: ${covered.map((e) => `${e.date} (${e.assessed}/${e.companies})`).join(', ')}`,
      // A run that assessed a third of what it found is not a success, and the
      // cost line alone reads like one.
      ...(missing > 0 || daysLeft > 0
        ? [
            '',
            `  Outstanding: ${missing} companies in the issues above` +
              (daysLeft > 0 ? `, and ${daysLeft} further day(s) not started` : '') + '.',
            stoppedEarly
              ? '  Your usage window is spent — that is the intended stopping point.'
              : '  Stopped by --limit.',
            '  The next run picks all of it up. Windows reset every 5 hours, so a',
            '  second routine more than 5 hours later will continue from here.',
          ]
        : []),
      '',
      newest ? `Best of ${newest.date}:` : 'Nothing found.',
      ...top.map((c) => {
        const fit = String(Math.round(fitOf(c))).padStart(3);
        const amount = formatUsd(c.latestFunding?.amountUsd ?? null).padStart(7);
        const where = (c.assessment?.headquarters || c.location || '').slice(0, 18).padEnd(19);
        return `  ${fit}  ${amount}  ${where} ${c.name.slice(0, 28).padEnd(29)} ${(c.assessment?.whatTheyDo ?? '').slice(0, 48)}`;
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
      refresh: { type: 'boolean', default: false },
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
      await cmdRun({ date: values.date, limit, model: asModel });
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
      await stageResearch(date, limit, asModel, values.refresh);
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
