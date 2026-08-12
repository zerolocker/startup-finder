---
name: review-startups
description: Run the startup grading loop — open the dashboard so the user can grade companies, or ingest the grades they exported (merge into data/labels.jsonl, report the distribution, commit). Use when the user says "review startups", "grade the digest", "let's label some companies", "process my grades", or "done" after a review session.
---

# Reviewing startups

Human-in-the-loop relevance labels for `data/labels.jsonl`. These are the only
ground-truth signal this app has — the screen's own `fit` can measure the stages
*below* it, but nothing except a human can measure the screen. Design rationale:
[docs/RANKING.md](../../../docs/RANKING.md). Two modes.

## Mode A — review (user wants to grade)

Regenerate the dashboard so it reflects the current data, then open it:

```bash
pnpm sf report && open "$(ls -1 reports/*-dashboard.html | sort | tail -1)"
```

Tell them three things and then **stop and wait**:

1. **Set "Min fit" to `any`.** It defaults to `70+`, which renders 8 of 324 rows.
   Labels only exist for companies actually displayed, so leaving the filter up
   means grading only what the ranker already liked — the exact bias these labels
   are meant to detect.
2. **Grading is mostly automatic.** Scrolling past a card marks it *seen*
   (grade 0, ignored). Expanding **Details** marks it *opened* (grade 1). Only
   ★ **save** (grade 2) is a deliberate click. So a normal read-through produces
   labels without grading 300 companies by hand.
3. **Press "Save grades" when done**, which writes `labels.json` — to a location
   they choose in Chrome, or to `~/Downloads` elsewhere.

Grades autosave to `localStorage` continuously, so a refresh or a closed tab
loses nothing. They can review across several sittings and export once.

## Mode B — process ("done", "process my grades")

1. **Find the export.** Check, in order: repo root, `~/Downloads/labels.json`,
   then the newest `labels*.json` under `~/Downloads`. If there is none, they are
   probably still in Mode A — say so rather than guessing.

2. **Merge into `data/labels.jsonl`.** One JSON object per line:
   `{companyId, grade, rank, at, runId}`. Upsert by `companyId` — a later grade
   for the same company replaces an earlier one, since taste is allowed to
   change, but keep every distinct `runId` observation, because a company graded
   across two runs is signal about drift, not a duplicate.

3. **Sanity-check before writing.** Three things that mean the export is wrong:
   - Any `companyId` absent from `data/scored.jsonl` — a stale dashboard.
   - Every grade `0` — usually a fast scroll to the bottom, not real judgement.
   - Fewer than ~20 labels — say so; it is not enough to compute anything
     stable, though it is fine to bank it and continue later.

4. **Report** the grade distribution (how many 0/1/2), how many are new versus
   updated, the total in `data/labels.jsonl`, and the deepest `rank` graded —
   which is how far down the list attention actually reached.

5. **Commit** `data/labels.jsonl` on a branch, per CLAUDE.md rule 3. Do not push
   unless asked.

## What the grades mean, and how they can lie

`0 = ignored · 1 = opened · 2 = saved`. There is no 3; the user almost never
reaches out to a founder, so a fourth level would be permanently empty. If that
ever changes, add it — existing labels stay valid.

Two biases to preserve rather than paper over, both load-bearing for any eval
built on these labels:

- **A company is only labeled once it was actually on screen.** Unexamined
  companies are *absent* from the export, never `0`. If they were exported as 0,
  every eval would conclude that whatever the ranker buried deserved burying —
  a bias that is invisible and self-confirming. Never fill missing rows with 0
  when merging.
- **`rank` records where on screen the company was when it was seen.** Attention
  decays down a 324-row list, so a `0` at rank 300 is much weaker evidence than a
  `0` at rank 5. Keep the field; an eval can truncate on it.

## If the export gets fiddly

The File System Access API only exists in Chromium, so other browsers fall back
to a plain download. If that becomes annoying, the alternative is the approach
`screensaver-art`'s `curate-gallery` skill uses — a small local server the page
POSTs to, writing straight into the repo. That trades the current
self-contained-single-file property of the dashboard for convenience; it is
deliberately not built yet.
