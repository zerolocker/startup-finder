/**
 * Stage 2 of scoring: the LLM judges shortlisted companies against the profile.
 *
 * This is the middle tier of a three-tier funnel:
 *
 *   prefilter.ts   free,      all ~1000 companies  -> top ~120
 *   score.ts       ~$0.02 ea, top ~120             -> top ~25   (you are here)
 *   research.ts    ~$0.15 ea, top ~25              -> dossiers
 *
 * Two choices keep this tier affordable:
 *
 *   - **Batching.** Companies are scored in groups, so the rubric and profile
 *     (the bulk of the prompt) are sent once per batch rather than once per
 *     company. That is roughly a 6-8x cost reduction.
 *   - **No web search.** This tier judges only what EDGAR and headlines gave
 *     us. It will often say "I don't know what this company does" — and that
 *     is correct behavior, not a bug. Finding out is research.ts's job, and it
 *     costs 7x more per company, which is why only the survivors get it.
 */

import { z } from 'zod';
import type { Company, LlmScore, PrefilterScore, Profile, ScoredCompany } from '../types.ts';
import { LlmScoreSchema } from '../types.ts';
import { profileToPrompt } from '../config.ts';
import { runClaudeJson, type ModelAlias } from '../llm/claude.ts';
import { formatUsd, truncate } from '../util/text.ts';
import { log } from '../util/log.ts';

/** The model returns one entry per company in the batch, keyed by our id. */
const BatchScoreSchema = z.object({
  scores: z.array(LlmScoreSchema.extend({ id: z.string() })),
});

/**
 * The rubric. This is the single most important prompt in the app — it is what
 * turns "a company raised money" into "you should care about this company".
 *
 * Guidance for future agents editing it:
 *   - Anchor the bands with concrete descriptions. Numbers alone drift.
 *   - Insist on evidence-based humility: with only a name and a dollar amount,
 *     the honest answer is often a low-confidence mid score. A model that
 *     confidently invents a product description poisons the whole report.
 *   - Keep "unknown" cheap and "wrong" expensive, in that order.
 */
function rubric(profile: Profile): string {
  const forJoining = profile.intent.includes('join');
  const forInvesting = profile.intent.includes('invest');

  const lens = [
    forJoining
      ? '- As a PLACE TO WORK: technical depth of the problem, seniority of the engineering challenges, whether an engineer would have real leverage, and team quality.'
      : '',
    forInvesting
      ? '- As an INVESTMENT: market size, defensibility, traction signals, and quality of the round.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `You are screening recently-funded startups on behalf of one specific person.

${profileToPrompt(profile)}

Evaluate each company through this lens:
${lens}

SCORING BANDS for "fit" (0-100):
  85-100  Rare. Strong thematic match AND clear evidence this is a substantial
          technical company. You would tell this person to drop what they are
          doing and look at it.
  70-84   Strong match on the profile's top themes, evidence is credible.
          Worth a serious look.
  50-69   Plausible match, but the evidence is thin or the theme is mid-weight.
          Worth a glance if the week is quiet.
  30-49   Weak or uncertain match. Probably not worth their time.
  0-29    Clear mismatch, an anti-theme, or evidently not an operating tech
          company (shell entity, SPV, local business, real-estate vehicle).

CRITICAL RULES:
1. You are given ONLY an SEC filing record and/or a news headline. You do NOT
   have web access here. Do NOT invent a product description. If the name and
   evidence do not tell you what the company does, say so plainly in
   "whatTheyDo" (e.g. "Unknown — name suggests X but there is no evidence") and
   set confidence to "low".
2. A low-confidence score is not a low score. A company with a promising name
   and a solid raise in a relevant industry can score 60 with low confidence.
   Reserve scores under 30 for things you are confident are a bad fit.
3. Many of these entities are NOT startups — they are holding companies, local
   businesses, or investment vehicles that slipped past our filters. Score
   those under 20 and say why.
4. Weight the person's stated interests by their listed importance. An exact
   hit on a 1.0-weight theme should outscore a loose hit on a 0.4-weight theme.
5. "concerns" must be real and specific. Do not pad it. An empty array is fine.`;
}

/** Compact, token-efficient rendering of what we know about a company. */
function renderCompany(company: Company, prefilter: PrefilterScore): string {
  const parts: string[] = [`id: ${company.id}`, `name: ${company.name}`];

  const funding = company.latestFunding;
  if (funding) {
    const bits = [`amount: ${formatUsd(funding.amountUsd)}`, `date: ${funding.date}`, `via: ${funding.source}`];
    if (funding.round) bits.push(`round: ${funding.round}`);
    parts.push(bits.join(', '));
  }
  if (company.location) parts.push(`location: ${company.location}`);
  if (company.people.length > 0) {
    const people = company.people
      .slice(0, 6)
      .map((p) => `${p.name}${p.relationships.length ? ` (${p.relationships.join('/')})` : ''}`)
      .join('; ');
    parts.push(`people: ${people}`);
  }
  for (const line of company.evidence.slice(0, 5)) parts.push(truncate(line, 300));
  if (prefilter.notes.length > 0) parts.push(`triage notes: ${prefilter.notes.join('; ')}`);

  return parts.join('\n  ');
}

export interface ScoreOptions {
  /** Companies per LLM call. Higher is cheaper but degrades attention. */
  batchSize?: number;
  model?: ModelAlias;
  /** Parallel batches in flight. */
  concurrency?: number;
}

export interface ScoreResult {
  scored: ScoredCompany[];
  costUsd: number;
  failures: number;
}

/**
 * Build the exact prompt sent to the model for one batch.
 *
 * Exported so it can be unit-tested and inspected (`pnpm sf prompt`) without
 * spending money. This is the most consequential prompt in the app; being able
 * to read the literal text that gets sent — profile, rubric, and rendered
 * company records — is the fastest way to debug a bad score.
 */
export function buildScorePrompt(
  batch: ReadonlyArray<{ company: Company; prefilter: PrefilterScore }>,
  profile: Profile,
): string {
  const body = batch.map(({ company, prefilter }) => `- ${renderCompany(company, prefilter)}`).join('\n\n');

  return `${rubric(profile)}

COMPANIES TO SCORE (${batch.length}):

${body}

Respond with ONLY a JSON object, no prose and no markdown fences:
{"scores": [{"id": "<the id given above, copied exactly>", "fit": <0-100>, "whatTheyDo": "<one sentence, or an explicit 'Unknown — ...'>", "matchedInterests": ["<theme names from the profile>"], "concerns": ["<specific concerns>"], "rationale": "<2-3 sentences arguing your score>", "confidence": "low"|"medium"|"high"}]}

Return exactly ${batch.length} entries, one per company, using the ids exactly as given.`;
}

/**
 * Score a shortlist with the LLM.
 *
 * A batch that fails validation twice is skipped rather than aborting the run —
 * the companies in it keep `llm: null` and still appear in reports, ranked by
 * their prefilter score alone. Losing 8 companies is better than losing a run.
 */
export async function scoreCompanies(
  candidates: ReadonlyArray<{ company: Company; prefilter: PrefilterScore }>,
  profile: Profile,
  opts: ScoreOptions = {},
): Promise<ScoreResult> {
  const { batchSize = 8, model = 'sonnet', concurrency = 3 } = opts;
  if (candidates.length === 0) return { scored: [], costUsd: 0, failures: 0 };

  const batches: Array<typeof candidates> = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  const byId = new Map<string, LlmScore>();
  let costUsd = 0;
  let failures = 0;
  let done = 0;

  const { mapWithConcurrency } = await import('../util/http.ts');
  await mapWithConcurrency(batches, concurrency, async (batch) => {
    const prompt = buildScorePrompt(batch, profile);

    try {
      const { value, costUsd: cost } = await runClaudeJson(prompt, BatchScoreSchema, { model });
      costUsd += cost;
      for (const { id, ...score } of value.scores) byId.set(id, score);
    } catch (err) {
      failures++;
      log.warn(`scoring batch failed, companies keep prefilter-only ranking`, String(err));
    } finally {
      log.progress(`scoring batch ${++done}/${batches.length}`);
    }
  });
  log.progressDone();

  const scored: ScoredCompany[] = candidates.map(({ company, prefilter }) => ({
    ...company,
    prefilter,
    llm: byId.get(company.id) ?? null,
  }));

  // Rank by LLM fit when we have it; companies the LLM never saw or failed on
  // fall back to their (much smaller) prefilter score so they sort below.
  scored.sort((a, b) => effectiveScore(b) - effectiveScore(a));

  log.info(`Scored ${byId.size}/${candidates.length} companies with the LLM ($${costUsd.toFixed(2)})`);
  return { scored, costUsd, failures };
}

/**
 * The number used for ranking and display.
 *
 * LLM fit when available. Otherwise the prefilter total, scaled into a
 * comparable range but capped at 45 so an unscored company can never outrank a
 * genuinely LLM-validated one.
 */
export function effectiveScore(company: ScoredCompany): number {
  if (company.llm) return company.llm.fit;
  return Math.min(45, company.prefilter.total * 0.5);
}
