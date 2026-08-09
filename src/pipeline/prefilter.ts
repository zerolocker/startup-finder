/**
 * Stage 1 of scoring: a cheap, deterministic ranker with no LLM involved.
 *
 * Its ONLY job is to decide which companies are worth spending an LLM call on.
 * A typical week yields ~1000 candidate companies; scoring all of them with an
 * LLM would cost ~$100 and take an hour. This narrows to the top ~40 for ~$5.
 *
 * Consequences of that framing, which matter if you are tempted to "improve" it:
 *
 *   - It is a TRIAGE score, not a quality judgement. It is never shown to the
 *     user as a verdict and should not be tuned to be "accurate" — only to
 *     avoid discarding companies the LLM would have rated highly.
 *   - Recall matters far more than precision. A false positive costs one LLM
 *     call. A false negative means the user never sees the company at all.
 *   - It works only on what Form D and headlines give us: a name, a dollar
 *     amount, a coarse industry, a location. It cannot know what a company
 *     does. Do not add rules that pretend otherwise.
 *
 * See docs/SCORING.md for the weights and the reasoning behind each.
 */

import type { Company, PrefilterScore, Profile } from '../types.ts';

/** SEC industry buckets, mapped to how promising they are for a tech profile. */
const INDUSTRY_AFFINITY: Record<string, number> = {
  'Computers': 1.0,
  'Other Technology': 1.0,
  'Telecommunications': 0.8,
  'Business Services': 0.6,
  'Biotechnology': 0.5,
  'Pharmaceuticals': 0.4,
  'Other Health Care': 0.4,
  'Health Insurance': 0.2,
  'Hospitals & Physicians': 0.15,
  'Manufacturing': 0.35,
  'Retailing': 0.3,
  'Energy Conservation': 0.35,
  'Environmental Services': 0.3,
  'Electric Utilities': 0.15,
  'Other Energy': 0.15,
  'Tourism & Travel Services': 0.2,
  'Other Travel': 0.15,
  'Other': 0.3,
};

/**
 * Keywords that hint at a theme when all we have is a company name.
 * Crude by necessity — a name is often all Form D gives us.
 */
const THEME_KEYWORDS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(ai|a\.i\.|ml|machine learning|neural|llm|gpt|agent|inference|model)\b/i, weight: 1.0, label: 'AI/ML' },
  { pattern: /\b(data|analytics|warehouse|pipeline|stream|etl)\b/i, weight: 0.7, label: 'data' },
  { pattern: /\b(cloud|infra|infrastructure|compute|kubernetes|serverless|platform)\b/i, weight: 0.7, label: 'infra' },
  { pattern: /\b(dev|developer|devtool|api|sdk|code|coding|build|deploy)\b/i, weight: 0.7, label: 'devtools' },
  { pattern: /\b(secure|security|cyber|privacy|auth|identity|zero trust)\b/i, weight: 0.6, label: 'security' },
  { pattern: /\b(robot|autonomous|drone|lidar|embedded)\b/i, weight: 0.4, label: 'robotics' },
  { pattern: /\b(fintech|payments|banking|ledger|treasury)\b/i, weight: 0.4, label: 'fintech' },
  { pattern: /\b(health|bio|med|clinical|diagnostic|therapeutic)\b/i, weight: 0.3, label: 'health' },
];

/** Anti-theme keywords, applied as a penalty. */
const ANTI_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(crypto|blockchain|token|web3|nft|defi|coin)\b/i, label: 'crypto' },
  { pattern: /\b(cannabis|cbd|dispensary|hemp)\b/i, label: 'cannabis' },
  { pattern: /\b(casino|gaming|gambling|betting|wager)\b/i, label: 'gambling' },
  { pattern: /\b(realty|real estate|property|storage|apartment)\b/i, label: 'real estate' },
  { pattern: /\b(mining|oil|gas|petroleum|drilling)\b/i, label: 'extractive' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between a funding date and now. Returns null for unparseable dates. */
function daysAgo(isoDate: string, now: number): number | null {
  const t = Date.parse(isoDate);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / DAY_MS);
}

/**
 * Score one company. Returns a total in roughly 0-100, though it is not
 * clamped — only the ordering matters.
 */
export function prefilterScore(company: Company, profile: Profile, now: number = Date.now()): PrefilterScore {
  const breakdown: Record<string, number> = {};
  const notes: string[] = [];

  // --- Recency: the entire premise is "recently funded". -------------------
  // Full marks inside 30 days, decaying to zero at 180.
  const age = company.latestFunding ? daysAgo(company.latestFunding.date, now) : null;
  if (age == null) {
    breakdown['recency'] = 0;
    notes.push('no usable funding date');
  } else if (age <= 30) {
    breakdown['recency'] = 30;
  } else if (age <= 180) {
    breakdown['recency'] = 30 * (1 - (age - 30) / 150);
  } else {
    breakdown['recency'] = 0;
    notes.push(`funding is ${Math.round(age)} days old`);
  }

  // --- Raise size: inside the profile's window is what we want. ------------
  const amount = company.latestFunding?.amountUsd ?? null;
  const { minRaiseUsd, maxRaiseUsd } = profile.stage;
  if (amount == null) {
    // Unknown amount is common and not disqualifying — news often omits it.
    breakdown['amount'] = 5;
    notes.push('raise amount unknown');
  } else if (minRaiseUsd != null && amount < minRaiseUsd) {
    // Below the floor: scale down rather than zero, since Form D "sold so far"
    // understates rounds that are still closing.
    breakdown['amount'] = 20 * (amount / minRaiseUsd) * 0.5;
    notes.push(`raise ${Math.round(amount / 1000)}K is below the ${Math.round(minRaiseUsd / 1e6)}M floor`);
  } else if (maxRaiseUsd != null && amount > maxRaiseUsd) {
    breakdown['amount'] = 8;
    notes.push('raise is above the preferred ceiling (likely late stage)');
  } else {
    breakdown['amount'] = 20;
  }

  // --- Industry bucket from the SEC taxonomy. ------------------------------
  const industryLine = company.evidence.find((e) => e.startsWith('SEC industry: '));
  const industry = industryLine?.slice('SEC industry: '.length);
  if (industry) {
    const affinity = INDUSTRY_AFFINITY[industry] ?? 0.25;
    breakdown['industry'] = 15 * affinity;
    if (affinity < 0.3) notes.push(`industry "${industry}" is a weak fit`);
  } else {
    // No EDGAR record — this came from news, which skews tech-relevant anyway.
    breakdown['industry'] = 15 * 0.6;
  }

  // --- Keyword signal from the name and any headline text. -----------------
  const haystack = `${company.name} ${company.evidence.join(' ')}`;
  let themeScore = 0;
  const matchedThemes: string[] = [];
  for (const { pattern, weight, label } of THEME_KEYWORDS) {
    if (pattern.test(haystack)) {
      themeScore = Math.max(themeScore, weight);
      matchedThemes.push(label);
    }
  }
  breakdown['theme'] = 15 * themeScore;
  if (matchedThemes.length > 0) notes.push(`keyword themes: ${matchedThemes.join(', ')}`);

  // --- Anti-themes subtract hard. ------------------------------------------
  let penalty = 0;
  for (const { pattern, label } of ANTI_KEYWORDS) {
    if (pattern.test(haystack)) {
      penalty += 12;
      notes.push(`anti-theme hit: ${label}`);
    }
  }
  breakdown['antiTheme'] = -penalty;

  // --- Geography. ----------------------------------------------------------
  const preferred = profile.geography.preferred.map((g) => g.toUpperCase());
  if (company.location) {
    const state = company.location.split(',').pop()?.trim().toUpperCase() ?? '';
    breakdown['geography'] = preferred.includes(state) ? 8 : 2;
  } else {
    breakdown['geography'] = 3;
  }

  // --- Corroboration: appearing in the press is a real notability signal. ---
  const newsCount = company.sources.filter((s) => s.kind === 'news').length;
  const edgarCount = company.sources.filter((s) => s.kind === 'edgar').length;
  breakdown['coverage'] = Math.min(10, newsCount * 5);
  if (newsCount > 0 && edgarCount > 0) {
    // Corroborated by both an SEC filing and the press — the strongest signal
    // available at this stage that this is a real, notable round.
    breakdown['corroborated'] = 8;
    notes.push('corroborated by both SEC filing and press');
  }

  // --- Team size proxy: a solo-officer filing is often a shell or SPV. ------
  breakdown['team'] = company.people.length >= 3 ? 5 : company.people.length >= 2 ? 3 : 0;
  if (company.people.length === 1) notes.push('only one officer listed');

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, breakdown, notes };
}

/** Score and rank every company, best first. */
export function rankCompanies(
  companies: readonly Company[],
  profile: Profile,
  now: number = Date.now(),
): Array<{ company: Company; prefilter: PrefilterScore }> {
  return companies
    .map((company) => ({ company, prefilter: prefilterScore(company, profile, now) }))
    .sort((a, b) => b.prefilter.total - a.prefilter.total);
}
