# Working in this repo

_Orientation for AI agents. Humans should start with [README.md](README.md)._

This project is picked up by many different agent sessions. `docs/` exists so you
do not have to re-derive intent from code. **Read before you change.**

| If you are about to… | Read |
|---|---|
| Get oriented | [README.md](README.md) — the pipeline in one diagram |
| Change structure, a stage, or an invariant | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Add or modify a data source | [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) |

`src/types.ts` is the contract between all stages and the best single file to read
for a fast mental model.

## Commands

```bash
pnpm install
pnpm test           # 147 tests, no network, <1s
pnpm typecheck      # tsc --noEmit, strict
pnpm sf --help      # all CLI options

pnpm sf run                          # one day, end to end (~15 min, ~$15-18-equiv)
pnpm sf ingest                       # fetch a day, free
pnpm sf research --limit 5           # research 5 of them, ~$1
pnpm sf runs                         # what is on disk, and what it cost
pnpm sf prompt                       # the literal research prompt, no LLM call
```

To view the dashboard, serve the repo root — it reads `data/` over HTTP and cannot
run from `file://`:

```bash
python3 -m http.server 8000
```

## The rules that matter

**1. Unknown is cheap. Wrong is expensive.**
The user acts on this output — they may email a founder or apply for a job. A
dossier saying "I could not identify this company" costs ten seconds; a fabricated
product description costs a wasted conversation and trust in every other row. The
research prompt is written to make admitting ignorance the easy path.
**Preserve that when editing prompts.**

**2. LLM calls consume the user's plan, not their wallet — but consume it hard.**
There is no `ANTHROPIC_API_KEY` here; `claude -p` runs on the user's Claude
subscription via OAuth, so **nothing is billed to a card**. The `total_cost_usd`
the CLI reports is a dollar-*equivalent* of tokens used, and it is the best proxy
for how much of the subscription's rate limit a run eats.

That limit is the real scarce resource: a fan-out bug can lock the user out of
Claude for hours. **There is no spend cap** — one existed and was removed, because
it fired mid-run and discarded work already paid for. What bounds a run is the
size of one day (~60 companies at ~$0.25-0.30 each) plus `--limit`. Keep
`--limit` small while iterating.

A full day is enough to exhaust a Claude Pro window. When it happens the CLI
refuses calls with zero tokens, `PlanLimitError` detects that and stops the run
rather than recording the remaining queue as research failures. Do not "fix"
that by retrying — no backoff outlasts a window; re-run after it resets.

Never remove the disk cache in `src/llm/claude.ts` — with no cap above it, the
cache is the main thing between a careless re-run and a real dent in the rate
limit.

**3. Branch and PR, never commit to `main`.**
Start with `git checkout -b <type>/<short-description>`, then
`git push -u origin HEAD` and `gh pr create --fill`.

This is enforced: a `PreToolUse` hook (`.claude/hooks/guard-main-branch.sh`, wired
in `.claude/settings.json`) refuses `git commit` and `git push` while `HEAD` is on
`main`. For a deliberate exception, prefix with `SF_ALLOW_MAIN_COMMIT=1` and say
why.

**4. Tune config before code.**
If results look wrong, the fix is almost always `config/profile.yaml`, then the
rubric in `src/pipeline/research.ts`. Code is the last resort. Adding a data source
rarely fixes a taste problem.

**5. Don't gate.** Every company a run finds gets researched and scored, and every
one is rendered. The ingest filter is the only thing allowed to drop a company. If
you are about to add a stage that keeps "the top N", that is the design this app
was rewritten to get rid of — see the note in ARCHITECTURE.md on why.

**6. `null` means unknown, never `0`.**
Form D's `totalOfferingAmount` can literally be `"Indefinite"`. A `0` would rank a
company as having raised nothing.

**7. Never run `claude` from the repo root.**
It reads `CLAUDE.md` — this file — from its working directory, which would inject
these instructions into every research prompt. `src/llm/claude.ts` runs it from an
empty temp dir. Easy to reintroduce by accident.

## Testing changes

Unit tests cover everything pure and need no network. The network and subprocess
boundaries are deliberately not mocked — the real verification is running the
pipeline.

**When you fix a bug found by a real run, add the offending input as a test case.**
Much of `test/news.test.ts` is exactly that: real headlines that produced garbage
company records, each with a comment saying so. That file is the best model for how
to record a fix.

A cheap end-to-end check:

```bash
pnpm sf ingest && pnpm sf research --limit 3
```

## Data and git

`data/runs/*.jsonl` and `data/index.json` are generated **and committed on
purpose** — git is the archive of back issues. Only `data/cache/` is ignored;
deleting it is always safe and only costs re-fetch time.

Expect diffs under `data/` when you run the pipeline. That is normal. Don't revert
them, and don't add them to `.gitignore`.

## Keeping docs true

The docs are the reason this repo can be handed between sessions. When you change
behavior, update the doc that describes it **in the same change**:

- New/changed source → `docs/DATA_SOURCES.md`
- New stage, file, or invariant → `docs/ARCHITECTURE.md`
- Anything a user would notice → `README.md`

Prefer measuring over asserting. Several claims in these docs are numbers from real
runs, and they earn their place because a future session can re-derive them.

## Conventions

- TypeScript, strict, ESM, `.ts` extensions in imports (tsx runs sources directly;
  there is no build step).
- Comments explain **why**, not what. The codebase leans on this heavily —
  particularly around the ingest filter and the prompts, where the reasoning is not
  recoverable from the code.
- No new dependencies without a good reason. Current runtime deps:
  `fast-xml-parser`, `yaml`, `zod`.
- All HTTP goes through `src/util/http.ts` (rate limiting + caching). The SEC
  IP-bans clients that exceed ~10 req/s.
