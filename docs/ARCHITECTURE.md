# Architecture

_How the app is put together, and the constraints that shape it._

## The pipeline

```
SEC Form D ─┐
            ├─> merge ─> research (web search + score) ─> data/runs/<date>.jsonl
news RSS ───┘                                                      │
                                                                   v
                                                    index.html reads one issue
```

A run is **one day**, and everything it produces lives in one shard. There is no
cumulative store.

| stage | cost | in | out |
|---|---|---|---|
| ingest | free | 220-290 filings, 7 RSS feeds | 60-70 companies |
| merge | free | filings + news items | one record per company |
| research | ~$0.25-0.30/company | every company | fit score + dossier |
| report | free | the shard | `index.html`, `data/index.json` |

`src/types.ts` is the contract between stages and the best single file to read
first.

## The one idea that matters

**Nothing is ranked before it is understood.** Every company a run finds is
searched on the web and then scored on what was actually found.

This is worth stating because the app used to work the other way, and it failed
measurably. A deterministic prefilter ranked companies on a name, an amount and an
industry code, and only its top slice was ever scored. On a real corpus that
ordering scored **NDCG@12 = 0.500** against the model's own judgement — barely
better than arbitrary — and the best company in the run sat at rank #131 and was
never seen, because its name contained no recognizable keyword. The screen behind
it had no web access either, so it answered `"Unknown — …"` for **61%** of what it
scored. It was ranking legal entity names.

The same stage now answers "Unknown" for almost none of them, because it has read
the company's site before it judges. Scoring costs more per company and the app
looks at far fewer companies per run — one day instead of ten — which is what
makes it affordable.

## Files and contracts

| path | written by | shape |
|---|---|---|
| `data/runs/<date>.jsonl` | ingest, then research | one `RunCompany` per line |
| `data/index.json` | report | `RunIndexEntry[]`, newest first |
| `index.html` | report | the dashboard shell — no data in it |
| `data/cache/` | http + llm layers | gitignored, safe to delete |

Shards and the index are **committed on purpose**. Git is the archive: back issues
are files, and a run costs history its own size rather than a rewrite of
everything ever seen.

## Invariants

1. **Nothing is dropped after ingest.** Every company a run finds is researched,
   scored, and rendered. The dashboard has no top-N cut. The ingest filter is the
   only thing that removes a company, and it runs before anything else.
2. **A null `assessment` means research did not complete** — never that the
   company was filtered out. It sorts to the bottom of the dashboard but stays
   visible, and the next run retries it.

   Two causes, and they must stay distinguishable. A genuine failure consumes
   tokens. A **plan-limit refusal** consumes none: the CLI rejects the call
   before it reaches the model, reporting zero API time and zero tokens.
   `PlanLimitError` detects that signature and stops the run, because otherwise
   an exhausted usage limit marks the whole remaining queue as failed in seconds
   — which is exactly what happened on a real run, to 37 of 57 companies. A
   later run confirmed the fix: it stopped at 14 of 70 with `failures: 0`.

   The limit is not always the five-hour window; one run stopped on a monthly
   spend cap. Nothing may assert which one it was — quote what Claude said.
3. **`null` means unknown, never `0`.** Form D's `totalOfferingAmount` can
   literally be `"Indefinite"`; a `0` would rank a company as having raised
   nothing.
4. **Shards are written in id order**, so git stores what changed rather than a
   reordering of the whole file. No consumer may assume file order — rank
   explicitly at the point of use.
5. **The dashboard carries no data.** `src/report/html.ts` emits a ~18 KB shell
   that fetches one shard at load time. Inlining data made every run commit a
   second copy of records already on disk, and put text from SEC filings — which
   anyone can craft — inside a `<script>` block.
6. **Never run `claude` from the repo root.** It reads `CLAUDE.md` from its working
   directory, which would inject this project's instructions into every research
   prompt. `src/llm/claude.ts` runs it from an empty temp dir.

## The ingest filter

`isLikelyOperatingStartup()` in `src/sources/edgar.ts` is the only gate. It drops
roughly four in five filings using the filer's **self-reported** industry code,
entity type, and name patterns.

Its recall has been measured, not assumed. On a real day it dropped 175 of 222
filings; a model re-judging all 175 from the same fields called exactly one a real
company — **97.9% recall**. By rule:

| rule | dropped | missed |
|---|---:|---:|
| industry is an investment/real-asset bucket | 160 | 0 |
| entity type is a fund structure | 12 | 1 |
| name matches an investment-vehicle pattern | 3 | 0 |

The industry rules are exact because a filer's industry code is structured data
they supplied, not a guess about them. The one miss was an operating company
structured as an LP, so that rule now only fires when the industry also looks
fund-like.

Two things this does *not* establish: both judges saw the same fields, so a
company with a generic name and a misleading industry code would fool both; and
the model was told to be strict, which biases toward agreeing with the filter.
Bounding that would need web search over the dropped set.

The research stage is the backstop — it sets `isOperatingCompany: false` for funds
and holding companies that get through, and the dashboard hides those by default.

## Deliberate constraints

- **Free public sources only.** No Crunchbase or PitchBook. The interesting claim
  is that a model can turn a bare Form D into a useful briefing, and that is only
  tested starting from bare Form Ds.
- **Exact name matching only.** Startup names are short and collide. A duplicate
  record is visible and harmless; a wrong merge silently fabricates one company
  out of two and looks completely normal. If duplicates become annoying, the fix
  is a curated alias map in `config/`, not a fuzzy threshold.
- **JSONL on disk, no database.** The data is small, and git gives history, diffs
  and durability for free.
- **The Claude Code CLI, not the API.** There is no `ANTHROPIC_API_KEY` here;
  `claude -p` runs on the user's subscription over OAuth, so nothing is billed to
  a card, and web search works headlessly.
- **No spend cap.** A cap fired mid-run once and threw away work already paid for.
  What bounds a run is the size of a day, plus `--limit` as a safety valve.
- **Never remove the disk cache** in `src/llm/claude.ts`. With no cap above it, it
  is the main thing between a careless re-run and a real dent in the rate limit.

## Extending it

**Adding a data source** is the most common change. Write a module in
`src/sources/` returning records `mergeSources` understands, and add it to
`stageIngest`. See [DATA_SOURCES.md](DATA_SOURCES.md) for what is worth adding.

**Changing what "good" means** is a config change, not a code change. Edit
`config/profile.yaml`, then `pnpm sf research --refresh --limit 5` against a shard
to see the effect for about a dollar.
