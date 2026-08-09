#!/usr/bin/env -S npx tsx
/**
 * Command-line entry point.
 *
 * The pipeline is deliberately split into separately-runnable stages rather
 * than one monolithic command. That matters because the expensive stages
 * (score, research) can then be re-run against already-ingested data while
 * you iterate on prompts or on config/profile.yaml — which is the single most
 * common thing anyone working on this app will want to do.
 *
 *   sf ingest    fetch SEC Form D + funding news        (free, slow)
 *   sf merge     build company records from sources     (free, fast)
 *   sf score     prefilter + LLM fit scoring            ($)
 *   sf research  deep dives with web search             ($$)
 *   sf report    write reports/                         (free, fast)
 *   sf run       all of the above                       — the normal entry point
 *
 * See docs/ARCHITECTURE.md for how the stages fit together.
 */

import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Company,
  Dossier,
  FormDFiling,
  NewsItem,
  ResearchedCompany,
  RunRecord,
  ScoredCompany,
} from './types.ts';
import {
  COMPANIES_PATH,
  DOSSIERS_PATH,
  FILINGS_PATH,
  NEWS_PATH,
  REPORTS_DIR,
  RUNS_PATH,
  SCORED_PATH,
} from './paths.ts';
import { appendAll, readAll, upsertAll, writeAll } from './store/jsonl.ts';
import { ingestEdgar } from './sources/edgar.ts';
import { ingestNews } from './sources/news.ts';
import { mergeSources } from './pipeline/merge.ts';
import { rankCompanies } from './pipeline/prefilter.ts';
import { effectiveScore, scoreCompanies } from './pipeline/score.ts';
import { researchCompanies } from './pipeline/research.ts';
import { renderDigest } from './report/markdown.ts';
import { renderDashboard } from './report/html.ts';
import { loadProfile } from './config.ts';
import { budgetSpent, isClaudeAvailable, startBudget } from './llm/claude.ts';
import { log } from './util/log.ts';
import { formatUsd } from './util/text.ts';

const USAGE = `startup-finder — find recently-funded startups worth your time

Usage: pnpm sf <command> [options]

Commands:
  run        Run the whole pipeline and write reports (the normal entry point)
  ingest     Fetch SEC Form D filings and funding news into data/
  merge      Build company records from ingested sources
  score      Rank candidates and score the shortlist with an LLM
  research   Deep-dive the top companies with web search
  report     Regenerate reports/ from existing scored data
  stats      Summarize what is currently in data/
  show <id>  Print everything known about one company

Options:
  --days <n>        Lookback window for ingestion (default 7)
  --limit <n>       Companies sent to the LLM scorer (default 120)
  --research <n>    Companies given a deep-dive dossier (default 15)
  --budget <usd>    Hard cap on LLM spend for this run (default 8)
  --model <name>    haiku | sonnet | opus (default sonnet)
  --refresh         Re-research companies that already have a dossier
  --no-research     Skip the expensive research stage
  --quiet           Only log warnings and errors

Examples:
  pnpm sf run                          # weekly digest, ~$3-6
  pnpm sf run --days 3 --budget 2      # quick cheap pass
  pnpm sf score --limit 200 && pnpm sf report   # rescore after editing profile
`;

// ---------------------------------------------------------------------------
// Stage implementations. Each is independently runnable and idempotent.
// ---------------------------------------------------------------------------

async function stageIngest(days: number): Promise<{ filings: number; news: number }> {
  const [edgar, news] = await Promise.all([ingestEdgar({ days }), ingestNews()]);

  const f = await upsertAll<FormDFiling>(FILINGS_PATH, edgar.filings, (r) => r.accessionNumber);
  const n = await upsertAll<NewsItem>(NEWS_PATH, news.items, (r) => r.id);

  log.info(`Filings: +${f.added} new (${f.total} total). Dropped: ${JSON.stringify(edgar.stats.dropped)}`);
  log.info(`News: +${n.added} new (${n.total} total)`);
  return { filings: f.added, news: n.added };
}

async function stageMerge(): Promise<Company[]> {
  const [filings, news, existing] = await Promise.all([
    readAll<FormDFiling>(FILINGS_PATH),
    readAll<NewsItem>(NEWS_PATH),
    readAll<Company>(COMPANIES_PATH),
  ]);
  const { companies } = mergeSources(filings, news, existing);
  await writeAll(COMPANIES_PATH, companies);
  return companies;
}

async function stageScore(limit: number, model: 'haiku' | 'sonnet' | 'opus'): Promise<ScoredCompany[]> {
  const [companies, profile] = await Promise.all([readAll<Company>(COMPANIES_PATH), loadProfile()]);
  if (companies.length === 0) {
    log.warn('No companies to score — run `pnpm sf ingest && pnpm sf merge` first.');
    return [];
  }

  const ranked = rankCompanies(companies, profile);
  const shortlist = ranked.slice(0, limit);
  log.info(`Prefilter: ${companies.length} companies -> top ${shortlist.length} go to the LLM`);

  const { scored } = await scoreCompanies(shortlist, profile, { model });

  // Companies below the cutoff still belong in the dataset, ranked by
  // prefilter alone, so nothing silently disappears between runs.
  const scoredIds = new Set(scored.map((c) => c.id));
  const remainder: ScoredCompany[] = ranked
    .filter(({ company }) => !scoredIds.has(company.id))
    .map(({ company, prefilter }) => ({ ...company, prefilter, llm: null }));

  const all = [...scored, ...remainder].sort((a, b) => effectiveScore(b) - effectiveScore(a));
  await writeAll(SCORED_PATH, all);
  return all;
}

interface DossierRecord {
  id: string;
  dossier: Dossier;
  researchedAt: string;
}

async function stageResearch(
  count: number,
  model: 'haiku' | 'sonnet' | 'opus',
  refresh: boolean,
): Promise<ResearchedCompany[]> {
  const scored = await readAll<ScoredCompany>(SCORED_PATH);
  if (scored.length === 0) {
    log.warn('Nothing scored yet — run `pnpm sf score` first.');
    return [];
  }

  const stored = await readAll<DossierRecord>(DOSSIERS_PATH);
  const existing = new Map<string, { dossier: Dossier; researchedAt: string }>(
    refresh ? [] : stored.map((r) => [r.id, { dossier: r.dossier, researchedAt: r.researchedAt }]),
  );

  const targets = scored.slice(0, count);
  const { researched } = await researchCompanies(targets, existing, { model });

  const fresh: DossierRecord[] = researched
    .filter((r): r is ResearchedCompany & { dossier: Dossier } => r.dossier != null && !existing.has(r.id))
    .map((r) => ({ id: r.id, dossier: r.dossier, researchedAt: r.researchedAt ?? new Date().toISOString() }));
  if (fresh.length > 0) await appendAll(DOSSIERS_PATH, fresh);

  // Everything not researched still flows to the report, dossier-less.
  const researchedIds = new Set(researched.map((r) => r.id));
  const rest: ResearchedCompany[] = scored
    .filter((c) => !researchedIds.has(c.id))
    .map((c) => ({ ...c, dossier: null, researchedAt: null }));

  return [...researched, ...rest];
}

async function stageReport(
  companies: readonly ResearchedCompany[],
  opts: { runId: string; windowDays: number; costUsd: number; totalCandidates: number },
): Promise<{ markdown: string; html: string }> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const markdown = renderDigest(companies, { ...opts, featureCount: 12 });
  const html = renderDashboard(companies, opts);

  const mdPath = join(REPORTS_DIR, `${date}-digest.md`);
  const htmlPath = join(REPORTS_DIR, `${date}-dashboard.html`);
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(htmlPath, html, 'utf8');
  // Stable filenames so a bookmark or a symlink keeps working run to run.
  await writeFile(join(REPORTS_DIR, 'latest.md'), markdown, 'utf8');
  await writeFile(join(REPORTS_DIR, 'latest.html'), html, 'utf8');

  log.info(`Wrote ${mdPath}`);
  log.info(`Wrote ${htmlPath}`);
  return { markdown, html };
}

/** Reconstruct researched companies from disk, without spending anything. */
async function loadResearched(): Promise<ResearchedCompany[]> {
  const [scored, dossiers] = await Promise.all([
    readAll<ScoredCompany>(SCORED_PATH),
    readAll<DossierRecord>(DOSSIERS_PATH),
  ]);
  const byId = new Map(dossiers.map((d) => [d.id, d]));
  return scored.map((c) => {
    const found = byId.get(c.id);
    return { ...c, dossier: found?.dossier ?? null, researchedAt: found?.researchedAt ?? null };
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  const [filings, news, companies, scored, dossiers, runs] = await Promise.all([
    readAll<FormDFiling>(FILINGS_PATH),
    readAll<NewsItem>(NEWS_PATH),
    readAll<Company>(COMPANIES_PATH),
    readAll<ScoredCompany>(SCORED_PATH),
    readAll<DossierRecord>(DOSSIERS_PATH),
    readAll<RunRecord>(RUNS_PATH),
  ]);

  const withLlm = scored.filter((c) => c.llm).length;
  const strong = scored.filter((c) => c.llm && c.llm.fit >= 70).length;
  const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);

  process.stdout.write(
    [
      `Form D filings   ${filings.length}`,
      `News items       ${news.length}`,
      `Companies        ${companies.length}`,
      `Scored           ${scored.length} (${withLlm} by LLM, ${strong} at fit >= 70)`,
      `Dossiers         ${dossiers.length}`,
      `Runs             ${runs.length} (lifetime LLM spend $${totalCost.toFixed(2)})`,
      '',
    ].join('\n'),
  );
}

async function cmdShow(id: string): Promise<void> {
  const companies = await loadResearched();
  const found = companies.find((c) => c.id === id || c.name.toLowerCase() === id.toLowerCase());
  if (!found) {
    // Match in both directions: the query may be a fragment of the id, or the
    // id may be a fragment of an over-long query ("oxide-computer-co" when the
    // legal suffix was stripped to give "oxide-computer").
    const needle = id.toLowerCase();
    const near = companies
      .filter((c) => c.id.includes(needle) || needle.includes(c.id) || c.name.toLowerCase().includes(needle))
      .slice(0, 8);
    process.stderr.write(
      `No company "${id}".${near.length ? `\nDid you mean:\n${near.map((c) => `  ${c.id}`).join('\n')}\n` : '\n'}`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
}

async function cmdRun(opts: {
  days: number;
  limit: number;
  research: number;
  budget: number;
  model: 'haiku' | 'sonnet' | 'opus';
  refresh: boolean;
  skipResearch: boolean;
}): Promise<void> {
  if (!(await isClaudeAvailable())) {
    throw new Error(
      'The `claude` CLI was not found on PATH. It is how this app calls an LLM — see docs/DECISIONS.md ADR-003.',
    );
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const record: RunRecord = { runId, startedAt: new Date().toISOString(), finishedAt: null, stages: {}, costUsd: 0 };
  startBudget(opts.budget);

  const time = async <T>(name: string, fn: () => Promise<T>, count: (r: T) => number): Promise<T> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      record.stages[name] = { ok: true, count: count(result), ms: Date.now() - t0 };
      return result;
    } catch (err) {
      record.stages[name] = { ok: false, count: 0, ms: Date.now() - t0, error: String(err) };
      throw err;
    }
  };

  await time('ingest', () => stageIngest(opts.days), (r) => r.filings + r.news);
  await time('merge', () => stageMerge(), (r) => r.length);
  await time('score', () => stageScore(opts.limit, opts.model), (r) => r.length);

  const companies = opts.skipResearch
    ? await loadResearched()
    : await time('research', () => stageResearch(opts.research, opts.model, opts.refresh), (r) => r.length);

  record.costUsd = budgetSpent();
  const scoredCount = companies.length;

  await time(
    'report',
    () =>
      stageReport(companies, {
        runId,
        windowDays: opts.days,
        costUsd: record.costUsd,
        totalCandidates: scoredCount,
      }),
    () => 1,
  );

  record.finishedAt = new Date().toISOString();
  await appendAll(RUNS_PATH, [record]);

  // --- Terminal summary ----------------------------------------------------
  const top = companies
    .filter((c) => c.llm)
    .sort((a, b) => effectiveScore(b) - effectiveScore(a))
    .slice(0, 8);

  const lines = [
    '',
    `Done in ${((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000).toFixed(0)}s · LLM spend $${record.costUsd.toFixed(2)}`,
    '',
    'Top matches:',
    ...top.map((c) => {
      const score = String(Math.round(effectiveScore(c))).padStart(3);
      const amount = formatUsd(c.latestFunding?.amountUsd ?? null).padStart(7);
      const what = (c.llm?.whatTheyDo ?? '').slice(0, 62);
      return `  ${score}  ${amount}  ${c.name.slice(0, 34).padEnd(34)}  ${what}`;
    }),
    '',
    `  reports/latest.md    full digest`,
    `  reports/latest.html  filterable dashboard`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      days: { type: 'string', default: '7' },
      limit: { type: 'string', default: '120' },
      research: { type: 'string', default: '15' },
      budget: { type: 'string', default: '8' },
      model: { type: 'string', default: 'sonnet' },
      refresh: { type: 'boolean', default: false },
      'no-research': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.quiet) process.env['SF_LOG_LEVEL'] = 'warn';

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const model = values.model as 'haiku' | 'sonnet' | 'opus';
  if (!['haiku', 'sonnet', 'opus'].includes(model)) {
    throw new Error(`--model must be haiku, sonnet, or opus (got "${model}")`);
  }

  const num = (v: string | undefined, name: string, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number (got "${v}")`);
    return v === undefined ? fallback : n;
  };

  const days = num(values.days, 'days', 7);
  const limit = num(values.limit, 'limit', 120);
  const research = num(values.research, 'research', 15);
  const budget = num(values.budget, 'budget', 8);

  switch (command) {
    case 'run':
      await cmdRun({
        days,
        limit,
        research,
        budget,
        model,
        refresh: values.refresh,
        skipResearch: values['no-research'],
      });
      break;
    case 'ingest':
      await stageIngest(days);
      break;
    case 'merge':
      await stageMerge();
      break;
    case 'score':
      startBudget(budget);
      await stageScore(limit, model);
      log.info(`LLM spend $${budgetSpent().toFixed(2)}`);
      break;
    case 'research':
      startBudget(budget);
      await stageResearch(research, model, values.refresh);
      log.info(`LLM spend $${budgetSpent().toFixed(2)}`);
      break;
    case 'report': {
      const companies = await loadResearched();
      // Report the spend of the run that produced this data, not $0 — the
      // report command itself costs nothing but the data behind it did not.
      const runs = await readAll<RunRecord>(RUNS_PATH);
      const lastRun = runs.at(-1);
      await stageReport(companies, {
        runId: lastRun?.runId ?? 'report-only',
        windowDays: days,
        costUsd: lastRun?.costUsd ?? 0,
        totalCandidates: companies.length,
      });
      break;
    }
    case 'stats':
      await cmdStats();
      break;
    case 'show': {
      const id = positionals[1];
      if (!id) throw new Error('Usage: pnpm sf show <company-id>');
      await cmdShow(id);
      break;
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env['SF_LOG_LEVEL'] === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exitCode = 1;
});
