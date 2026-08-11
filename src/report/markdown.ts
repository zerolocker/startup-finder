/**
 * The Markdown digest — the primary human-facing output.
 *
 * Design intent: this should be readable top-to-bottom in about five minutes
 * and end with the user knowing which two or three companies to look at. That
 * goal drives the structure — a short ranked table first for scanning, then
 * full dossiers only for the companies that earned one, then the long tail
 * collapsed into a single table so nothing is silently hidden.
 *
 * Everything shown is traceable to a source URL. If a fact has no link, it
 * came from the model and should be labeled as such.
 */

import type { Dossier, ResearchedCompany } from '../types.ts';
import { effectiveScore } from '../pipeline/score.ts';
import { resolveValuation, valuationLabel, valuationRange, type Valuation } from '../pipeline/valuation.ts';
import { formatUsd } from '../util/text.ts';

function confidenceBadge(confidence: 'low' | 'medium' | 'high' | undefined): string {
  if (!confidence) return '';
  return { low: '🌑 low', medium: '🌗 medium', high: '🌕 high' }[confidence];
}

function scoreBadge(score: number): string {
  if (score >= 85) return '🔥';
  if (score >= 70) return '⭐';
  if (score >= 50) return '·';
  return '';
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/**
 * The one-line "what they do" shown in summary tables.
 *
 * Prefers the dossier over the screening score. The screening stage (score.ts)
 * has no web access and correctly says things like "Unknown precisely, but the
 * name suggests…"; the research stage then goes and finds out. Showing the
 * screening guess for a company we actually researched wastes the expensive
 * answer and makes the app look less capable than it is.
 */
export function describeCompany(company: ResearchedCompany): string {
  const dossier = company.dossier;
  if (dossier) {
    const best = dossier.product?.trim() || dossier.summary?.trim();
    if (best) return best;
  }
  return company.llm?.whatTheyDo ?? '—';
}

/** "$9.0M Seed", or just "$9.0M" when press never gave the round a name. */
function raisedCell(company: ResearchedCompany): string {
  const funding = company.latestFunding;
  const amount = formatUsd(funding?.amountUsd ?? null);
  return funding?.round ? `${amount} ${funding.round}` : amount;
}

/**
 * The valuation block for a write-up.
 *
 * A derived range never appears without the arithmetic that produced it — the
 * formula is the entire justification for showing a number nobody published,
 * so the two travel together or not at all (ADR-011).
 */
function renderValuation(valuation: Valuation): string {
  switch (valuation.kind) {
    case 'reported': {
      const { amountUsd, basis, asOf, sourceUrl } = valuation.fact;
      const qualifier = basis === 'unspecified' ? '' : ` ${basis}`;
      const when = asOf ? `, as of ${asOf}` : '';
      return `**Valuation** — ${formatUsd(amountUsd)}${qualifier}, [reported](${sourceUrl})${when}.\n`;
    }
    case 'estimated': {
      const { estimate } = valuation;
      const caveats = estimate.caveats.map((c) => `\n  - ${c}`).join('');
      return (
        `**Valuation (estimated)** — ${valuationRange(estimate)}. ` +
        `No valuation was reported; this is derived, not a fact: ${estimate.method}.${caveats}\n`
      );
    }
    case 'unknown':
      return `**Valuation** — not available (${valuation.reason}).\n`;
  }
}

/** Prior rounds, one per line. Only rendered when research actually found any. */
function renderFundingHistory(dossier: Dossier): string {
  const history = dossier.fundingHistory ?? [];
  if (history.length === 0) return '';

  const rows = history.map((round) => {
    const parts = [round.date ?? 'date unknown', round.round ?? 'unlabelled', formatUsd(round.amountUsd)];
    const lead = round.leadInvestor ? ` — led by ${round.leadInvestor}` : '';
    const others = round.investors.length > 0 ? ` (${round.investors.join(', ')})` : '';
    const cite = round.sourceUrl ? ` [source](${round.sourceUrl})` : '';
    return `- ${parts.join(' · ')}${lead}${others}${cite}`;
  });
  return `**Prior rounds**\n${rows.join('\n')}\n`;
}

/**
 * "Founded 2019 · ~40 people · $745M raised to date".
 *
 * Every part is dropped when null rather than shown as a placeholder — an empty
 * slot says "not found", which is the truth, where "Team size: unknown" three
 * times over just adds noise to a page meant to be skimmed.
 */
function renderFacts(dossier: Dossier): string {
  const parts: string[] = [];
  if (dossier.foundedYear != null) parts.push(`Founded ${dossier.foundedYear}`);
  if (dossier.teamSize != null) parts.push(`~${dossier.teamSize} people`);
  if (dossier.totalRaisedUsd != null) parts.push(`${formatUsd(dossier.totalRaisedUsd)} raised to date`);
  return parts.length > 0 ? `${parts.join(' · ')}\n` : '';
}

function renderDossier(dossier: Dossier, valuation: Valuation): string {
  const out: string[] = [];
  out.push(`${dossier.summary}\n`);

  const facts = renderFacts(dossier);
  if (facts) out.push(facts);

  if (dossier.product) out.push(`**Product** — ${dossier.product}\n`);
  if (dossier.team) out.push(`**Team** — ${dossier.team}\n`);
  if (dossier.funding) out.push(`**Funding** — ${dossier.funding}\n`);

  const history = renderFundingHistory(dossier);
  if (history) out.push(history);

  out.push(renderValuation(valuation));

  if (dossier.openRoles.length > 0) {
    out.push(`**Open roles** — ${dossier.openRoles.map((r) => `\`${r}\``).join(', ')}\n`);
  }
  if (dossier.techStack.length > 0) out.push(`**Stack** — ${dossier.techStack.join(', ')}\n`);
  if (dossier.competitors.length > 0) out.push(`**Competitors** — ${dossier.competitors.join(', ')}\n`);

  if (dossier.greenFlags.length > 0) {
    out.push(`**Reasons to look closer**\n${dossier.greenFlags.map((f) => `- ${f}`).join('\n')}\n`);
  }
  if (dossier.redFlags.length > 0) {
    out.push(`**Reasons for caution**\n${dossier.redFlags.map((f) => `- ${f}`).join('\n')}\n`);
  }
  if (dossier.links.length > 0) {
    out.push(`**Links** — ${dossier.links.map((l) => `[${l.label}](${l.url})`).join(' · ')}\n`);
  }
  return out.join('\n');
}

export interface DigestOptions {
  /** Companies given a full write-up. The rest go in the long-tail table. */
  featureCount?: number;
  runId: string;
  /** Window in days that this digest covers. */
  windowDays: number;
  costUsd: number;
  /** Total candidates considered before ranking. */
  totalCandidates: number;
}

/** Render the full digest. */
export function renderDigest(companies: readonly ResearchedCompany[], opts: DigestOptions): string {
  const { featureCount = 12, runId, windowDays, costUsd, totalCandidates } = opts;
  const generated = new Date().toISOString();
  const date = generated.slice(0, 10);

  const ranked = [...companies].sort((a, b) => effectiveScore(b) - effectiveScore(a));
  const withDossier = ranked.filter((c) => c.dossier);
  const featured = withDossier.slice(0, featureCount);
  const featuredIds = new Set(featured.map((c) => c.id));
  const rest = ranked.filter((c) => !featuredIds.has(c.id));

  const out: string[] = [];

  out.push(`# Startup digest — ${date}`);
  out.push('');
  out.push(
    `Covering funding activity from the last **${windowDays} days**. ` +
      `${totalCandidates} candidates screened, ${ranked.length} ranked, ${withDossier.length} researched in depth` +
      `${featured.length < withDossier.length ? `, top ${featured.length} written up below` : ''}.`,
  );
  out.push('');
  out.push('> Scores are this app\'s judgement of fit against `config/profile.yaml`, not a measure of company quality.');
  out.push('> Anything not backed by a link came from a model and should be verified before you act on it.');
  out.push('> Scores below ~30 are ambiguous — see [Reading the report](../docs/READING_THE_REPORT.md).');
  out.push('');

  // --- The scannable table -------------------------------------------------
  if (featured.length > 0) {
    out.push('## At a glance');
    out.push('');
    out.push('| | Fit | Company | What they do | Raised | Valuation | Confidence |');
    out.push('|---|---:|---|---|---:|---:|---|');
    for (const company of featured) {
      const score = Math.round(effectiveScore(company));
      const what = describeCompany(company);
      out.push(
        `| ${scoreBadge(score)} | **${score}** | [${mdEscape(company.name)}](#${anchor(company.name)}) | ${mdEscape(
          // Tighter than it used to be: the valuation column needs the width.
          what.length > 70 ? `${what.slice(0, 68)}…` : what,
        )} | ${raisedCell(company)} | ${valuationLabel(resolveValuation(company))} | ${confidenceBadge(
          company.llm?.confidence,
        )} |`,
      );
    }
    out.push('');
    out.push('_A valuation marked `est.` was not reported anywhere — it is derived from the raise. Each write-up shows the arithmetic._');
    out.push('');
  }

  // --- Full write-ups ------------------------------------------------------
  if (featured.length > 0) {
    out.push('## The shortlist');
    out.push('');
    for (const company of featured) {
      const score = Math.round(effectiveScore(company));
      out.push(`### ${company.name}`);
      out.push('');

      const valuation = resolveValuation(company);
      const meta: string[] = [`**Fit ${score}/100**`];
      if (company.latestFunding) {
        meta.push(`${raisedCell(company)} · ${company.latestFunding.date}`);
      }
      if (company.location) meta.push(company.location);
      out.push(meta.join(' · '));
      out.push('');

      if (company.dossier) out.push(renderDossier(company.dossier, valuation));

      if (company.llm) {
        out.push(`**Why this scored ${score}** — ${company.llm.rationale}`);
        out.push('');
        if (company.llm.concerns.length > 0) {
          out.push(`**Screening concerns** — ${company.llm.concerns.join('; ')}`);
          out.push('');
        }
      }

      if (company.people.length > 0) {
        const people = company.people
          .slice(0, 6)
          .map((p) => `${p.name}${p.relationships.length ? ` (${p.relationships.join(', ')})` : ''}`)
          .join(' · ');
        out.push(`**On the SEC filing** — ${people}`);
        out.push('');
      }

      out.push(`**Sources** — ${company.sources.map((s) => `[${s.kind}](${s.url})`).join(' · ')}`);
      out.push('');
      out.push('---');
      out.push('');
    }
  }

  // --- Long tail -----------------------------------------------------------
  if (rest.length > 0) {
    out.push(`## Everything else considered (${rest.length})`);
    out.push('');
    out.push('<details>');
    out.push('<summary>Expand — ranked, but not researched in depth</summary>');
    out.push('');
    out.push(
      '_Mixed scores below. Rows with a note in the last column were screened by the model; ' +
        'rows showing only triage notes were never looked at, and their score is capped at 45. ' +
        'A low number here usually means "not examined", not "examined and rejected"._',
    );
    out.push('');
    out.push('| Fit | Company | Raised | Date | Location | Note |');
    out.push('|---:|---|---:|---|---|---|');
    for (const company of rest.slice(0, 200)) {
      const score = Math.round(effectiveScore(company));
      const note = company.llm?.whatTheyDo ?? company.prefilter.notes.slice(0, 2).join('; ') ?? '';
      const url = company.sources[0]?.url;
      const name = url ? `[${mdEscape(company.name)}](${url})` : mdEscape(company.name);
      // No valuation column here on purpose: these rows were never examined, and
      // a derived range is just the raise times a constant. Printing one would
      // imply an analysis that did not happen.
      out.push(
        `| ${score} | ${name} | ${raisedCell(company)} | ${
          company.latestFunding?.date ?? '—'
        } | ${mdEscape(company.location ?? '—')} | ${mdEscape(note.length > 80 ? `${note.slice(0, 78)}…` : note)} |`,
      );
    }
    if (rest.length > 200) out.push(`\n_…and ${rest.length - 200} more in \`data/scored.jsonl\`._`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    `<sub>Generated ${generated} · run \`${runId}\`` +
      // Omit rather than print "$0.00", which reads as "this was free".
      (costUsd > 0 ? ` · LLM cost $${costUsd.toFixed(2)}` : '') +
      ' · Sources: SEC EDGAR Form D + funding press. See `docs/DATA_SOURCES.md` for coverage limits.</sub>',
  );
  out.push('');

  return out.join('\n');
}

/** GitHub-style heading anchor. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
