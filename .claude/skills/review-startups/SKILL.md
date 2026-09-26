---
name: review-startups
description: Run the startup grading loop — point the user at the digest on their phone, open it at a desk, check where their grades are, or ingest a grades file they exported (merge into data/labels.jsonl, report the distribution, commit). Use when the user says "review startups", "grade the digest", "let's label some companies", "how are my grades", "process my grades", or "done" after a review session.
---

# Reviewing startups

Human-in-the-loop relevance labels for `data/labels.jsonl`. The model's own `fit`
score cannot tell you whether the model has good taste; only the user can. These
labels are the only ground truth this app has.

**The normal path needs no skill at all.** The dashboard is served by GitHub
Pages at https://zerolocker.github.io/startup-finder/ and grades save themselves
from there (ARCHITECTURE.md, "Grades"). This skill is for pointing the user at
it, the desk fallback, and reading the results.

## Mode A — review (user wants to grade)

**On a phone, or anywhere with the link:** give them the URL above. If they have
not set it up, the three steps are in README.md under "One-time setup" — Pages
on, open it, tap **Not synced** and paste a token. Tell them grading is a tap on
★ **Save** or ✕ **Not interested**, opening the full dossier counts as *opened*,
and swiping past records nothing. Then **stop and wait**.

**At a desk, without Pages:** serve the repo root and open the dashboard. It
**must be served** — the page fetches `data/`, and `fetch` is blocked on
`file://`:

```bash
python3 -m http.server 8000 >/dev/null 2>&1 & sleep 1 && open http://localhost:8000/
```

Served from localhost the page cannot guess the repo, so to save to GitHub they
fill in `zerolocker/startup-finder` beside the token. Without a token, grades
autosave to `localStorage`; **Download grades file** in the sync panel writes
`labels.json` to `~/Downloads`, and Mode B takes it from there.

## Mode B — process ("done", "process my grades")

1. **Find the export.** Check, in order: repo root, `~/Downloads/labels.json`,
   then the newest `labels*.json` under `~/Downloads`. If there is none, they are
   probably still in Mode A — say so rather than guessing.

2. **Merge into `data/labels.jsonl`.** One JSON object per line:
   `{companyId, grade, rank, at, runId}`, where `runId` is the issue date. Upsert
   by `companyId` — a later grade replaces an earlier one, since taste is allowed
   to change — but keep every distinct `runId` observation, because a company
   graded in two issues is signal about drift, not a duplicate.

3. **Sanity-check before writing.** Three things that mean the export is wrong:
   - Any `companyId` absent from that run's `data/runs/<date>.jsonl` — a stale tab.
   - Every grade `0` — possible, but check it was not a run of misclicks; a 0
     now costs a deliberate press.
   - Fewer than ~20 labels — say so; it is not enough to compute anything
     stable, though it is fine to bank it and continue later.

4. **Report** the grade distribution (how many 0/1/2), how many are new versus
   updated, the total in `data/labels.jsonl`, and the deepest `rank` graded —
   which is how far down the list attention actually reached.

5. **Commit** `data/labels.jsonl` on a branch, per CLAUDE.md rule 3. Do not push
   unless asked.

## Mode C — "how are my grades?"

`git pull`, then read `data/labels.jsonl` and report as in Mode B step 4. If an
open pull request from the `grades` branch exists, those grades are saved but
not merged yet: say so, and say why if GitHub gives a reason (usually a merge
conflict with a hand edit of the file on `main`). Do not merge it without asking.

## What the grades mean, and how they can lie

`0 = not interested · 1 = opened · 2 = saved`. There is no 3; the user almost
never reaches out to a founder, so a fourth level would be permanently empty. If
that ever changes, add it — existing labels stay valid.

A `0` is a press of **not interested**, never an inference from scrolling. The
dashboard used to mark a card *seen* once it had been on screen long enough and
export that as a 0; it no longer does, because "on screen" could not tell a read
from a skim. Labels recorded before that change (the 2026-08-17 batch) contain
both kinds — 12 of its 26 zeros were deliberate, 14 were scroll marks — and
there is no field distinguishing them.

Two biases to preserve rather than paper over, both load-bearing for any eval
built on these labels:

- **A company is only labeled once it was actually on screen.** Unexamined
  companies are *absent* from the export, never `0`. If they were exported as 0,
  every eval would conclude that whatever the ranker buried deserved burying —
  a bias that is invisible and self-confirming. Never fill missing rows with 0
  when merging.
- **`rank` records the row's position on screen when it was judged**, counted
  down the list as filtered at that moment. The deck and the list share one
  order, so in the deck it is the slide number. It is recorded on the click, so it
  is the position the company actually held when the call was made. Its main use
  now is bounding how deep a session reached: with passive marks gone, an absent
  company may have been skimmed or never reached, and the deepest `rank` is the
  only handle on which. Note it is derivable from the run shard *only* if you
  know which filters were on — for the 2026-08-17 batch all 35 ranks reproduce
  from a default-filter sort, and only 26 do without the filter.

## Where grades are written

The page writes `data/labels.jsonl` itself, through the GitHub API, with the same
upsert rules as Mode B: one line per `(companyId, runId)`, a regrade replaced in
place, untouched lines byte-identical, a grade toggled off removed. That logic is
`mergeLabelFile()` in `src/report/web/model.js`, tested in `test/model.test.ts`;
change both paths together or they will drift.
