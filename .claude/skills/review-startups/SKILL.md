---
name: review-startups
description: Run the startup grading loop — open the dashboard so the user can grade companies, or ingest the grades they exported (merge into data/labels.jsonl, report the distribution, commit). Use when the user says "review startups", "grade the digest", "let's label some companies", "process my grades", or "done" after a review session.
---

# Reviewing startups

Human-in-the-loop relevance labels for `data/labels.jsonl`. The model's own `fit`
score cannot tell you whether the model has good taste; only the user can. These
labels are the only ground truth this app has. Two modes.

## Mode A — review (user wants to grade)

Serve the repo root and open the dashboard. It **must be served** — the page
fetches `data/`, and `fetch` is blocked on `file://`, so opening `index.html`
directly shows a "could not load the data" panel instead of the issue:

```bash
python3 -m http.server 8000 >/dev/null 2>&1 & sleep 1 && open http://localhost:8000/
```

Run the server in the background and stop it when they are done. If port 8000 is
taken, any port works. There is nothing to build and no dependency to install.

Tell them three things and then **stop and wait**:

1. **Pick the issue** with the Issue dropdown. Each run is one day; the dashboard
   shows one at a time. "Min fit" already defaults to `any`, and every company in
   the run is rendered, so no filtering is needed to see everything.
2. **Grading is mostly automatic.** Scrolling a card up past the middle of the
   screen marks it *seen* (grade 0, ignored) — the bottom of the screen does not
   count, since that is where a card waits its turn rather than where it is read.
   Expanding **Details** marks it *opened* (grade 1). The only clicks are
   ★ **save** (grade 2) and **not interested** at the foot of the Details panel,
   which puts a card they read and rejected back to 0. So a normal read-through
   produces labels without grading every company by hand.
3. **Press "Save grades" when done**, which writes `labels.json` — to a location
   they choose in Chrome, or to `~/Downloads` elsewhere.

Grades autosave to `localStorage` continuously, so a refresh or a closed tab
loses nothing. They can review across several sittings and export once.

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
  decays down a long list, so a `0` near the bottom is much weaker evidence than a
  `0` at the top. Keep the field; an eval can truncate on it.

A `0` reached through **not interested** is a read verdict, not inattention, and
is the strongest 0 in the file — but the export does not distinguish it, so an
eval cannot weight it. Add a field before relying on that difference.

## If the export gets fiddly

The File System Access API only exists in Chromium, so other browsers fall back
to a plain download. If that becomes annoying, the fix is the approach
`screensaver-art`'s `curate-gallery` skill uses: have the page POST grades to a
small local server that writes `data/labels.jsonl` directly, removing the export
step entirely. Mode A already runs a server, so this is a smaller change than it
once was — `python3 -m http.server` just needs replacing with something that
accepts a POST. Deliberately not built yet.
