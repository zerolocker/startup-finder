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
   user to provision one to run their own tool is real friction.
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

**Status:** accepted · after a real overshoot

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
