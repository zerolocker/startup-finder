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

function renderDossier(dossier: Dossier): string {
  const out: string[] = [];
  out.push(`${dossier.summary}\n`);

  if (dossier.product) out.push(`**Product** — ${dossier.product}\n`);
  if (dossier.team) out.push(`**Team** — ${dossier.team}\n`);
  if (dossier.funding) out.push(`**Funding** — ${dossier.funding}\n`);

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
  out.push('');

  // --- The scannable table -------------------------------------------------
  if (featured.length > 0) {
    out.push('## At a glance');
    out.push('');
    out.push('| | Fit | Company | What they do | Raised | Confidence |');
    out.push('|---|---:|---|---|---:|---|');
    for (const company of featured) {
      const score = Math.round(effectiveScore(company));
      const what = describeCompany(company);
      out.push(
        `| ${scoreBadge(score)} | **${score}** | [${mdEscape(company.name)}](#${anchor(company.name)}) | ${mdEscape(
          what.length > 90 ? `${what.slice(0, 88)}…` : what,
        )} | ${formatUsd(company.latestFunding?.amountUsd ?? null)} | ${confidenceBadge(company.llm?.confidence)} |`,
      );
    }
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

      const meta: string[] = [`**Fit ${score}/100**`];
      if (company.latestFunding) {
        const f = company.latestFunding;
        meta.push(`${formatUsd(f.amountUsd)}${f.round ? ` ${f.round}` : ''} · ${f.date}`);
      }
      if (company.location) meta.push(company.location);
      out.push(meta.join(' · '));
      out.push('');

      if (company.dossier) out.push(renderDossier(company.dossier));

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
    out.push('| Fit | Company | Raised | Date | Location | Note |');
    out.push('|---:|---|---:|---|---|---|');
    for (const company of rest.slice(0, 200)) {
      const score = Math.round(effectiveScore(company));
      const note = company.llm?.whatTheyDo ?? company.prefilter.notes.slice(0, 2).join('; ') ?? '';
      const url = company.sources[0]?.url;
      const name = url ? `[${mdEscape(company.name)}](${url})` : mdEscape(company.name);
      out.push(
        `| ${score} | ${name} | ${formatUsd(company.latestFunding?.amountUsd ?? null)} | ${
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
