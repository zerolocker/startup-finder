# startup-finder

Finds recently-funded startups worth your time, researches them, and writes you a
digest.

```bash
pnpm install
pnpm sf run
```

Output: [`reports/latest.md`](reports/latest.md) and
[`reports/latest.html`](reports/latest.html), both committed to the repo.

---

## What it produces

A real incremental run — one extra business day on top of an existing corpus:
206 SEC filings → 52 operating companies → 378 candidates → 120 LLM-screened →
researched in depth. About nine minutes, $3.20-equivalent of plan usage.

That day's best new find was an AI evaluation and observability platform, scored
79, with its product, customers, and two open roles — none of which appears in
the SEC filing that surfaced it. The top of the digest overall is a $110M
decisioning-infrastructure company at 88.

## Why it exists

SEC Form D is the only comprehensive record of US private funding: every round,
public within 15 days, free. It is also nearly unusable — ~80% of filers are
real-estate SPVs and investment funds, and a real company's filing gives you a
name, a dollar amount, and an industry code. Nothing about what they do.

News is the opposite: rich, but only covers companies that already have PR.

So: **Form D for recall, news for context, an LLM for the judgement in between.**

## How it works

```mermaid
flowchart TD
    A["<b>SEC Form D</b> — 206 filings"] -->|"−154 funds, SPVs, real estate"| C
    B["<b>funding news RSS</b> — 7 feeds, 39 items"] --> C
    C["<b>merge</b> — exact-name join<br/>378 companies, cumulative"] --> D
    D["<b>prefilter</b> — deterministic, free<br/>ranks all 378 · <b>gate: top 120 only</b>"]
    D -->|"top 120"| E
    D -->|"258 skipped, still kept"| S
    E["<b>llm screen</b> — batched ×8, no web<br/>120 scored · $1.72 · 3.5 min"] --> S
    S[("<b>data/scored.jsonl</b> — 331 scored<br/>120 fresh + 211 carried forward<br/>from runs that already paid for them")]
    S --> F & R
    F["<b>research</b> — web search<br/>top 8 → dossiers · ~$0.40 each"] --> R
    R["<b>report</b>"] --> G["reports/latest.md"]
    R --> H["reports/latest.html<br/>grading UI → data/labels.jsonl"]

    classDef gate fill:#fde68a,stroke:#b45309,color:#1a1a19
    classDef store fill:#d1fae5,stroke:#047857,color:#1a1a19
    class D gate
    class S store
```

Numbers are one real incremental run: one extra business day of filings on top of
an existing corpus, **$3.20-equivalent in about nine minutes**. Each stage runs
independently against on-disk data, so you can re-screen and re-report without
re-running the expensive research.

The dashed edges are the two things worth understanding. The **prefilter is a
gate** — only its top `--limit` are ever screened, and it ranks on a company's
legal name before anything knows what the company does, which is why its ordering
scores NDCG@12 = 0.500 against the screen's own judgement. And **scores carry
forward** between runs, so a company that drifts below the cutoff keeps the
judgement an earlier run paid for instead of silently reverting to unscored.
Both are measured in [`docs/RANKING.md`](docs/RANKING.md), which specifies the
replacement.

```bash
pnpm sf run                        # everything (the normal entry point)
pnpm sf run --days 3 --research 5  # quick pass
pnpm sf score && pnpm sf report    # re-screen after editing your profile
pnpm sf stats                      # what's in data/
pnpm sf show oxide-computer        # everything known about one company
pnpm sf prompt --limit 3           # the exact screening prompt, no LLM call
pnpm sf prompt --stage research    # the research prompt, no LLM call
```

## Run it weekly

```bash
./scripts/install-schedule.sh     # Monday 08:00, via launchd
```

Each run writes a dated issue to `reports/`, commits it, and notifies you. Back
issues live in git. Pushing is off by default — this repo is public. Details in
[`docs/SCHEDULING.md`](docs/SCHEDULING.md).

## Configure it

[`config/profile.yaml`](config/profile.yaml) defines what "a startup worth my
time" means — themes and weights, round-size window, geography, and a free-text
description of you passed verbatim to the model.

**If results feel wrong, edit that file before touching any code.** Then
`pnpm sf score && pnpm sf report`.

## Requirements

Node 22+, pnpm, and the [Claude Code CLI](https://claude.com/claude-code) on your
PATH. Optionally set `SF_CONTACT` to your email — the SEC asks automated clients
to identify themselves.

## Cost

Runs on your Claude subscription. **Nothing is billed to a card.** A full run
uses roughly $4-equivalent of tokens, reported at the end of the run and kept in
`data/runs.jsonl`. Responses are cached, so re-runs cost almost nothing.

There is no spend cap — a run uses what the work needs. `--limit` (companies
screened) and `--research` (dossiers written) are the knobs that make a run
cheaper.

## Repo layout

```
config/profile.yaml   what you care about — the only file most users edit
src/sources/          EDGAR and RSS ingestion
src/pipeline/         merge, prefilter, LLM scoring, research
src/report/           markdown digest + HTML dashboard
src/llm/claude.ts     the claude -p wrapper (caching, cost accounting, retries)
data/*.jsonl          all persisted data, committed to git on purpose
reports/              generated digests, committed
docs/                 why things are the way they are — read before changing
```

## For agents and contributors

Start with [`CLAUDE.md`](CLAUDE.md), then
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
[`docs/DECISIONS.md`](docs/DECISIONS.md) records what was tried and rejected, and
[`docs/RANKING.md`](docs/RANKING.md) is the measured redesign of how candidates
are filtered and ordered — read it before touching either.

```bash
pnpm test        # 135 tests, no network required
pnpm typecheck
```

## Limitations

- **Lookback auto-catches-up, up to 90 days.** Omit `--days` and the window
  widens to cover everything since your last run. Gaps longer than 90 days are
  capped, and the run tells you exactly how many days it skipped and what to run
  to backfill them. News feeds cannot be backfilled at all — RSS only carries
  recent items.
- **US-centric.** Form D is a US filing; non-US startups appear only via press.
- **Name matching is exact-only** by design, so one company can appear twice under
  different spellings ([ADR-004](docs/DECISIONS.md)).
- **Research can be wrong.** It is a model reading the web. Anything not backed by
  a link in the report should be verified before you act on it.

**[`docs/READING_THE_REPORT.md`](docs/READING_THE_REPORT.md) is the one to read
before acting on a digest** — what a score actually means, where every ranking
signal comes from, and what never reaches you. More on coverage in
[`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).
