# Decision log

_Architecture decisions, with the alternatives that were considered and rejected._

Each entry records what was decided, why, and — most usefully — **what would make
it worth revisiting**. If you are about to change something fundamental, check
whether it is here first; the reasoning may already exist.

Format: context → decision → consequences → revisit when.

---

## ADR-001: Free public sources only

**Status:** accepted · initial build

**Context.** Funding data is a mature commercial market. Crunchbase, PitchBook,
Dealroom, and Specter all sell exactly the dataset this app assembles, with
valuations, investor names, and headcount trends we cannot get for free. Any of
them would be a better data layer than SEC filings plus RSS.

**Decision.** Use only free public sources: SEC EDGAR Form D and public RSS feeds.

**Why.** Three reasons, in order of weight:

1. **This is a personal tool.** A $500/month data subscription is wildly out of
   proportion to one person's job search.
2. **The differentiating value is judgement, not data.** Paying for Crunchbase
   would make this a worse Crunchbase. The interesting claim is that an LLM can
   turn a bare Form D into a useful briefing — and that claim is only tested if
   we start from bare Form Ds.
3. **Form D is genuinely better for the core use case.** It is comprehensive,
   whereas commercial databases lag on the smallest and earliest rounds, which is
   exactly the window this app is aiming at.

**Consequences.** No valuations, no investor names from the structured source, no
headcount data, weak non-US coverage. Round labels only when press supplies them.
Substantial work goes into filtering investment vehicles out of Form D — a problem
a paid database would not have.

**Revisit when.** The user is doing this for real money rather than exploration, or
if a cheap metered API (rather than an enterprise seat) appears.

---

## ADR-002: JSONL files on disk instead of a database

**Status:** accepted · initial build

**Context.** The pipeline needs to persist filings, companies, scores, and
dossiers across runs, with upserts and dedupe.

**Decision.** Newline-delimited JSON files under `data/`, committed to git. No
database. `store/jsonl.ts` is the entire persistence layer, ~120 lines.

**Alternatives rejected.**

- **SQLite via `node:sqlite`** — still flagged experimental on Node 22.13, which
  would mean a runtime flag on every invocation.
- **SQLite via `better-sqlite3`** — a native module. Compilation failures across
  Node versions are a real and recurring cost for a repo meant to be picked up by
  many different agents on different machines.
- **DuckDB / Postgres** — vastly out of proportion to thousands of rows.

**Why JSONL wins here.** The data is small (~330 companies/run, low thousands
lifetime). Git gives history, diffs, and durability for free — you can `git log -p
data/companies.jsonl` and watch the dataset evolve. Agents can `grep` it. There are
no native dependencies to break, and no schema migrations. Writes are atomic
(write to `.tmp`, then rename), so an interrupted run cannot corrupt a dataset.

**Consequences.** Full-file rewrites on upsert — fine at this size, quadratic at
scale. No indexes, no queries. Merge conflicts are possible if two agents run the
pipeline on branches simultaneously.

**Revisit when.** `data/companies.jsonl` passes roughly **50,000 rows**, or a
single file passes ~50 MB, or you need real queries. `readAll`/`writeAll`/
`upsertAll` are the only call sites, so swapping the backing store is a contained
change.

---

## ADR-003: Use the Claude Code CLI as the LLM backend

**Status:** accepted · initial build

**Context.** The app needs LLM calls for scoring and web-search-backed research.
The obvious choice is the Anthropic API with an `ANTHROPIC_API_KEY`.

**Decision.** Shell out to `claude -p ... --output-format json` instead.

**Why.**

1. **No separate credential or bill.** It runs on the subscription the user
   already has. There was no `ANTHROPIC_API_KEY` in the environment, and asking a
   user to provision one to run their own tool is real friction. Confirmed: with
   no API key and no `apiKeyHelper`, `claude` authenticates via OAuth, so LLM
   work draws on plan capacity and **nothing is billed to a card**. The
   `total_cost_usd` the CLI reports is a dollar-equivalent of tokens used.
2. **Web search comes for free and works headlessly.** Verified: `--allowedTools
   WebSearch` in `-p` mode performs multi-turn search and returns clean JSON. The
   research stage is the app's main value and it depends entirely on this.
3. **Model choice is a flag**, not a code change.

**Consequences.**

- A subprocess per call — slower than HTTP (~5s for a plain call, ~15–20s with
  search) and higher per-call overhead.
- `claude` must be on `PATH`; `cmdRun` preflights this with a clear error.
- **The CLI reads `CLAUDE.md` from its working directory.** Running from the repo
  root would inject this project's development instructions into every scoring
  prompt. `llm/claude.ts` therefore runs it from an empty temp dir. This is
  non-obvious and easy to reintroduce.
- Structured output needs defensive parsing; `extractJson()` handles bare JSON,
  fenced JSON, and JSON embedded in prose, and `runClaudeJson()` retries once with
  the validation errors appended.

**Revisit when.** Throughput becomes the bottleneck, or the app needs to run
somewhere the CLI cannot be installed (CI, a server). `llm/claude.ts` exposes a
narrow interface (`runClaude`, `runClaudeJson`) so an API-backed implementation
would be a drop-in.

---

## ADR-004: Exact name matching only

**Status:** accepted · initial build

**Context.** Merging a Form D filing with a news article about the same company
requires deciding when two names refer to one company. Fuzzy matching (edit
distance, token overlap, embeddings) is the obvious approach.

**Decision.** Match only on **exact equality of the normalized name**.
Normalization strips punctuation, case, and legal suffixes (`Inc`, `LLC`,
`Technologies`, …) — nothing else. Names shorter than 3 characters never match.

**Why.** Startup names are short, and short strings collide constantly: `Ramp` /
`Rampt`, `Vercel` / `Vercelo`, `Notion` / `Notional`. The two error modes are not
symmetric:

- **False negative:** the same company appears as two records. Visible, harmless,
  and the user can see both.
- **False positive:** two companies silently merge into one record with mixed
  funding events, mixed officers, and a dossier researching the wrong one. The
  output looks completely normal and is completely wrong.

Given [VISION.md](VISION.md)'s "unknown is cheap, wrong is expensive," exactness is
the correct bias.

**Consequences.** Duplicate records for the same company under different spellings
(`Acme AI` vs `Acme Artificial Intelligence`). Merge rates from news into EDGAR are
low — 1 of 26 in the reference run.

**Revisit when.** Duplicates become annoying in practice. The right fix is a
curated **alias map** in `config/` (`"acme artificial intelligence" →
"acme-ai"`), not a looser comparison. Aliases are auditable; fuzzy thresholds are
not.

### Measured: the matcher is not currently the bottleneck

A later audit found **zero** companies carrying both an EDGAR filing and a news
item — which looks damning for exact matching until you check the headroom.
Token-overlap matching every news-derived company against all 316 filed entity
names produced no plausible pair either. There is nothing to merge, for two
structural reasons:

1. **Geography.** Most news-derived companies are European (Mironid, NavVis,
   Omilia, Relu, SeeTrue, FuVeX, Neuraspace — three of the seven feeds are EU
   publications). No Form D exists for them, at any name.
2. **Timing.** Form D is due within 15 days of *first sale*; press reports at
   *announcement*. The two can be weeks apart, so they rarely land in the same
   ingestion window. HappyRobot's $150M Series C was covered on 2026-08-04 and
   has no Form D in our data at all.

This matters because it means **a smarter matcher — fuzzy, embedding-based, or
LLM-adjudicated — would currently buy nothing.** Do not build one on the theory
that `both: 0` proves exact matching is too strict; measure the headroom first,
by checking whether candidate pairs exist at all.

Timing partly solves itself: `merge` runs against the whole accumulated
`filings.jsonl`, not just the current window, so as filing history builds up
month over month, late-filed Form Ds will start meeting earlier press. Re-measure
then. If real candidate pairs do appear, the right architecture is cheap blocking
(shared token / prefix) to generate candidates, then an LLM adjudicating only
those few pairs with location, date, amount, and officers as context — never
pairwise LLM comparison, which is O(n·m) calls for no benefit.

---

## ADR-005: Three-tier funnel with widening cost per item

**Status:** accepted · initial build

**Context.** Scoring every candidate with an LLM, with web search, would cost
roughly $100 and an hour per weekly run. That is not viable for a personal tool.

**Decision.** Three tiers, each more expensive per item and seeing fewer items:
deterministic prefilter (free, ~330 items) → batched LLM screen without web access
(~$1, 120 items) → per-company research with web search (~$4, 15 items).

**Why batching in tier 2.** The rubric and profile dominate the prompt; sending
them once per batch of 8 instead of once per company is a ~6–8x cost reduction for
a modest loss of attention per company.

**Why no web search in tier 2.** It is the single largest cost multiplier (~$0.008
→ ~$0.30 per company). Deferring it to the small tier-3 set is what makes the
economics work at all.

**Consequences.** Tier 2 frequently cannot tell what a company does, and says so.
This is correct behavior, not a defect — but it means tier-2 scores carry genuine
uncertainty, which is why `confidence` is a required field and is surfaced in
reports.

**Revisit when.** Model costs drop enough that web search at tier 2 is affordable,
which would materially improve ranking quality.

---

## ADR-006: Reserve LLM budget before dispatch

**Status:** superseded by [ADR-011](#adr-011-report-plan-usage-instead-of-capping-it) ·
the cap it made accurate no longer exists. Kept because the concurrency bug it
describes will recur the moment anyone reintroduces a pre-dispatch check.

**Context.** Runs take a `--budget` cap. Originally the check compared *settled*
spend against the cap immediately before each call.

**What went wrong.** With concurrency 3, three research calls all passed the check
while spend was still under the cap, then all completed. A run with a `$6` cap
spent **$7.22**. The cap was effectively `cap + (concurrency − 1) × cost_per_call`.

**Decision.** Reserve an assumed per-call cost (`$0.50`, the observed cost of the
most expensive call type) before dispatch, and release it in a `finally` after the
actual cost is recorded.

**Consequences.** The cap now holds to within roughly one call's cost. Cheap calls
over-reserve, making the cap slightly conservative — an acceptable trade for a
guarantee. `test/budget.test.ts` pins the behavior with two concurrent calls
against a cap that fits only one.

**Revisit when.** Per-call costs shift materially, in which case update
`ASSUMED_CALL_COST_USD` in `llm/claude.ts`.

---

## ADR-007: Commit generated data and reports to git

**Status:** accepted · initial build

**Context.** `data/*.jsonl` and `reports/*` are generated artifacts. Convention
says generated files do not belong in version control.

**Decision.** Commit them anyway. Only `data/cache/` (raw upstream payloads) is
gitignored.

**Why.** The user explicitly asked that the app's *output* live in the repo
alongside its implementation. Beyond that, it is genuinely useful here: git
becomes the time-series store, so you can diff two weeks of digests, `git log -p`
a company's record, and see how scoring changed after a prompt edit. It also means
a future agent cloning the repo sees real reference data without spending a cent
or waiting fifteen minutes.

**Consequences.** Repo growth over time — the dashboard HTML is ~300 KB per run
because it inlines the full dataset. Merge conflicts if two agents run the
pipeline on branches simultaneously.

**Revisit when.** Repo size becomes a problem.

**Amended.** `reports/latest.md` and `latest.html` are no longer written. They
were byte-identical copies of the newest dated files, so every run committed the
~300 KB dashboard twice to buy a stable filename; the newest date in `reports/`
says the same thing. This settles the opposite way from the mitigation this ADR
originally suggested — keeping only `latest.*` and leaning on git history for
back issues would also have halved the growth, but it hides the archive inside
`git log` instead of leaving it visible in the tree, and the user preferred the
dated files. Either choice halves it; do not swap between them without a reason.

---

## ADR-008: Keep the subprocess pipeline; do not move scoring into in-runtime subagents

**Status:** accepted · after the "isn't this free on my plan?" question

**Context.** LLM work here runs through `claude -p` subprocesses. A natural
alternative: make startup-finder a Claude Code skill that spawns subagents inside
one runtime, on the theory that this would use the subscription rather than
costing money.

**The premise is already true.** With no `ANTHROPIC_API_KEY` and no
`apiKeyHelper`, `claude -p` authenticates via OAuth against the user's
subscription. Nothing is billed to a card today. `total_cost_usd` is a
dollar-equivalent of tokens, which we track as a proxy for rate-limit
consumption. So the motivating problem does not exist.

**Decision.** Keep the subprocess pipeline.

**Why.** Subagents would draw on the same subscription and the same rate limit —
tokens are tokens, regardless of which process emits them. There is no saving to
capture. Against that, moving in-runtime gives up four things that are doing real
work:

1. **Batching.** Tier 2 scores 8 companies per call, so the rubric and profile
   (most of the prompt) are sent once per batch instead of once per company — a
   ~6-8x reduction. A subagent-per-company design cannot batch by construction.
2. **Disk caching keyed by prompt hash.** Re-runs cost almost nothing. A
   rebuild during development re-scored 120 companies for $0.35-equiv instead of
   $2.67 because most batches hit cache.
3. **Per-stage item limits.** `--limit` and `--research` bound how much rate
   limit a run can consume, and the accounting to report it afterwards
   ([ADR-011](#adr-011-report-plan-usage-instead-of-capping-it)).
4. **Headless, schedulable, resumable stages.** `sf score` and `sf report` re-run
   against on-disk data without a human or a live session.

**Consequences.** We pay per-call session overhead — roughly 12k cache-creation
tokens for the system prompt and tool definitions on every invocation. Batching
amortizes this (15 calls for 120 companies, not 120), and `--strict-mcp-config`
plus an empty working directory keep it near the floor. The CLI's `--bare` flag
would cut it further but requires an API key and never reads OAuth, so it is
unusable here.

**Note on "routines".** Scheduling a recurring run is a *separate* concern from
where inference happens, and is a live roadmap item — see
[ROADMAP.md](ROADMAP.md) item 6. Nothing in this ADR argues against scheduling.

**Revisit when.** Per-call session overhead becomes the dominant cost (measure
before assuming), or the runtime gains a way to share a warm session across many
structured calls while preserving batching and caching.

---

## ADR-009: Enforce the branch-and-PR workflow with a hook, not just a doc

**Status:** accepted · requested by the user

**Context.** This repo is explicitly designed to be picked up by many different
agent sessions. The initial build was committed straight to `main` (the repo was
empty, so there was nothing to branch from), and nothing prevented later sessions
from doing the same.

**Decision.** A `PreToolUse` hook on `Bash`
(`.claude/hooks/guard-main-branch.sh`, wired in `.claude/settings.json`) denies
`git commit` and `git push` whenever `HEAD` is on `main`, with a message telling
the agent how to branch — and how to recover if it already committed to `main`.
The rule is also stated in CLAUDE.md so agents understand the reason rather than
just hitting a wall.

**Why a hook rather than a documented rule alone.** A documented rule is advice;
an agent under time pressure can talk itself out of it. The hook is the thing
that actually holds. Both are present because the hook alone would be a
mysterious obstacle — the doc explains it.

**Why not GitHub branch protection.** Server-side protection would be stronger
and would also cover pushes made outside Claude Code. It was not enabled because
it would equally block the *user's* own direct pushes to `main`, which is a
change to how they work on their own repo, not just to how agents behave. The
request was specifically about agent sessions. Worth revisiting if the user wants
the harder guarantee — the two are complementary, not alternatives.

**Consequences.** Agents must branch. The hook adds a subprocess to every `Bash`
call; it is a short shell script and the `matcher` is deliberately left broad
(all `Bash`, not `Bash(git *)`) because a command like `cd sub && git push` does
not start with `git` and would slip through a narrower matcher.

**Escape hatch.** Prefixing a command with `SF_ALLOW_MAIN_COMMIT=1` bypasses the
check. It is deliberately visible in the transcript, so a deliberate exception is
auditable rather than silent.

**Verified.** Twelve cases pinned by pipe-test with `HEAD` on `main`:
`git commit`, `git push`, `git push -u origin HEAD`, `git add -A && git commit`,
`git -C dir push`, and `git commit --amend` all block; `git status`, `git log`,
`git log --grep='git commit'`, `pnpm test`, `git checkout -b`, and the
`SF_ALLOW_MAIN_COMMIT=1` escape hatch all pass.

**Revisit when.** The user wants protection that also covers their own pushes
(add a GitHub ruleset), or the hook proves too coarse in practice.

---

## ADR-010: Derive the lookback window from data on disk, not a fixed N days

**Status:** accepted · after a user question exposed the gap

**Context.** Ingestion looked back a fixed `--days` (default 7) from *today*.
Asked "if I run on day 1 and again on day 100, does it fetch what happened in
between?", the answer was no: the day-100 run covered days 94-100 and days 2-93
were never fetched. Nothing in the output revealed the hole — precisely the
silent loss CLAUDE.md rule 5 exists to prevent, and fatal for a tool the user
had just asked to run like a newsletter.

**Decision.** When `--days` is omitted, derive the window from the newest
`filedDate` in `data/filings.jsonl`: `max(7, elapsed + 2)`, capped at 90 days.
An explicit `--days` always wins.

**Why derive it from the data rather than track "last run".** `filedDate` is the
day a filing appeared in EDGAR, so the newest one already marks the last index
we successfully read. A separate state file would be a second source of truth
that could drift — deleting `filings.jsonl` and re-running would then under-fetch
rather than rebuild. This is self-healing.

**Why the 2-day overlap.** A day whose filings were all filtered out as funds
leaves no trace in `filings.jsonl`, so it would otherwise look covered.

**Why cap at 90 days.** Cost is linear: ~160 filings per day of window, one HTTP
request each, throttled to ~8/s for the SEC. 90 days is ~30 minutes; a year
would be ~2 hours. Too long to spend without the user choosing it.

**Consequences.** A gap larger than 90 days is not fully closed. The run logs a
warning naming the uncovered day count and the exact backfill command — the loss
is visible and actionable rather than silent. `scripts/weekly.sh` now omits
`--days` by default so a machine that was off for weeks catches up on its next
scheduled run.

**News cannot be backfilled.** RSS feeds only carry recent items, so a long gap
permanently loses the press side for that period. The Form D spine still covers
US funding for the whole window; what is lost is round labels, investor names,
and non-US rounds. Stated in the README limitations.

**Revisit when.** SEC full-text search (`efts.sec.gov`, already verified working)
could replace the day-by-day index crawl for large backfills and would make the
cap unnecessary. See DATA_SOURCES.md.

---

## ADR-011: Report plan usage instead of capping it

**Status:** accepted · at the user's request, superseding [ADR-006](#adr-006-reserve-llm-budget-before-dispatch)

**Context.** Every run took a `--budget` cap in dollar-equivalents. Exceeding it
threw `BudgetExceededError` before dispatching a call, which aborted the stage
and, in a `sf run`, the whole pipeline.

**Decision.** Remove the cap. `llm/claude.ts` still accumulates
`total_cost_usd` from every CLI call and still reports it — in the run summary,
in `runs.jsonl`, and in the report header — but nothing reads it to decide
whether to make a call. `--budget` is parsed and warned about rather than
rejected, so existing cron jobs and scripts keep working.

**Why.** The cap was protecting the wrong thing at the wrong moment. It fired
mid-run, after the expensive ingestion and screening stages had already been
paid for, and its effect was to throw away the research stage — the part the
user actually wants. A run that stops at company 9 of 15 has spent nearly all
the plan usage and delivered a partial digest, which is the worst of both
outcomes. Worse, the failure mode it guarded against (a fan-out bug) is already
bounded upstream by `--limit` and `--research`: the number of LLM calls a run
can make is a function of item counts, not of a dollar figure, and item counts
are the knob a human actually reasons about.

**Consequences.**

- A run costs what the work costs. At the defaults that is ~$4-equivalent; the
  figure is logged at the end and persisted per run.
- There is no longer a hard stop if something does fan out unexpectedly. The
  mitigations are the item limits, the disk cache, and the fact that both LLM
  stages are batched or top-N by construction.
- `test/budget.test.ts` became `test/cost.test.ts` and is much thinner. The old
  suite could exercise the rejection path offline because a zero cap short-
  circuited before spawning; with no cap there is no way to reach `runClaude`
  in a test without hitting the real CLI, so it now only pins the odometer.
- The concurrency lesson in ADR-006 is *not* obsolete. Any future pre-dispatch
  check must reserve before dispatch or it will overshoot by
  `(concurrency − 1) × cost_per_call`, exactly as it did before.

**Revisit when.** A run actually locks the user out of their subscription, or a
fan-out bug ships that the item limits do not bound. The cheap middle ground, if
so, is a warning threshold that logs loudly and keeps going, rather than a hard
stop that discards completed work.

---

## ADR-012: Treat the pipeline as a cascade ranker with a labeled eval set

**Status:** accepted · after measuring the prefilter against the screen

**Context.** Every tuning decision so far has been validated by eyeballing the top
20. [SCORING.md](SCORING.md) says so explicitly, and [ROADMAP.md](ROADMAP.md) item
3 has long noted that this "makes prompt changes risky and discourages
improvement." Measuring the prefilter's ordering against the screen's `fit` put a
number on the cost: **NDCG@12 = 0.500**, Spearman **ρ = 0.374**.

**Decision.** Treat the app explicitly as a cascade ranker with one user and a
persistent query, with **NDCG@12** as the objective and **recall@k of every gate**
as the guardrail. Collect human relevance labels (`data/labels.jsonl`, via the
`review-startups` skill), and adopt the rule that **no ranking change ships
without an eval delta**. Specification in [RANKING.md](RANKING.md).

**Why.** A gate is unrecoverable — nothing downstream can rank a company it never
saw — so recall at each gate is the quantity that actually bounds output quality,
and it was never being measured. Labels are the only thing that makes it
measurable.

**Consequences.**

- Three label tiers, which must never be conflated: **pseudo** (the screen's own
  `fit`, free, valid only for stages *below* the screen — circular on the screen
  itself), **oracle** (a strong model grading the pool, cheap-ish, carries its own
  taste bias), and **human** (scarce, the only ground truth).
- Grades are `0 = ignored · 1 = opened · 2 = saved`. No level 3: the user almost
  never contacts a founder, so it would stay permanently empty.
- **Unexamined companies are absent from the labels, never `0`.** This is the
  load-bearing detail. Exporting them as 0 would teach every future eval that
  whatever the ranker buried deserved burying — a bias that is both invisible and
  self-confirming. The dashboard therefore tracks what was actually on screen, and
  records the on-screen `rank` so an eval can truncate where attention ran out.
- Labels must be pooled across ranker variants, or the metric only ever sees what
  the current system already surfaces.

**Rejected.** Continuing to tune by inspection. It is not that eyeballing is
uninformative — it is that it cannot detect a regression in the part of the list
nobody looks at, which is precisely where the measured losses are.

**Revisit when.** Enough human labels accumulate that the pseudo-label tier can be
retired for anything except quick offline sweeps.

---

## ADR-013: Spend on document representation, not on scoring empty records

**Status:** accepted · partially supersedes [ADR-005](#adr-005-three-tier-funnel-with-widening-cost-per-item)

**Context.** For 299 of 324 companies the entire document is a legal entity name,
a dollar amount, an SEC industry code, a state, and a few officer names. The screen
says `whatTheyDo: "Unknown…"` for **61%** of what it scores, and the prefilter's
`theme` signal — a keyword regex whose only available haystack is the name — is
zero for **234 of 312** companies, including **6 of the 8** that scored ≥ 70.

**Decision.** Add an enrichment stage between `merge` and ranking: resolve each
company to a domain, fetch its homepage/about/careers text, extract a structured
description, and persist to `data/profiles.jsonl` keyed by company id. Rank on
that. Details in [RANKING.md](RANKING.md).

**Why.** This is a document-representation problem wearing a ranking problem's
clothes. No ranker can order documents that contain no orderable content, so
effort spent on better scoring of bare Form D records is capped no matter how much
is spent. ADR-005's cost argument against web search at tier 2 still stands on its
own terms — but it priced *per-run per-company search*, and enrichment is neither:
a company's website does not change week to week, so a resolved profile is fetched
once and reused for every subsequent run.

**Consequences.**

- Resolution must be able to return `null`, with a recorded confidence. A wrong
  domain is worse than no domain: it fabricates an entire document, and every
  downstream stage then describes the wrong company fluently and consistently.
  This is exactly the failure "unknown is cheap, wrong is expensive" exists to
  prevent, and enrichment is the most likely place for it to enter the system.
- First run is expensive; steady state is not.
- A resolved domain is a much better join key than a name. This does **not**
  reopen [ADR-004](#adr-004-exact-name-matching-only) — a domain is auditable in
  the way that ADR demands of an alias map, merely derived rather than curated.
- Hiring signals arrive early enough to rank on, which is
  [ROADMAP](ROADMAP.md) item 2 as a byproduct.

**Rejected.** Raising `--limit` and screening more companies with the same empty
documents. It costs proportionally more and moves the ceiling not at all.

**Revisit when.** Domain resolution turns out to be unreliable enough that the
`null` rate rivals today's 61% Unknown rate — in which case the bottleneck is
entity resolution, not enrichment, and should be attacked directly.

---

## ADR-014: Retrieval orders; it does not gate

**Status:** accepted · depends on [ADR-013](#adr-013-spend-on-document-representation-not-on-scoring-empty-records)

**Context.** The prefilter's justification is stated in
[SCORING.md](SCORING.md): it "is a cost-control mechanism wearing the costume of a
score," worth having because scoring 330 companies costs 3x what scoring 120 does
"for essentially the same top-20." Measurement contradicts the second half.
Recall@120 is **75%** at fit ≥ 70 and **72.5%** at fit ≥ 50 — worse on the broad
band — and the single best company in the corpus (Taktile, fit 88) ranked **#131**.

**Decision.** The prefilter stops gating. The 111-point composite,
`rankCompanies()`, the `slice(0, --limit)` cut, `effectiveScore()`'s 45-point cap,
and the `llm: null` state all go. A thinner *eligibility* check may remain — is
this an operating company, is it inside the funding window. Re-examine the ingest
regex on the same grounds.

**Why.** A gate is unrecoverable, and this one was cutting inside the densest part
of its own score distribution on a signal that correlates ρ = 0.374 with the
judgement it is meant to approximate. With the spend cap gone
([ADR-011](#adr-011-report-plan-usage-instead-of-capping-it)) the cost argument
that justified the risk is much weaker.

**Consequences.**

- Every company gets a real score, which dissolves the sub-30 ambiguity documented
  in [READING_THE_REPORT.md](READING_THE_REPORT.md) — a low score will mean
  "judged and rejected" rather than "judged and rejected *or* never looked at".
- Runs cost more, roughly in proportion to corpus size.
- The largest gate in the system is at ingest, not here: `isLikelyOperatingStartup()`
  drops ~1,258 of ~1,575 filings by regex and has never been measured. Routing the
  dropped set through one triage pass to estimate its false-negative rate is the
  obvious next measurement.
- The 200-row cap in the long-tail table already violates ARCHITECTURE.md's
  "nothing silently dropped after merge" invariant for ~35% of the tail. Ungating
  upstream does not fix that; it is a separate presentation bug.

**Rejected.** Adding dense retrieval / embeddings, which
[ROADMAP](ROADMAP.md) item 2b proposes. Once nothing is gated, a retriever's only
remaining job is a tie-break, which does not justify either a new runtime
dependency or an embedding provider this repo does not have. If gating ever
returns — because the corpus grows an order of magnitude — reconsider then, and
calibrate `k` against a measured recall target rather than picking a round number.

**Revisit when.** The corpus outgrows what is affordable to score end-to-end. At
that point the gate should be reintroduced deliberately, with recall@k measured.

---

## ADR-015: Listwise order over the head, pointwise label everywhere

**Status:** accepted · depends on [ADR-013](#adr-013-spend-on-document-representation-not-on-scoring-empty-records)

**Context.** The screen scores batches of 8 independently, so a 72 produced in one
batch and a 72 produced in another were never compared against each other. That is
adequate for a cutoff and wrong for a ranking, as [ROADMAP](ROADMAP.md) item 2b
notes. Separately, `recency` — 30 of the prefilter's ~111 points, its heaviest
signal — correlates **−0.103** with the screen's judgement.

The batching effect has since been measured. Ingesting one more day reshuffled
every batch; of 101 companies re-scored from byte-identical input, **89 changed
score**, mean |Δ| **7.0**, max **29**. That is the width of a scoring band, so
batch composition alone reorders the list — and cross-run score comparisons are
not currently meaningful. See [RANKING.md](RANKING.md).

**Decision.** Score pointwise over the whole corpus for the displayed value
(`fit`, `rationale`, `confidence`), then re-rank **listwise over the top ~40 only**
for order. Move freshness out of relevance entirely: it becomes the lookback
window, not a ranking term. Rank on topical fit, show joinability beside it, and
diversify the final twelve with MMR.

**Why.** NDCG@k depends only on the head, so a globally consistent order is not
worth buying — the relative position of #200 and #201 is unobservable to the user.
Splitting the two jobs also keeps what the report needs: an interpretable per-company
score with a rationale and a confidence, which a pure permutation output does not give.

Freshness is not a relevance dimension; it is an eligibility criterion that was
being summed into a relevance score, where it dominated and pointed the wrong way.
SCORING.md's defence of recency is a premise argument ("recency is a fact, every
other signal is a guess") and is not contradicted by this — it had simply never
been measured against an outcome.

**Consequences.**

- **Batch-composition dependence and position bias are different failures and must
  not be conflated.** The first is the existing defect: independent batches with no
  shared anchor. The second is a property of listwise prompting — items appearing
  early in the input tend to rank higher — and is therefore a risk *introduced* by
  this change. Order-shuffled ensembling (re-running a slate with shuffled input,
  aggregating by Borda count) defends against the second; calibration anchors
  present in every slate defend against the first.
- Cheap experiment before building any of it: re-score one company in a strong
  batch and a weak batch and measure the delta. If small, anchors alone may do.

**Rejected.**

- **RankGPT-style sliding window over all 324**, swept bottom-to-top. It does
  globalize — overlapping windows let a bottom item reach the top in a single pass
  — but it needs a reasonable *initial* order, which
  [ADR-014](#adr-014-retrieval-orders-it-does-not-gate) removes.
- **Merge sort with an LLM comparator.** O(n log n) calls, and it assumes a
  transitivity that LLM pairwise comparators do not reliably satisfy.

**Revisit when.** The batch-composition experiment shows the effect is large even
with anchors, which would argue for listwise over a wider slice than the head.

---

## ADR-016: Serve the dashboard from the committed data rather than inlining it

**Status:** accepted · at the user's request

**Context.** Every run wrote a dated `*-dashboard.html` that inlined the whole
dataset as a `const ROWS = [...]` literal. Measured on a real run: **521 KB, of
which 507 KB (97%) was data** — and that data was a verbatim copy of records
already committed under `data/scored.jsonl` and `data/dossiers.jsonl`. A run
committed the same company records twice.

**Decision.** `renderDashboard()` emits a ~17 KB shell containing no data. It
fetches `data/scored.jsonl`, `data/dossiers.jsonl`, and a ~130-byte
`reports/meta.json` at load time and joins them in the browser. The shell lives
at the repo root as `index.html` so those relative paths resolve both under a
local static server and on GitHub Pages served from the repo root.

**Why not the alternatives.**

- **Emit a purpose-built `dashboard.json` per run.** Smaller page load, but the
  JSON is still a per-run duplicate of `data/`, so it only halves the growth
  instead of removing it.
- **Shard the JSONL by run, so each page loads one shard.** Considered and
  rejected. A dated dashboard shows the *cumulative* corpus, so a per-run shard
  only works if the page becomes a "what's new" view — a different product. It
  would also fragment the storage layer ([ADR-002](#adr-002-jsonl-files-on-disk-instead-of-a-database))
  across many files for a dataset in the low hundreds of rows. The measurement
  that settled it is below: the growth was not really about file size.

**The related fix, which mattered more than the split.** `scored.jsonl` was
written sorted by score, so every run reordered the entire file and git stored a
fresh ~800 KB blob even when only ~200 of 421 lines had changed — a reordered
file barely delta-compresses. It is now written in **id order**, which is stable
across runs, so a run's stored diff is about the size of what actually changed.
Consumers sort explicitly; `stageResearch` previously depended on the file's
score order and now ranks what it reads.

**Consequences.**

- **The page must be served.** `fetch` is blocked on `file://`, so opening
  `index.html` directly shows an error panel naming the fix
  (`python3 -m http.server`). This gives up the old "works from file://, survives
  being emailed" property, which was a real one. The `review-startups` skill
  starts the server.
- **One dashboard, not one per run**, since it renders whatever is on disk now.
  Dated Markdown digests remain the back issues. The two existing dated
  dashboards were deleted.
- **The build-time injection surface is gone.** A crafted SEC entity name could
  previously have closed the inlined `<script>`; nothing about a company is
  written into the shell at all now. Escaping still applies at render time in the
  browser.
- Page load is ~910 KB uncompressed, ~200 KB over a gzipping server. Fine for one
  page view; revisit if the corpus grows an order of magnitude, at which point
  loading the scored head first and the tail lazily is the natural next step.
- GitHub Pages is not enabled by this change — that is a repo setting. The shell
  carries `<meta name="robots" content="noindex, nofollow">` and the repo has a
  `.nojekyll` marker, so enabling it is a one-click step whenever wanted. The
  noindex is deliberate: the repo is public, but a digest of which companies
  someone is tracking does not need to be search-indexed.

**Revisit when.** The corpus outgrows a single fetch, or the grading loop needs a
POST endpoint anyway — at which point the local server could write
`data/labels.jsonl` directly and the export step disappears.
