/**
 * Core domain types for startup-finder.
 *
 * These are the contract between pipeline stages. Every stage reads records of
 * one shape and writes records of another:
 *
 *   FormDFiling ─┐
 *                ├─> Company ─> ScoredCompany ─> ResearchedCompany ─> report
 *   NewsItem ────┘
 *
 * If you change a shape here, run `pnpm typecheck` — the compiler will point at
 * every stage that needs updating. Prefer adding optional fields over changing
 * existing ones, because committed data under data/ was written by older code.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Source records — one per upstream data source, kept close to the raw shape.
// ---------------------------------------------------------------------------

/**
 * A single SEC Form D filing. Form D is filed by (almost) every US company
 * raising private capital under Reg D, within 15 days of first sale. It is the
 * highest-quality *free* structured funding signal that exists.
 *
 * See docs/DATA_SOURCES.md for what this does and does not tell you.
 */
export interface FormDFiling {
  /** SEC Central Index Key, zero-padded. Stable primary key for an issuer. */
  cik: string;
  /** SEC accession number, e.g. "0001798621-26-000003". Unique per filing. */
  accessionNumber: string;
  entityName: string;
  /** ISO date the filing appeared in EDGAR. */
  filedDate: string;
  /** ISO date of first sale in the round, if disclosed. Closer to "when funded". */
  dateOfFirstSale: string | null;
  /** SEC's coarse industry bucket, e.g. "Other Technology". Used to drop funds. */
  industryGroup: string | null;
  /** Total offering size in USD, if disclosed. `null` when "indefinite". */
  totalOfferingAmount: number | null;
  /** USD actually sold so far. This is the number that means "they raised X". */
  totalAmountSold: number | null;
  totalRemaining: number | null;
  /** Count of investors who have already bought in. */
  investorCount: number | null;
  /** True if this amends an earlier filing — usually a follow-on close. */
  isAmendment: boolean;
  jurisdictionOfIncorporation: string | null;
  entityType: string | null;
  /** Self-reported revenue bucket. Usually "Decline to Disclose". */
  revenueRange: string | null;
  /** Officers, directors, and promoters listed on the filing. */
  relatedPersons: RelatedPerson[];
  address: Address | null;
  /** Canonical EDGAR URL for a human to open. */
  filingUrl: string;
}

export interface RelatedPerson {
  name: string;
  relationships: string[];
}

export interface Address {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** A funding-news article from an RSS feed. */
export interface NewsItem {
  /** Stable hash of the URL — used for dedupe across runs. */
  id: string;
  title: string;
  url: string;
  /** ISO timestamp of publication. */
  publishedAt: string;
  /** Feed slug, e.g. "techcrunch-venture". */
  source: string;
  /** Plain-text summary/excerpt, HTML stripped. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Merged entity — what the rest of the pipeline reasons about.
// ---------------------------------------------------------------------------

/**
 * A candidate company, assembled from one or more source records.
 *
 * Companies are keyed by {@link Company.id}, a slug derived from the normalized
 * name. EDGAR filings and news items about the same company merge into one
 * record; see src/pipeline/merge.ts for the matching rules and their limits.
 */
export interface Company {
  /** Slug of the normalized name, e.g. "flo-artificial-intelligence". */
  id: string;
  /** Best display name available across sources. */
  name: string;
  /** Name with legal suffixes and punctuation stripped, for matching. */
  normalizedName: string;
  /** Which sources contributed to this record. */
  sources: SourceRef[];
  /** Most recent funding event we know about. */
  latestFunding: FundingEvent | null;
  /** All funding events, newest first. */
  fundingEvents: FundingEvent[];
  location: string | null;
  /** People pulled from Form D filings — founders, officers, directors. */
  people: RelatedPerson[];
  /** Free-text signal for the LLM: headlines, industry group, etc. */
  evidence: string[];
  /** ISO timestamp this record was first created. */
  firstSeenAt: string;
  /** ISO timestamp this record was last touched by an ingest. */
  lastUpdatedAt: string;
}

export interface SourceRef {
  kind: 'edgar' | 'news';
  /** accessionNumber for edgar, NewsItem.id for news. */
  ref: string;
  url: string;
}

export interface FundingEvent {
  /** ISO date. For EDGAR this is dateOfFirstSale, falling back to filedDate. */
  date: string;
  /** USD raised, when known. */
  amountUsd: number | null;
  /** Round label ("Seed", "Series A") — only ever known from news, never EDGAR. */
  round: string | null;
  /** Investor names, when known. EDGAR does not provide these. */
  investors: string[];
  source: 'edgar' | 'news';
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Scoring — see docs/SCORING.md for the rationale behind every weight.
// ---------------------------------------------------------------------------

/**
 * Cheap, deterministic, no-LLM score. Its only job is to rank candidates so the
 * expensive LLM pass looks at the most promising ~50 instead of all ~3000.
 * Never shown to the user as a quality judgement.
 */
export interface PrefilterScore {
  total: number;
  /** Per-signal contributions, kept for debuggability. */
  breakdown: Record<string, number>;
  /** Human-readable reasons, useful when a company is unexpectedly missing. */
  notes: string[];
}

/** The LLM's judgement of one company against the user's profile. */
export const LlmScoreSchema = z.object({
  /** 0-100. Calibrated by the rubric in src/pipeline/score.ts. */
  fit: z.number().min(0).max(100),
  /** What the company actually does, in one sentence. */
  whatTheyDo: z.string(),
  /** Which profile interests this hits. */
  matchedInterests: z.array(z.string()),
  /** Honest reasons this might be a bad fit. */
  concerns: z.array(z.string()),
  /** One-paragraph argument for why this is or is not worth the user's time. */
  rationale: z.string(),
  /** How confident the model is given the evidence it had. */
  confidence: z.enum(['low', 'medium', 'high']),
});
export type LlmScore = z.infer<typeof LlmScoreSchema>;

export interface ScoredCompany extends Company {
  prefilter: PrefilterScore;
  llm: LlmScore | null;
}

/** Deep-research dossier, produced only for the top-ranked companies. */
export const DossierSchema = z.object({
  summary: z.string(),
  /** The problem they solve and for whom. */
  product: z.string(),
  /** Team background — prior companies, notable founders. */
  team: z.string(),
  /** Funding history and investors, as far as the web reveals. */
  funding: z.string(),
  /** Roles they are hiring for — the key signal for "should I join". */
  openRoles: z.array(z.string()),
  /** Publicly visible tech stack, when discoverable. */
  techStack: z.array(z.string()),
  /** Named competitors. */
  competitors: z.array(z.string()),
  /** Things that should give the user pause. */
  redFlags: z.array(z.string()),
  /** Concrete reasons this is worth a conversation. */
  greenFlags: z.array(z.string()),
  /** Careers page, homepage, LinkedIn — wherever the user should go next. */
  links: z.array(z.object({ label: z.string(), url: z.string() })),
});
export type Dossier = z.infer<typeof DossierSchema>;

export interface ResearchedCompany extends ScoredCompany {
  dossier: Dossier | null;
  researchedAt: string | null;
}

// ---------------------------------------------------------------------------
// User profile — the single knob that controls what "good" means.
// ---------------------------------------------------------------------------

export const ProfileSchema = z.object({
  /** Free-text description of the user. Fed verbatim to the LLM. */
  about: z.string(),
  /** Are we looking for a job, a cheque, or both? Changes the scoring rubric. */
  intent: z.array(z.enum(['join', 'invest'])).min(1),
  interests: z.object({
    /** Domains that earn points. Weight is a multiplier, 0-1. */
    themes: z.array(z.object({ name: z.string(), weight: z.number().min(0).max(1) })),
    /** Hard-ish negatives — these subtract. */
    antiThemes: z.array(z.string()),
  }),
  stage: z.object({
    /** USD. Rounds below this are usually too early/unstable to join. */
    minRaiseUsd: z.number().nullable(),
    /** USD. Rounds above this are usually past the interesting equity window. */
    maxRaiseUsd: z.number().nullable(),
  }),
  geography: z.object({
    /** Two-letter state or country codes that earn points. */
    preferred: z.array(z.string()),
    /** If true, a remote-friendly company anywhere is acceptable. */
    remoteOk: z.boolean(),
  }),
  /** Anything else the LLM should weigh. Free text, one bullet per line. */
  notes: z.array(z.string()),
});
export type Profile = z.infer<typeof ProfileSchema>;

// ---------------------------------------------------------------------------
// Run metadata — every pipeline run records what it did, for reproducibility.
// ---------------------------------------------------------------------------

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  /** Which stages ran, and what they produced. */
  stages: Record<string, { ok: boolean; count: number; ms: number; error?: string }>;
  /** Total USD spent on LLM calls in this run. */
  costUsd: number;
}
