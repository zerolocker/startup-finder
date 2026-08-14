/**
 * The only LLM stage: research a company on the web, then score it.
 *
 * Research and scoring are one call on purpose. This app used to score first,
 * from a name and a dollar figure, and research only the handful that survived —
 * which meant the ranking was decided before anything knew what a company did.
 * The model said so itself: on a real corpus, 61% of its one-line descriptions
 * began "Unknown". Now every company a run finds is looked up first and judged
 * on what was actually found.
 *
 * It is the expensive stage — measured at ~$0.25-0.30 and ~20s per company — and
 * there is no cheaper stage in front of it. What bounds a run is the size of a
 * day: ~60 companies after the ingest filter. `--limit` exists as a safety valve,
 * not as a routine gate.
 *
 * A full day is enough to exhaust a Claude Pro window. On a real run 20 companies
 * were researched over seven minutes and the remaining 37 were then refused in
 * ninety seconds. That is why PlanLimitError stops the run rather than marking
 * the rest as failures — see the note on it in llm/claude.ts.
 *
 * The prompt leans hard on "say you couldn't find it" over guessing. A dossier
 * that invents a plausible product description is worse than useless: the user
 * would act on it, and it would be wrong.
 */

import type { Assessment, Company, Profile, RunCompany } from '../types.ts';
import { AssessmentSchema } from '../types.ts';
import { profileToPrompt } from '../config.ts';
import { PlanLimitError, runClaudeJson, spentUsd, type ModelAlias } from '../llm/claude.ts';
import { mapWithConcurrency } from '../util/http.ts';
import { formatUsd } from '../util/text.ts';
import { log } from '../util/log.ts';

/** Everything we already know, handed to the model as a starting point. */
function knownFacts(company: Company): string {
  const lines: string[] = [`Company name (as filed): ${company.name}`];
  if (company.location) lines.push(`Location: ${company.location}`);

  const funding = company.latestFunding;
  if (funding) {
    lines.push(
      `Recent funding: ${formatUsd(funding.amountUsd)}${funding.round ? ` (${funding.round})` : ''} around ${funding.date}, per ${funding.source === 'edgar' ? 'an SEC Form D filing' : 'press coverage'}.`,
    );
  }
  if (company.people.length > 0) {
    lines.push(
      `Officers/directors on the SEC filing: ${company.people
        .slice(0, 8)
        .map((p) => `${p.name}${p.relationships.length ? ` (${p.relationships.join('/')})` : ''}`)
        .join('; ')}`,
    );
  }
  for (const line of company.evidence.slice(0, 6)) lines.push(line);
  for (const source of company.sources.slice(0, 5)) lines.push(`Source: ${source.url}`);

  return lines.join('\n');
}

/**
 * The scoring rubric.
 *
 * Deliberately different from the old blind screen: the model has searched the
 * web before it gets here, so "I could not tell what they do" is now evidence
 * about the company rather than an artifact of having been shown nothing.
 */
function rubric(profile: Profile): string {
  const lens = profile.intent.includes('join')
    ? `Judge this as a PLACE TO WORK: technical depth, whether the product is real, how
small the team is, and whether an engineer would have real leverage there.`
    : `Judge this as an INVESTMENT: market size, defensibility, traction, and team.`;

  return `${profileToPrompt(profile)}

${lens}

SCORING BANDS (the "fit" field):
  85-100  Rare. Strong thematic match AND clear evidence of a substantial
          technical company. You would tell this person to drop what they are
          doing and look at it today.
  70-84   Strong match on their top themes, with credible evidence.
  50-69   Plausible match, but the theme is mid-weight or the evidence is thin.
  30-49   Weak or uncertain match. Probably not worth their time.
  0-29    Clear mismatch, an anti-theme, or not an operating tech company at all.`;
}

/**
 * Build the exact prompt sent for one company.
 *
 * Exported because this stage is both the most expensive and the most capable of
 * confident nonsense, so reading the literal text — free, via `pnpm sf prompt` —
 * is the fastest way to understand or debug a score.
 */
export function buildResearchPrompt(company: Company, profile: Profile): string {
  return `Research this recently-funded company on the web, then score it for the person
described below. You have web search and you should use it.

${rubric(profile)}

WHAT WE ALREADY KNOW (from an SEC filing and/or press):
${knownFacts(company)}

YOUR TASK:
Search to find out who this company actually is. Good queries: the company name
plus "funding", plus "careers", plus a founder's name. Check their own site and
careers page if you can find them. Then score the fit.

BE HONEST ABOUT UNCERTAINTY. This is the most important instruction:
- Company names are ambiguous. If the results are about a DIFFERENT company with
  a similar name, say so and do not use them.
- If you cannot confidently identify the company, say exactly that in
  "whatTheyDo" and "summary", set confidence to "low", and leave the other
  fields empty. An empty dossier is a useful result; a fabricated one is
  actively harmful.
- Never invent open roles, investors, funding amounts, or team backgrounds.
  Empty arrays are expected and fine.
- Prefer the company's own site and reputable press over aggregator pages, which
  are frequently stale or wrong.
- A low-confidence score is not a low score. Reserve scores under 30 for
  companies you are confident are a poor fit.
- Set "isOperatingCompany" false for funds, SPVs, holding companies and local
  businesses. Some of these get past our filters, and you can see what a legal
  name cannot. Score those under 20 and say why in "concerns".
- Report "headquarters" as where the company actually operates from, which you
  should find on their site or in press. Do not copy the address on the SEC
  filing: it is frequently the filing agent's or the state of incorporation,
  not where anyone works.

Respond with ONLY a JSON object, no prose and no markdown fences:
{
  "fit": <0-100>,
  "whatTheyDo": "<one sentence, or an explicit 'Unknown — ...'>",
  "headquarters": "<'City, ST' for US, 'City, Country' otherwise, or \"\" if not found>",
  "isOperatingCompany": true|false,
  "matchedInterests": ["<theme names from the profile>"],
  "concerns": ["<specific, evidence-based concerns>"],
  "rationale": "<2-3 sentences arguing the score>",
  "confidence": "low"|"medium"|"high",
  "summary": "<2-4 sentences: who they are and why they may or may not matter>",
  "product": "<what they build and for whom, or \\"\\" if unknown>",
  "team": "<founder and team backgrounds you actually found, or \\"\\">",
  "funding": "<funding history and named investors you found, or \\"\\">",
  "openRoles": ["<specific role titles from their careers page>"],
  "techStack": ["<technologies you found evidence of>"],
  "competitors": ["<named competitors>"],
  "redFlags": ["<specific, evidence-based concerns>"],
  "greenFlags": ["<specific, evidence-based positives>"],
  "links": [{"label": "<e.g. Homepage, Careers>", "url": "<url>"}]
}`;
}

export interface ResearchOptions {
  model?: ModelAlias;
  /** Parallel research calls. Each is slow, so a few helps a lot. */
  concurrency?: number;
  timeoutMs?: number;
}

export interface ResearchResult {
  companies: RunCompany[];
  costUsd: number;
  failures: number;
  /** True when the run stopped early because the plan's rate limit was hit. */
  planLimited: boolean;
}

/** Research and score every company given. */
export async function researchCompanies(
  companies: readonly Company[],
  profile: Profile,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const { model = 'sonnet', concurrency = 3, timeoutMs = 240_000 } = opts;
  if (companies.length === 0) return { companies: [], costUsd: 0, failures: 0, planLimited: false };

  let costUsd = 0;
  let failures = 0;
  let done = 0;
  // Once the plan's window is exhausted every remaining call fails instantly,
  // so continuing would mark the rest of the queue as research failures in
  // seconds. Stop dispatching and leave them unassessed for the next run.
  let planLimited = false;
  // Backstop for the above. PlanLimitError matches one exact envelope shape;
  // this catches the same situation if that shape ever changes, by noticing
  // that several calls in a row failed without spending anything. A genuine
  // research failure costs tokens, so a free failure means nothing was tried.
  let freeFailureStreak = 0;
  const FREE_FAILURE_LIMIT = 5;

  const out = await mapWithConcurrency(companies, concurrency, async (company): Promise<RunCompany> => {
    if (planLimited) return { ...company, assessment: null, researchedAt: null };
    // The odometer is the only thing that survives a throw, so read it across
    // the call to tell a free refusal from a failure that actually ran.
    const spentBefore = spentUsd();
    try {
      const { value, costUsd: cost } = await runClaudeJson(buildResearchPrompt(company, profile), AssessmentSchema, {
        model,
        allowedTools: ['WebSearch', 'WebFetch'],
        timeoutMs,
      });
      costUsd += cost;
      freeFailureStreak = 0;
      // One line per company. Verbose on stderr, but the file log is the only
      // record of an unattended run, and "which company was it up to when the
      // limit hit" is the first thing anyone asks.
      log.debug(`researched ${company.name} (fit ${value.fit}, $${cost.toFixed(3)})`);
      return { ...company, assessment: value, researchedAt: new Date().toISOString() };
    } catch (err) {
      if (err instanceof PlanLimitError) {
        if (!planLimited) log.warn(err.message);
        planLimited = true;
        return { ...company, assessment: null, researchedAt: null };
      }
      // One company failing must not cost the run. It lands in the shard with a
      // null assessment, which the dashboard shows rather than hides.
      failures++;
      freeFailureStreak = spentUsd() === spentBefore ? freeFailureStreak + 1 : 0;
      if (freeFailureStreak >= FREE_FAILURE_LIMIT && !planLimited) {
        planLimited = true;
        log.warn(
          `${FREE_FAILURE_LIMIT} calls in a row failed without spending anything — treating this as ` +
            'the plan\'s rate limit and stopping. The rest are picked up next run.',
        );
      }
      log.warn(`research failed for ${company.name}`, String(err));
      return { ...company, assessment: null, researchedAt: null };
    } finally {
      log.progress(`research ${++done}/${companies.length}`);
    }
  });
  log.progressDone();

  const assessed = out.filter((c) => c.assessment).length;
  log.info(
    `RESEARCH BATCH ${JSON.stringify({
      requested: companies.length,
      assessed,
      failures,
      planLimited,
      costUsd: Number(costUsd.toFixed(2)),
    })}`,
  );
  log.info(
    `Researched ${assessed}/${companies.length} companies ($${costUsd.toFixed(2)})` +
      (failures > 0 ? `, ${failures} failed` : ''),
  );
  if (planLimited) {
    log.warn(
      `Stopped early: ${companies.length - assessed} companies were not researched because the ` +
        'plan\'s rate limit was reached. Re-run once the window resets — they are picked up automatically.',
    );
  }
  return { companies: out, costUsd, failures, planLimited };
}

/** The number the dashboard sorts on. Unassessed companies sink, never vanish. */
export function fitOf(company: RunCompany): number {
  return company.assessment?.fit ?? -1;
}
