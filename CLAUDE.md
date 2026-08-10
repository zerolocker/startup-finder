# Working in this repo

_Orientation for AI agents. Humans should start with [README.md](README.md)._

This project is explicitly designed to be picked up by many different agent
sessions. The `docs/` directory exists so you do not have to re-derive intent from
code. **Read before you change.**

## Read these first

| If you are about to… | Read |
|---|---|
| Get oriented fast | [README.md](README.md) — the pipeline in one diagram |
| Explain output quality to a human | [docs/READING_THE_REPORT.md](docs/READING_THE_REPORT.md) |
| Anything at all | [docs/VISION.md](docs/VISION.md) — why this exists, non-goals |
| Change structure or add a stage | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Change what gets surfaced | [docs/SCORING.md](docs/SCORING.md) |
| Add or modify a data source | [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) |
| Replace something fundamental | [docs/DECISIONS.md](docs/DECISIONS.md) — check it wasn't already rejected |
| Pick up new work | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Change how it runs on a schedule | [docs/SCHEDULING.md](docs/SCHEDULING.md) |

`src/types.ts` is the contract between all pipeline stages and is the best single
file to read for a fast mental model.

## Commands

```bash
pnpm install
pnpm test           # 135 tests, no network, <1s
pnpm typecheck      # tsc --noEmit, strict
pnpm sf --help      # all CLI options

pnpm sf run                        # full pipeline (~15 min, ~$4-equiv plan usage)
pnpm sf score && pnpm sf report    # re-screen without re-ingesting or re-researching
pnpm sf stats                      # what's in data/
pnpm sf show <company-id>          # full record for one company, incl. score breakdown
pnpm sf prompt --limit 3           # the literal screening prompt, no LLM call
```

## The rules that matter

**1. Unknown is cheap. Wrong is expensive.**
This is the governing principle ([VISION.md](docs/VISION.md)). The user acts on
this output — they may email a founder or apply for a job. A dossier saying "I
could not identify this company" costs ten seconds; a fabricated product
description costs a wasted conversation and trust in every other row. Every prompt
here is written to make admitting ignorance the easy path. **Preserve that when
editing prompts.**

**2. LLM calls consume the user's plan, not their wallet — but consume it hard.**
There is no `ANTHROPIC_API_KEY` here; `claude -p` runs on the user's Claude
subscription via OAuth, so **nothing is billed to a card**. The `total_cost_usd`
the CLI reports is a dollar-*equivalent* of tokens used, and we track it because
it is the best proxy for how much of the subscription's rate limit a run eats.

That limit is the real scarce resource: a fan-out bug can lock the user out of
Claude entirely for hours. Always pass `--budget`. Never remove the disk cache or
the budget reservation in `src/llm/claude.ts`. When testing changes, prefer
`--days 2 --limit 8 --research 2 --budget 1`.

**3. Branch and PR, never commit to `main`.**
Start work with `git checkout -b <type>/<short-description>`, then
`git push -u origin HEAD` and `gh pr create --fill`. A PR keeps a change
reviewable and revertible as one unit, and this repo is handed between many
agent sessions — `main` staying green is what makes that safe.

This is enforced, not just requested: a `PreToolUse` hook
(`.claude/hooks/guard-main-branch.sh`, wired up in `.claude/settings.json`)
refuses `git commit` and `git push` while `HEAD` is on `main`, and tells you how
to recover if you already committed there. For a genuinely deliberate exception,
prefix the command with `SF_ALLOW_MAIN_COMMIT=1` and say why.

**4. Tune config before code.**
If results look wrong, the fix is almost always `config/profile.yaml`, then the
rubric in `src/pipeline/score.ts`. Code is the last resort. Adding a data source
rarely fixes a taste problem.

**5. Don't silently drop companies.**
Anything that survives merge must remain findable — below-cutoff companies keep
`llm: null` and appear in the report's long-tail table. Silent loss is the failure
mode the user cannot detect.

**6. `null` means unknown, never `0`.**
Form D's `totalOfferingAmount` can literally be `"Indefinite"`. A `0` would rank a
company as having raised nothing.

**7. Never run `claude` from the repo root.**
It reads `CLAUDE.md` — this file — from its working directory, which would inject
these instructions into every scoring prompt. `src/llm/claude.ts` runs it from an
empty temp dir. Easy to reintroduce by accident.

## Testing changes

Unit tests cover everything pure and need no network. The network and subprocess
boundaries are deliberately not mocked — the real verification is running the
pipeline.

**When you fix a bug found by a real run, add the offending input as a test case.**
Much of `test/news.test.ts` is exactly that: real headlines that produced garbage
company records, each with a comment saying so. That file is the best model for
how to record a fix.

A cheap end-to-end check:

```bash
pnpm sf ingest --days 2 && pnpm sf merge && pnpm sf score --limit 8 --budget 1 && pnpm sf report
```

## Data and git

`data/*.jsonl` and `reports/*` are generated **and committed on purpose**
([ADR-007](docs/DECISIONS.md)) — git is the time-series store. Only `data/cache/`
is ignored; deleting it is always safe and only costs re-fetch time.

Expect diffs in `data/` and `reports/` when you run the pipeline. That is normal.
Don't revert them, and don't add them to `.gitignore`.

## Keeping docs true

The docs are the reason this repo can be handed between sessions. When you change
behavior, update the doc that describes it **in the same change**:

- New/changed source → `docs/DATA_SOURCES.md`
- Weights, rubric, or bands → `docs/SCORING.md`
- New stage, file, or invariant → `docs/ARCHITECTURE.md`
- A choice a future agent might undo → a new ADR in `docs/DECISIONS.md`
- Shipped a roadmap item, or found a new rough edge → `docs/ROADMAP.md`

An ADR is cheap and disproportionately valuable: it stops the next agent
re-litigating something you already thought through. Record what you rejected and
why, not just what you chose.

## Conventions

- TypeScript, strict, ESM, `.ts` extensions in imports (tsx runs sources directly;
  there is no build step).
- Comments explain **why**, not what. The codebase leans on this heavily —
  particularly around the filtering heuristics and prompts, where the reasoning is
  not recoverable from the code.
- No new dependencies without a good reason. Current runtime deps: `fast-xml-parser`,
  `yaml`, `zod`.
- All HTTP goes through `src/util/http.ts` (rate limiting + caching). The SEC
  IP-bans clients that exceed ~10 req/s.
