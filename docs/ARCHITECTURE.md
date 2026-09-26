# Architecture

_How the app is put together, and the constraints that shape it._

## The pipeline

```
SEC Form D ─┐
            ├─> merge ─> research (web search + score) ─> media ─> data/runs/<date>.jsonl
news RSS ───┘                                                              │
                                                                           v
                                        index.html on GitHub Pages reads one issue
                                                                           │ grades
                                                                           v
                                           data/labels.jsonl, via a PR the page merges
```

A run is **one day**, and everything it produces lives in one shard. There is no
cumulative store.

| stage | cost | in | out |
|---|---|---|---|
| ingest | free | 220-290 filings, 7 RSS feeds | 60-70 companies |
| merge | free | filings + news items | one record per company |
| research | ~$0.25-0.30/company | every company | fit score + dossier |
| media | free | researched homepages | image, logo, video per company |
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
| `data/runs/<date>.jsonl` | ingest, research, media | one `RunCompany` per line |
| `data/index.json` | report | `RunIndexEntry[]`, newest first |
| `index.html` | report | the dashboard — no data in it |
| `src/report/web/` | by hand | the dashboard's logic and style, inlined into `index.html` |
| `data/labels.jsonl` | the dashboard, via a PR | one grade per company per issue |
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

   Two causes, kept distinguishable: a genuine failure consumes tokens, a
   usage-limit refusal consumes none. `PlanLimitError` matches the second and
   stops the run — without it a limit marked 37 of 57 healthy companies failed.

   An expired CLI login refuses with that same zero-token envelope, so
   `classifyRefusal` splits it out as `AuthExpiredError`. It still stops the run,
   but the message says to run `claude login` rather than promising the window
   reopens: reported as a usage limit, it hid a dead login for six days and 318
   companies.

3. **`null` means unknown, never `0`.** Form D's `totalOfferingAmount` can
   literally be `"Indefinite"`; a `0` would rank a company as having raised
   nothing.
4. **Shards are written in id order**, so git stores what changed rather than a
   reordering of the whole file. No consumer may assume file order — rank
   explicitly at the point of use.
5. **The dashboard carries no data.** `src/report/html.ts` emits a ~80 KB shell
   that fetches one shard at load time. Inlining data made every run commit a
   second copy of records already on disk, and put text from SEC filings — which
   anyone can craft — inside a `<script>` block.

   It does hold a GitHub token, so its Content-Security-Policy lets only its own
   inline script run (by hash) and lets it talk only to its own origin and
   `api.github.com`. No inline handlers, and every model-written link passes
   `safeUrl()`, which admits http(s) only.
6. **A shard's date is the day it covers.** The filing window is anchored to
   that date, never to the clock. Catching up is a loop over outstanding days,
   one shard each — not a widened window; an earlier design derived the width
   from the newest filing on disk and was replaced by the loop when runs became
   per-day. Both halves have to agree: while the window still anchored to the
   clock, the catch-up run of 2026-08-14 wrote 2026-08-13's filings into the
   2026-08-12 shard as well, and that day's own 47 filings were never fetched.
7. **Never run `claude` from the repo root.** It reads `CLAUDE.md` from its working
   directory, which would inject this project's instructions into every research
   prompt. `src/llm/claude.ts` runs it from an empty temp dir.
8. **Pictures are scraped, never model-written.** A model asked for an image URL
   invents a plausible one. `media` reads the company's own homepage, and only
   one research was confident about — see DATA_SOURCES.md.
9. **Every grade is a click.** Swiping the deck or scrolling the list records
   nothing, so a company never judged is absent from `data/labels.jsonl`, never
   a 0. Filling those in would teach any eval that whatever the ranker buried
   deserved burying.

## Grades: from a phone to `data/labels.jsonl`

The dashboard is served by GitHub Pages from `main`, so it is a bookmark on a
phone. Grades are written straight to the repo through GitHub's REST API with a
fine-grained token the user pastes once per device (Contents and Pull requests,
write, this repo only). There is no server.

A sitting's grades go to a `grades` branch and reach `main` through a pull
request the page opens and squash-merges itself — on reaching the end of the
deck, on leaving the page, or at the next visit. That is the same
branch-and-PR path every other change takes, and it works whether or not `main`
is protected. If a merge is refused, the grades wait in the open PR, and the page
reads them from the branch meanwhile.

Commits are batched: one after 20 seconds without a grade, or two minutes into
steady grading. Until the PR exists a grade stays queued in `localStorage`, so a
phone that freezes the tab mid-save loses nothing — the next visit resets the
branch from `main` and replays the queue.

Without a token, grades stay in the browser and export as `labels.json` for the
`review-startups` skill, as before.

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

**Changing the dashboard** means editing `src/report/web/` and running
`pnpm sf report`. `model.js` is the pure part — tested, and shared with the media
stage — and `app.js` the DOM. There is no build step: the browser runs them as
written, which is why they are plain JavaScript.

**Changing what "good" means** is a config change, not a code change. Edit
`config/profile.yaml`, then `pnpm sf research --refresh --limit 5` against a shard
to see the effect for about a dollar.
