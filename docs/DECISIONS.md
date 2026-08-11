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

**Revisit when.** Repo size becomes a problem. First mitigation is to keep only
`latest.*` plus a monthly archive rather than every dated run.

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
