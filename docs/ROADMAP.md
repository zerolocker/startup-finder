# Roadmap

_What to build next, ranked by expected value. Read [VISION.md](VISION.md) first._

This is a queue for future sessions, not a commitment. Each item states the
problem it solves, because the problem outlives the proposed solution.

---

## 1. A feedback loop — the app has no memory of taste

**Problem.** The only thing the app knows about the user is a static
`config/profile.yaml`. It cannot learn that they keep ignoring biotech, or that
they opened three infra companies last week. Every run starts from zero.

This is the single biggest gap between the app as built and the app as described
in [VISION.md](VISION.md), which calls the judgement layer the whole point.

**Collection is shipped.** The `review-startups` skill plus the grading controls
in the HTML dashboard write `data/labels.jsonl` —
`{companyId, grade, rank, at, runId}`, graded `0 = ignored · 1 = opened ·
2 = saved`. Grading is mostly passive: scrolling past a card records *seen*,
expanding Details records *opened*, and only ★ save is a click. A CLI
`sf mark` was considered and dropped — grading happens while reading the digest,
which is a browser, not a terminal.

Two properties to preserve if this is ever rewritten, both explained in
[RANKING.md](RANKING.md): companies that were never displayed are **absent**
rather than `0`, and the on-screen `rank` is recorded so an eval can truncate
where attention actually ran out.

**Still to build.** Feed a compact history of past verdicts into the scoring
prompt as few-shot calibration:

> Previously rated interesting: … Previously rejected: …

Start with the prompt approach before anything statistical. With a few dozen
labels, an LLM reading the labels will beat any weight-fitting, and it stays
interpretable.

**Watch out for.** Feedback should adjust ranking, not filter — the user should
still be able to see everything. And avoid a self-reinforcing loop where the app
only ever shows the one theme the user clicked first.

---

## 2. Hiring signals as a first-class source

**Problem.** For "should I join", an open senior engineering role is a stronger
signal than round size — arguably the strongest available. Right now open roles
are only discovered during research (stage 3), which is far too late to influence
which 15 companies get researched.

**Sketch.** Greenhouse, Lever, and Ashby all expose free structured public job
boards (`boards-api.greenhouse.io/v1/boards/{token}/jobs` and equivalents). Most
funded startups use one. Given a company domain, the board token is usually
guessable or discoverable from the careers page. A `src/sources/jobs.ts` that
resolves a company → job board → open roles would let `prefilter.ts` weight
"hiring senior engineers" before spending LLM money.

**Blocked on.** Company → domain resolution, which Form D does not provide. That
may itself need a cheap LLM or search step, which weakens the "free prefilter"
property. Worth prototyping on the ~15 researched companies first, where the
dossier already contains the homepage URL.

---

## 2b. Enrich before ranking — the measured recall fix

**Problem.** Recall@120 of the prefilter is **75%** at fit ≥ 70, and the miss
included `Taktile Holding, Inc.` at fit 88 — the best company in the corpus,
ranked #131 because the keyword matcher found nothing in its name (`theme: 0`).
See [SCORING.md](SCORING.md). Raising `--limit` treats the symptom; the cause is
that ranking happens on a name before anything knows what the company does.

**Sketch.** Invert the order: resolve every candidate to a domain and homepage
description *first* (the research stage already proves this works — it turned
"Proactive AI Lab, Inc." into "Palona AI, voice agents for restaurants"), then
rank on that text.

**Related defect.** Screening scores batches of 8 independently, so a 72 in one
batch and a 72 in another were produced without reference to each other. That is
fine for a cutoff but wrong for a ranking. Listwise reranking over a single slate
would fix it.

**Now specified in full: [RANKING.md](RANKING.md).** That document supersedes this
sketch in two places. It argues *against* the embeddings suggested above — once
nothing is gated, a retriever's only remaining job is a tie-break
([ADR-014](DECISIONS.md#adr-014-retrieval-orders-it-does-not-gate)) — and it
scopes listwise reranking to the top ~40 rather than the whole corpus, because
NDCG@k depends only on the head
([ADR-015](DECISIONS.md#adr-015-listwise-order-over-the-head-pointwise-label-everywhere)).

**Blocked on.** Nothing technical — it is a cost question, and enrichment is
permanently cacheable per company.

---

## 3. An evaluation harness for scoring changes

**Problem.** [SCORING.md](SCORING.md) has to tell you to eyeball the top 20 before
and after a change, because there is no automated way to tell whether a rubric
edit helped. That makes prompt changes risky and discourages improvement.

**Sketch.** Freeze ~50 companies from a real run as a fixture with hand-labeled
expected bands (not exact scores — bands). Add `pnpm sf eval` that re-scores the
fixture and reports band accuracy, plus the score distribution and
low-confidence share, both of which are documented regression signals.

**Unblocked.** Item 1 now writes `data/labels.jsonl`, which is the label source
this needs. [RANKING.md](RANKING.md) specifies what `sf eval` should report and
records the baselines to beat: NDCG@12 = 0.500, ρ = 0.374, recall@120 = 75%. It
also names the trap — pseudo-labels derived from the screen's own `fit` can
measure any stage *below* the screen but are circular on the screen itself.

---

## 4. Track companies over time

**Problem.** Every run is a snapshot. A company that raised six months ago and has
since tripled its open-role count is very interesting, and the app cannot express
that. `firstSeenAt` is stored but nothing uses it.

**Sketch.** Because all data is committed to git ([ADR-007](DECISIONS.md)), the
history already exists. A `pnpm sf trend <id>` that walks git history for a
company's record would be a cheap first version. A richer one would add a
"movers" section to the digest.

---

## 5. Wider and better sources

See [DATA_SOURCES.md](DATA_SOURCES.md#sources-worth-adding) for the full list with
rationale. Highest value: Hacker News (Launch HN + Who-is-hiring), YC and
accelerator directories, Product Hunt, GitHub activity for dev-tool companies.

Non-US coverage is the biggest structural gap — Form D is US-only, so everything
international arrives through press, which is thin for early rounds.

---

## 6. Scheduling — shipped

`./scripts/install-schedule.sh` installs a weekly launchd job that runs the
pipeline, commits the dated issue, and posts a macOS notification. See
[SCHEDULING.md](SCHEDULING.md).

Deliberately not included: email delivery. It sends things outward on the user's
behalf unattended and needs credentials, so it should not be built without them
asking. Pushing to the remote is also off by default, because the repo is public
and the reports reveal which companies the user is tracking.

---

## Known rough edges

Small, real, and worth fixing when nearby:

- **Batching defeats the response cache, so incremental runs pay full price.**
  Batches are contiguous slices of the *prefilter-ranked* list
  (`score.ts`), and the cache key is a hash of the whole batch prompt. Adding one
  day of filings reorders the list, which reshuffles every batch, which changes
  every prompt — so 101 companies whose evidence had not changed at all were
  re-screened at full cost. Measured: **$1.72 for a run where ~$1.45 of it bought
  nothing.**

  The fix is to cache **per company** rather than per batch: key each company's
  score on its own rendered evidence plus the rubric, look those up first, and
  batch only the misses. That decouples caching from batch composition entirely
  and would take a one-day incremental run from ~$1.72 to ~$0.50. It also removes
  a coupling that makes cost depend on rank order, which is nobody's mental model.
- **Lifetime plan usage is not actually tracked.** `runs.jsonl` is only appended by
  `sf run`, so running stages individually — which is what the docs recommend while
  iterating — records nothing. `pnpm sf stats` reports `Runs 0 (lifetime plan usage
  ~$0.00-equiv)` after a session that really spent ~$3.20. Since rate limit is the
  scarce resource, this is the one number worth getting right; each stage should
  append its own record.
- **A carried-forward score can be silently stale.** `stageScore` now keeps LLM
  scores from earlier runs, which is strictly better than discarding them, but the
  company's evidence may have changed since. `Company.lastUpdatedAt` and the new
  `ScoredCompany.llmScoredAt` are enough to detect it — if the former is newer, the
  score predates the evidence and the company should be preferred for re-screening.
- **Duplicate companies** under name variants — see
  [ADR-004](DECISIONS.md#adr-004-exact-name-matching-only). The intended fix is a
  curated alias map in `config/`, not fuzzy matching.
- **Non-USD amounts are not FX-converted.** `€39.9M` is stored as `39900000`. Fine
  for bucketing, wrong for precise comparison.
- **`data/companies.jsonl` is rewritten in full** on every merge. Fine at this
  size, quadratic eventually.
- **The dashboard inlines the whole dataset** (~300 KB/run). Committing one per
  run will bloat the repo over time; keeping only `latest.*` plus a monthly
  archive is the first mitigation.
- **Long lookbacks are slow** on a cold cache — one HTTP request per filing,
  throttled to ~8/s for the SEC, so roughly 160 filings per day of window.
  ~1,600 filings ≈ 3.5 minutes; the 90-day auto-catch-up cap is ~30 minutes.
  Cached reruns are instant.
- **News cannot be backfilled.** Auto-catch-up widens the EDGAR window, but RSS
  feeds only carry recent items, so a long gap permanently loses the press side
  for that period. Only affects non-US rounds and round labels — the Form D
  spine still covers US funding for the whole window.
- **Research quality varies with name ambiguity.** Companies with generic names
  ("Core Automation") produce low-confidence dossiers. The prompt handles this
  honestly, but a domain-resolution step (see item 2) would help a lot.

## Explicitly not planned

From [VISION.md](VISION.md)'s non-goals — do not build these without the user
asking: a web service or hosted UI, multi-user support, real-time alerting, a
comprehensive funding database, or anything resembling investment advice.
