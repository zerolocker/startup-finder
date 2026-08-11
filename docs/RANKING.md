# Ranking

_How this app should rank, why the current design cannot, and what to measure._

This is the design specification for [ROADMAP item 2b](ROADMAP.md). It does not
describe what the code does today — [SCORING.md](SCORING.md) does that. Read this
before changing anything about how candidates are filtered or ordered.

Everything numeric below is derived from the committed `data/scored.jsonl` of the
run described in [READING_THE_REPORT.md](READING_THE_REPORT.md) (324 companies,
312 screened). Reproduce with `pnpm sf score --limit 324` and compare against
`rankCompanies()` order, as [SCORING.md](SCORING.md) already prescribes.

---

## The app as an information-retrieval problem

It is a **cascade ranker with one user and a persistent query**:

| IR concept | here |
|---|---|
| query | `config/profile.yaml` — themes, weights, anti-themes, free-text `about` |
| corpus | the week's newly-funded companies (~324 after merge) |
| document | whatever is known about one company |
| L0 retriever | `prefilter.ts` — deterministic, ranks and cuts to `--limit` |
| L1 ranker | `score.ts` — batched LLM screen, no web access |
| L2 re-ranker | `research.ts` — web search, top `--research` |
| presentation | top 12, plus a long-tail table |

The objective is **NDCG@12** — the digest shows twelve companies and the user
reads from the top — with **recall@k of every gate** as the guardrail, because a
company dropped by a gate can never be recovered by a better ranker downstream.

## The diagnosis

### 1. The documents are nearly empty, and that caps everything

For 299 of 324 companies the entire document is a legal entity name, a dollar
amount, an SEC industry code, a state, and a few officer names. Nothing says what
the company does. The screen is honest about it: `whatTheyDo` begins with
"Unknown" for **191 of 312 (61%)** screened companies.

This is the ceiling. **No ranking algorithm improves NDCG over documents with no
content**, so every proposal below that is not about representation is secondary.

### 2. The prefilter's ordering is close to noise, and its heaviest signal points the wrong way

Per-signal correlation against the screen's `fit`, across all 312 screened:

| signal | max pts | sd | r vs `llm.fit` |
|---|---:|---:|---:|
| recency | 30 | 10.33 | **−0.103** |
| amount | 20 | 8.60 | +0.331 |
| industry | 15 | 4.69 | **+0.454** |
| theme | 15 | 4.09 | +0.255 |
| coverage | 10 | 1.44 | +0.268 |
| antiTheme | −12 ea | 1.65 | +0.157 |
| geography | 8 | 2.80 | +0.112 |
| team | 5 | 2.26 | +0.094 |
| corroborated | 8 | 0 | never fires |

Composite: **r = 0.394**, Spearman **ρ = 0.374**, and as a ranking:

| | NDCG |
|---|---:|
| NDCG@10 | 0.472 |
| **NDCG@12** | **0.500** |
| NDCG@25 | 0.540 |
| NDCG@50 | 0.506 |

The signal carrying the most weight is the only negative one. The best signal is
capped at 15. `corroborated` — described in SCORING.md as "the strongest signal
available pre-LLM" — has never fired, because no company in the corpus has both
an EDGAR filing and merged press ([ADR-004](DECISIONS.md)).

Note this does not contradict SCORING.md's defence of recency, which is a premise
argument ("recency is a fact, every other signal is a guess"), not a predictive
one. It was simply never measured.

### 3. `theme` is a regex over the company's legal name

`theme == 0` for **234 of 312** companies, and for **6 of the 8** scoring ≥ 70.
For an EDGAR-only company `evidence` holds only `"SEC industry: X"` and
`"N investors in this round"`, so the keyword table has nothing to match but the
name — and good companies do not put their category in their legal name:

```
fit 88   prefilter #131   theme  0.0   Taktile Holding, Inc.
fit 80   prefilter #  8   theme 15.0   HappyRobot
fit 78   prefilter # 16   theme  0.0   Inferra Inc.
fit 78   prefilter # 60   theme  0.0   Legaltech Wordsmith
fit 78   prefilter #158   theme  0.0   ProrataAI, Inc.
fit 76   prefilter # 68   theme  0.0   Core Automation, Inc.
fit 74   prefilter #  5   theme 10.5   Omilia
fit 74   prefilter # 69   theme  0.0   Oxide Computer Co
```

### 4. There are five gates, not two

| gate | keeps | drops | where |
|---|---:|---:|---|
| `isLikelyOperatingStartup()` regex | 316 | **~1,258** | `src/sources/edgar.ts` |
| prefilter `slice(0, --limit)` | 120 | 204 | `src/cli.ts` |
| research `slice(0, --research)` | 15 | — | `src/cli.ts` |
| feature `withDossier.slice(0, 12)` | 12 | 5 | `src/report/markdown.ts` |
| long-tail table row cap | 200 | 112 | `src/report/markdown.ts` |

Two consequences are easy to miss. The **largest loss is at ingest** — 80% of the
corpus, by regex, upstream of both LLM stages, and never revisited; the docs
already concede it catches "a genuine startup named '… Capital' or structured as
an LP". And the **200-row cap already violates** the "nothing silently dropped
after merge" invariant in [ARCHITECTURE.md](ARCHITECTURE.md) for ~35% of the tail.

### 5. Recall is not monotonic in the threshold

| threshold | relevant | caught | missed | recall@120 |
|---|---:|---:|---:|---:|
| fit ≥ 70 | 8 | 6 | 2 | 75.0% |
| fit ≥ 60 | 18 | 16 | 2 | 88.9% |
| fit ≥ 50 | 40 | 29 | 11 | **72.5%** |

The prefilter is *worse* on the broad band than on the narrow one. It is not
merely imprecise at the margin; it is close to uninformative about the middle of
the distribution.

### 6. Measured on a live incremental run

Ingesting one further business day (206 filings → 52 kept → 378 companies) and
re-running `score --limit 120` exposed two failures that the static analysis above
only implied.

**The gate evicts companies that were already paid for.** `stageScore` reads
`companies.jsonl`, never `scored.jsonl`, and rewrites the whole file — so any
company outside *this* run's top 120 is reset to `llm: null` even if a previous
run had scored it. One day of new filings discarded **211 existing LLM scores**,
among them:

```
was fit 88  ->  now unscreened   Taktile Holding, Inc.
was fit 78  ->  now unscreened   ProrataAI, Inc.
was fit 65  ->  now unscreened   KEA Cloud, Inc.
```

The best company this app has ever surfaced — the subject of the recall
measurement in [SCORING.md](SCORING.md) — silently left the corpus because
unrelated companies filed on a later date. This is not merely a ranking miss:
it is destroying results that plan usage was already spent on, and it gets worse
every week as the corpus grows. Ungating (B) removes the mechanism entirely;
until then, `stageScore` should merge prior scores forward.

**Batch-composition dependence is large.** Of 101 companies re-scored in both
runs from byte-identical input data, **89 changed score**, mean |Δ| = **7.0**,
max **29**:

```
33 ->  62   (+29)  Malted AI Ltd
62 ->  40   (−22)  Valoros, Inc.
58 ->  36   (−22)  Proactive AI Lab, Inc.
34 ->  55   (+21)  Contrivian Inc
```

A ±7 average wobble is comparable to the width of the scoring bands, so batch
composition alone reshuffles the ranking. This is the defect
[ADR-015](DECISIONS.md) describes, now with a number, and it also means **cross-run
score comparisons are not currently meaningful** — including any eval built on
them.

**Cost.** Ingest and merge are free. Screening cost **$0.027/company**
(~$0.18–0.22 per batch of 8); research cost **~$0.40/company** on a cache miss.
The whole incremental run — 378 companies merged, 120 screened, 8 researched,
both reports — came to **$3.20-equivalent in about nine minutes**. Screening the
full 378 instead of the top 120 would be roughly **$8–10** per run at today's
prices, which is the price of (B).

## What these numbers are, and are not

There are **no ground-truth relevance labels** in this repo. Every figure above
uses the screen's own `fit` as **pseudo-relevance** (≥70 → 3, ≥50 → 2, ≥30 → 1,
else 0) — the same convention SCORING.md already uses for recall@120, made
rank-aware.

That is legitimate for judging any stage **below** the screen, and circular for
judging the screen itself. Three tiers, and it matters that they never get mixed:

| tier | source | cost | can evaluate | cannot evaluate |
|---|---|---|---|---|
| pseudo | `llm.fit` as relevance | free | prefilter, gates, retrieval | the screen (circular) |
| oracle | strong model + research grading the pool | high, one-off | ranker variants, broad sweeps | its own taste bias |
| human | `review-startups` grades | scarce | everything | — |

---

## Target architecture

### A. Enrich documents before ranking

A stage between `merge` and ranking, persisted to `data/profiles.jsonl` keyed by
company id and **durable across runs** — a company's website does not change week
to week, so the cost amortizes even though the first pass is expensive.

1. **Domain resolution**: name + officers + city/state + industry → canonical
   domain. Cheapest first — heuristic guesses (`slug.com|.ai|.io`) verified by
   fetching and checking the page names the company or an officer; then a web
   search using officers and city as disambiguators; then public ATS board slugs.
2. **Document assembly**: homepage, `/about`, careers page, linked article bodies
   → ~2k tokens, over `src/util/http.ts` so it is rate-limited and cached. No LLM
   needed once the domain is known.
3. **Extraction**: what they do, product category, customer type, tech keywords,
   headcount hints, open roles by seniority and function.

Resolution **must be able to return `null`**, and must record a confidence. A
wrong domain is worse than no domain: it fabricates an entire document, and every
downstream stage will then describe the wrong company fluently and consistently.
That is the failure [VISION.md](VISION.md)'s "unknown is cheap, wrong is
expensive" exists to prevent, and enrichment is where it would enter.

The research stage already proves the mechanism — it turned "Proactive AI Lab,
Inc." into "Palona AI, voice agents for restaurants". This moves that capability
upstream of ranking, where it can affect *which* companies get picked.

Two byproducts. Hiring signals arrive early enough to rank on
([ROADMAP item 2](ROADMAP.md)), and a resolved domain is a far better join key
than a name — **compatible with [ADR-004](DECISIONS.md)**, since a domain is
auditable in the way that ADR demands of an alias map, merely derived rather than
hand-curated.

### B. Retrieval orders; it does not gate

The prefilter's stated justification is cost: "scoring 330 companies costs 3x what
scoring 120 does, for essentially the same top-20". With the spend cap gone
([ADR-011](DECISIONS.md)) the premise is weaker, and NDCG@12 = 0.500 shows the
"same top-20" half was never true.

So the composite score, `rankCompanies()`, the `slice(0, --limit)` gate,
`effectiveScore()`'s 45-point cap, and the `llm: null` state all go. What may
survive is a thinner *eligibility* check — is this an operating company, is it in
the funding window. Every company gets a real score, which incidentally dissolves
the sub-30 ambiguity documented in [READING_THE_REPORT.md](READING_THE_REPORT.md).

Once nothing is gated, dense retrieval buys only a tie-break, so **embeddings are
not proposed** — see [ADR-014](DECISIONS.md), which differs from ROADMAP 2b here.

The ingest regex deserves the same scrutiny: route the ~1,258 dropped filings
through one cheap triage pass and measure the false-negative rate. It is the
largest single recall loss in the system and has never been measured.

### C. Listwise for order, pointwise for the label

**Do not attempt a global order built out of local slates.** NDCG@12 depends only
on the head; the relative order of #200 and #201 is unobservable. So:

1. **Pointwise over the whole corpus** — every company gets `fit`, `rationale`,
   `confidence`. The report needs these anyway, and they bucket well enough.
2. **Listwise refinement over the top ~40 only** — two or three overlapping
   windows, or one slate if the model holds 40 comfortably.

Two mechanisms that are easy to conflate:

- **Listwise permutation ranking** — the model receives a slate and returns *the
  ids in ranked order*. The output is a permutation, not a score per item.
- **Order-shuffled ensembling** — re-running a slate several times with the input
  order shuffled, aggregating by Borda count.

The defect this fixes is **batch-composition dependence**: batches of 8 are scored
independently, so a 72 from one batch and a 72 from another were never compared.
Fine for a cutoff, wrong for a ranking. **Position bias** is a different thing —
the tendency of listwise prompting to favour whatever appeared early in the input.
It is a risk *introduced* by step 2, and it is what the shuffled ensembling
defends against. Keep the two straight when writing prompts or reading results.

Cheap experiment before building any of it: re-score one company in a strong batch
and in a weak batch and measure the delta. If it is small, calibration anchors —
a few fixed reference companies present in every slate — may be enough on their own.

Rejected alternatives:

- **Sliding window over all 324** (RankGPT-style, swept bottom-to-top). It does
  globalize: overlapping windows let a bottom item reach the top in one pass. But
  it needs a decent *initial* order, which (B) deletes.
- **Merge sort with an LLM comparator.** O(n log n) calls, and it assumes a
  transitivity that LLM pairwise comparators do not reliably provide.

### D. Three objectives, not one blended score

NDCG assumes a single relevance dimension. This user has three:

| dimension | what it answers | today |
|---|---|---|
| topical fit | is the work interesting | the `fit` score |
| joinability | are they hiring a role I would take | found at stage 3, too late to affect selection |
| freshness | is this recent | 30 points of the prefilter |

Freshness becomes what it already is — the lookback window — rather than the
heaviest ranking term. Joinability becomes first-class once (A) supplies the
careers page. Rank on fit, show joinability alongside, and diversify the final
twelve with MMR: a weekly digest optimizes marginal utility, and twelve
near-identical AI-infra companies is a worse digest than eight plus four.

### E. Measurement

`data/labels.jsonl` — `{companyId, grade, rank, at, runId}`, graded
**0 = ignored · 1 = opened · 2 = saved**, collected by the `review-startups`
skill. Three levels are enough for graded NDCG.

Two biases the label pipeline must preserve rather than smooth over:

- **Unexamined companies are absent, never 0.** Otherwise every eval concludes
  that whatever the ranker buried deserved burying — self-confirming and invisible.
- **`rank` is recorded** because attention decays down a long list; a 0 at rank
  300 is far weaker evidence than a 0 at rank 5.

`pnpm sf eval` (not built) should formalize the reproduction recipe SCORING.md
already gives, keep its multi-threshold table, and report: recall@k for every gate,
NDCG@10/@12, precision@12, oracle↔human Kendall τ, plus the two regression signals
SCORING.md already names — distribution shape and low-confidence share.

Labels must be **pooled across ranker variants**. Labeling only what the current
system surfaces produces a metric that congratulates itself.

Baselines to beat, all pseudo-label tier:

| metric | baseline |
|---|---:|
| NDCG@12 of prefilter ordering | 0.500 |
| Spearman ρ, prefilter vs screen | 0.374 |
| recall@120, fit ≥ 70 | 75.0% |
| recall@120, fit ≥ 50 | 72.5% |
| `whatTheyDo` = "Unknown" | 61% |

**Rule: no ranking change ships without an eval delta against these.**

### F. Learning loop

Prompt-level first, per [ROADMAP item 1](ROADMAP.md): feed a compact verdict
history into the ranking prompt as few-shot calibration. At a few dozen labels
this beats weight-fitting and stays interpretable.

Later, **distill** the screen into any cheap prior instead of hand-tuning weights
— a fit over the deterministic features would have caught that recency is
anti-predictive. And reserve ~2 of the 12 slots for high-uncertainty candidates:
without exploration, labels only ever cover what is already surfaced.

## Sequencing

1. **Labels** (`review-startups`, shipped) — nothing else is measurable without them.
2. **`sf eval`** — turns the baselines above into a regression test.
3. **Enrichment** (A) — the one change that raises the ceiling.
4. **Ungate** (B) — cheap once enrichment exists, and pointless before it.
5. **Listwise head** (C) and **objectives** (D) — refinements, worth little until
   the documents have content.
6. **Learning loop** (F) — needs a label corpus that only accrues with use.

## Already rejected — do not re-litigate

Fuzzy name matching ([ADR-004](DECISIONS.md) and its measured addendum), paid data
sources ([ADR-001](DECISIONS.md)), in-runtime subagents
([ADR-008](DECISIONS.md)), and reintroducing a spend cap
([ADR-011](DECISIONS.md)). The disk cache in `src/llm/claude.ts` must stay — with
no cap above it, it is the only thing between a careless re-run and a real dent in
the user's rate limit.
