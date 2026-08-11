# Architecture

_How the app is put together, and why it is shaped this way._

Read [VISION.md](VISION.md) first for the intent. This document is the map.

---

## The shape in one picture

```
  SEC EDGAR Form D ──┐
  (comprehensive,    │
   80% noise, free)  │
                     ├──> merge ──> prefilter ──> LLM score ──> research ──> report
  Funding news RSS ──┘     join      free,          batched,     web search   md + html
  (selective, rich,      by name    ~1500→120      ~120→ranked   top ~15
   already public)                   deterministic  ~$1          ~$3-7
```

The whole design is a **funnel with widening cost per item**. Each stage is
allowed to be more expensive than the last because it sees far fewer items.

All `$` figures are dollar-*equivalents* of token usage. LLM work runs on the
user's Claude subscription via OAuth — nothing is billed to a card, and the real
scarce resource is the plan's rate limit. See [ADR-003](DECISIONS.md#adr-003-use-the-claude-code-cli-as-the-llm-backend)
and [ADR-008](DECISIONS.md#adr-008-keep-the-subprocess-pipeline-do-not-move-scoring-into-in-runtime-subagents).

| Stage | Items in | Items out | Usage/item | Total |
|---|---:|---:|---:|---:|
| ingest | — | ~1,600 | none | none |
| merge | ~1,600 | ~330 | none | none |
| prefilter | ~330 | 120 | none | none |
| LLM score | 120 | 120 ranked | ~$0.008-equiv | ~$1-equiv |
| research | 15 | 15 dossiers | ~$0.30-equiv | ~$4-equiv |

If you are adding a stage, place it according to what it costs per item and how
much it narrows the field. A cheap stage that narrows a lot belongs early.

## Directory map

```
src/
  types.ts            Domain types — the contract between all stages. Read this first.
  paths.ts            Every file path the app touches, in one place.
  config.ts           Loads + validates config/profile.yaml; renders it for prompts.
  cli.ts              Command dispatch and stage orchestration.

  sources/
    edgar.ts          SEC Form D: daily index → XML → FormDFiling, plus fund filtering.
    news.ts           RSS/Atom → NewsItem, plus headline fact extraction.

  pipeline/
    merge.ts          FormDFiling[] + NewsItem[] → Company[]
    prefilter.ts      Deterministic triage ranking. No LLM.
    score.ts          Batched LLM fit scoring against the profile.
    research.ts       Per-company deep research with web search.

  llm/claude.ts       `claude -p` wrapper: caching, cost accounting, retries, JSON extraction.
  store/jsonl.ts      The entire persistence layer.
  report/
    markdown.ts       The digest.
    html.ts           The filterable dashboard.
  util/               http (rate limit + cache), text (normalization), log.
```

## Data flow and file contracts

Each stage reads and writes specific files under `data/`. All are JSONL, all are
committed to git (see [ADR-002](DECISIONS.md#adr-002-jsonl-files-on-disk-instead-of-a-database)).

| File | Written by | Shape | Semantics |
|---|---|---|---|
| `filings.jsonl` | ingest | `FormDFiling` | Append/upsert by `accessionNumber` |
| `news.jsonl` | ingest | `NewsItem` | Append/upsert by `id` (hash of URL) |
| `companies.jsonl` | merge | `Company` | Rewritten each run; `firstSeenAt` preserved |
| `scored.jsonl` | score | `ScoredCompany` | Rewritten each run |
| `dossiers.jsonl` | research | `{id, dossier, researchedAt}` | Append-only; never regenerated |
| `runs.jsonl` | run | `RunRecord` | Append-only audit + cost log |
| `cache/` | http, llm | — | **Gitignored.** Safe to delete anytime. |

`dossiers.jsonl` being append-only and separate from `scored.jsonl` is deliberate:
research is the expensive artifact, and it must survive re-scoring. You can rescore
a hundred times while tuning your profile and never re-pay for research.

## Stage contracts

**ingest** — `sources/*.ts`. Network-facing. Must never fail the run because one
source is down; a dead RSS feed logs a warning and is skipped. All HTTP goes
through `util/http.ts`, which enforces per-host rate limits (the SEC will IP-ban
you at >10 req/s) and caches to disk.

**merge** — `pipeline/merge.ts`. Pure function of its inputs. Joins on exact
normalized name only. See [ADR-004](DECISIONS.md#adr-004-exact-name-matching-only)
for why fuzzy matching is banned here.

**prefilter** — `pipeline/prefilter.ts`. Pure, deterministic, no network, fully
unit-tested. It is a *triage* score, not a quality judgement: its only job is
deciding who is worth an LLM call. Optimize it for recall, not precision.

**score** — `pipeline/score.ts`. Batched LLM calls, no web access. Judges only
what EDGAR and headlines provide. "I don't know what this company does" is a
correct output here.

**research** — `pipeline/research.ts`. Per-company, with `WebSearch` and
`WebFetch`. The only stage that learns anything genuinely new.

**report** — `report/*.ts`. Pure functions from `ResearchedCompany[]` to strings.
No I/O, so they are trivially testable.

## Key invariants

Break these and things get subtly wrong:

1. **Nothing is silently dropped after merge.** Companies that fall below the LLM
   cutoff still land in `scored.jsonl` with `llm: null` and appear in the report's
   long-tail table. If a user goes looking for a company they know raised, it
   should be findable.
2. **`effectiveScore()` is the single ranking function.** LLM fit when present,
   otherwise a capped prefilter score. An un-screened company must never outrank a
   screened one — `score.ts` enforces this with a hard cap of 45.
3. **`null` means unknown, never zero.** A missing funding amount is `null`, not
   `0`. Form D's `totalOfferingAmount` can literally be the string `"Indefinite"`.
   Coercing that to 0 would rank a company as having raised nothing.
4. **The LLM never runs in the repo's working directory.** `claude` reads
   `CLAUDE.md` from its cwd; running from the repo root would inject this
   project's dev instructions into every scoring prompt. `llm/claude.ts` runs it
   from an empty temp dir.
5. **Plan usage is reported, not capped.** A run costs what the work costs; the
   figure lands in the run summary, `runs.jsonl`, and the report header
   ([ADR-011](DECISIONS.md#adr-011-report-plan-usage-instead-of-capping-it)).
   What bounds a run is `--limit` and `--research`, not a dollar figure. If you
   ever reintroduce a cap, reserve before dispatch or concurrent calls will
   collectively overshoot — that already happened once, see
   [ADR-006](DECISIONS.md#adr-006-reserve-llm-budget-before-dispatch).
6. **Data embedded in the dashboard's `<script>` block goes through
   `toScriptJson()`, never bare `JSON.stringify`.** Company names come from SEC
   filings and RSS feeds, so a crafted entity name containing `</script>` would
   close the element and turn the rest of the page into live HTML. Pinned by
   `test/report.test.ts`.

## Extending it

**Adding a data source** is the most common change. Write a module in `src/sources/`
that returns records, add a merge path, and document it in
[DATA_SOURCES.md](DATA_SOURCES.md). The `Company.evidence` array is the general
mechanism for feeding unstructured signal to the LLM without changing types.

**Changing what "good" means** — start in `config/profile.yaml`. If that is not
enough, the rubric in `score.ts` is next. Code changes are the last resort.

**Adding a pipeline stage** — add a `stageX()` in `cli.ts`, give it its own
command, and make it independently runnable against on-disk data. The ability to
re-run one stage without the others is what makes iteration affordable.

## Testing

135 tests, no network, sub-second. Everything pure is tested; the network and
subprocess boundaries are not mocked, they are simply not unit-tested — the real
verification for those is running the pipeline.

```bash
pnpm test
pnpm typecheck
```

When you fix a bug found by running the real pipeline, add the offending input as
a test case. Several tests in `test/news.test.ts` are exactly that: real headlines
that produced garbage company records on the first live run.
