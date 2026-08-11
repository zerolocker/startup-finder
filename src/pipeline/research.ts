/**
 * Stage 3: deep research on the shortlist, using Claude with web search.
 *
 * This is where the app stops being a filter and starts being an assistant.
 * Everything upstream works from a company name and a dollar figure; this
 * stage actually goes and reads the company's site, its careers page, and any
 * coverage, then writes the briefing the user reads.
 *
 * It is also by far the most expensive stage (~$0.15 and ~20s per company), so:
 *   - Only the top N companies by LLM fit get researched.
 *   - Dossiers are persisted in data/dossiers.jsonl and never regenerated for
 *     a company we already researched, unless --refresh is passed.
 *
 * The prompt leans hard on "say you couldn't find it" over guessing. A dossier
 * that invents a plausible-sounding product description is worse than useless:
 * the user would act on it, and it would be wrong.
 */

import type { Company, Dossier, ResearchedCompany, ScoredCompany } from '../types.ts';
import { DossierSchema } from '../types.ts';
import { loadProfile } from '../config.ts';
import { runClaudeJson, type ModelAlias } from '../llm/claude.ts';
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
 * Build the exact prompt sent for one company.
 *
 * Exported for the same reason as buildScorePrompt: this stage is the most
 * expensive and the most capable of confident nonsense, so being able to read
 * the literal text — free, via `pnpm sf prompt --stage research` — is the
 * fastest way to understand or debug a dossier.
 */
export function buildResearchPrompt(company: Company, profileText: string): string {
  return `Research this recently-funded startup and write a briefing for the person described below. Use web search — you have it available and you should use it.

${profileText}

WHAT WE ALREADY KNOW (from SEC filings and/or press):
${knownFacts(company)}

YOUR TASK:
Search the web to find out who this company actually is. Good queries: the
company name plus "funding", plus "careers", plus a founder's name. Check the
company's own site and careers page if you can find it.

BE HONEST ABOUT UNCERTAINTY. This is the most important instruction:
- Company names are ambiguous. If the search results are about a DIFFERENT
  company with a similar name, say so and do not use those results.
- If you cannot confidently identify the company, say exactly that in "summary"
  and leave the other fields empty or minimal. An empty dossier is a useful
  result; a fabricated one is actively harmful.
- Never invent open roles, investor names, funding amounts, or team backgrounds.
  Only report what you actually found. Empty arrays are expected and fine.
- Prefer the company's own site and reputable press over aggregator pages,
  which are frequently stale or wrong.

Respond with ONLY a JSON object, no prose and no markdown fences:
{
  "summary": "<2-4 sentences: who they are, what they do, why it may or may not matter. If you could not identify them, say so here.>",
  "product": "<what they build and for whom, or \\"\\" if unknown>",
  "team": "<founder and team backgrounds you actually found, or \\"\\" if unknown>",
  "funding": "<funding history and named investors you actually found, or \\"\\" if unknown>",
  "openRoles": ["<specific role titles found on their careers page>"],
  "techStack": ["<technologies you found evidence of>"],
  "competitors": ["<named competitors>"],
  "redFlags": ["<specific, evidence-based concerns>"],
  "greenFlags": ["<specific, evidence-based positives>"],
  "links": [{"label": "<e.g. Homepage, Careers, LinkedIn>", "url": "<url>"}]
}`;
}

export interface ResearchOptions {
  model?: ModelAlias;
  /** Parallel research calls. Each is slow, so a few helps a lot. */
  concurrency?: number;
  timeoutMs?: number;
}

export interface ResearchResult {
  researched: ResearchedCompany[];
  costUsd: number;
  failures: number;
}

/**
 * Produce dossiers for the given companies.
 *
 * @param existing dossiers already on disk, keyed by company id — these are
 *   reused verbatim so reruns cost nothing for companies already covered.
 */
export async function researchCompanies(
  companies: readonly ScoredCompany[],
  existing: ReadonlyMap<string, { dossier: Dossier; researchedAt: string }>,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const { model = 'sonnet', concurrency = 3, timeoutMs = 240_000 } = opts;
  if (companies.length === 0) return { researched: [], costUsd: 0, failures: 0 };

  const profile = await loadProfile();
  const { profileToPrompt } = await import('../config.ts');
  const profileText = profileToPrompt(profile);

  let costUsd = 0;
  let failures = 0;
  let done = 0;

  const results = await mapWithConcurrency(companies, concurrency, async (company): Promise<ResearchedCompany> => {
    const cached = existing.get(company.id);
    if (cached) {
      log.progress(`research ${++done}/${companies.length} (cached: ${company.name})`);
      return { ...company, dossier: cached.dossier, researchedAt: cached.researchedAt };
    }

    try {
      const { value, costUsd: cost } = await runClaudeJson(buildResearchPrompt(company, profileText), DossierSchema, {
        model,
        allowedTools: ['WebSearch', 'WebFetch'],
        timeoutMs,
      });
      costUsd += cost;
      return { ...company, dossier: value, researchedAt: new Date().toISOString() };
    } catch (err) {
      failures++;
      log.warn(`research failed for ${company.name}`, String(err));
      return { ...company, dossier: null, researchedAt: null };
    } finally {
      log.progress(`research ${++done}/${companies.length}`);
    }
  });
  log.progressDone();

  const fresh = results.filter((r) => r.dossier && !existing.has(r.id)).length;
  log.info(`Researched ${fresh} new companies ($${costUsd.toFixed(2)}), ${failures} failed`);

  return { researched: results, costUsd, failures };
}
