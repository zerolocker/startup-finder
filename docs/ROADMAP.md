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

**Sketch.** Add `data/feedback.jsonl` with `{companyId, verdict, note, at}` where
verdict is something like `interested` / `not-interested` / `applied`. Add
`pnpm sf mark <id> <verdict> [note]`. Then feed a compact history of past
verdicts into the scoring prompt as few-shot calibration:

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

## 3. An evaluation harness for scoring changes

**Problem.** [SCORING.md](SCORING.md) has to tell you to eyeball the top 20 before
and after a change, because there is no automated way to tell whether a rubric
edit helped. That makes prompt changes risky and discourages improvement.

**Sketch.** Freeze ~50 companies from a real run as a fixture with hand-labeled
expected bands (not exact scores — bands). Add `pnpm sf eval` that re-scores the
fixture and reports band accuracy, plus the score distribution and
low-confidence share, both of which are documented regression signals.

Combines well with item 1: user feedback is the natural source of labels.

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
