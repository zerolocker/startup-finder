# Vision

_Why this project exists, what "done" looks like, and what it deliberately is not._

This document is the one to read first if you are picking up this repo cold. The
code can be re-derived; the intent behind it cannot.

---

## The problem

The best moment to find a startup — to join it or to back it — is a narrow window
just after it raises and before it becomes legible to everyone else. In that
window:

- The team is small enough that joining is high-leverage.
- The company hasn't posted to the big job boards yet.
- Nobody has written the "how X became a rocketship" article.

That window is public information. In the US, virtually every company raising
private capital files an **SEC Form D within 15 days of first sale**, and those
filings are free, structured, and available the day they land.

Almost nobody reads them, for a good reason: they are 80% noise (real-estate SPVs,
pooled investment funds, co-investment vehicles), and for the 20% that are real
operating companies, the filing tells you a name, a dollar amount, a coarse
industry code, and a list of officers. It does not tell you what the company
*does*, which is the only thing you actually want to know.

So the raw signal is: **comprehensive, timely, free, and nearly unusable.**

## The bet

The gap between "a name and a dollar figure" and "should I care about this" is
exactly the gap an LLM with web access can close, at a cost of a few cents per
company. That was not true two years ago. It is true now.

So the design is:

> Use a comprehensive-but-dumb public source for **recall**, and use an LLM for
> **precision** — but only spend the LLM on the small slice that survives cheap
> deterministic filtering.

Everything in the architecture follows from that sentence.

## What success looks like

The user opens the newest digest in `reports/` on a Monday morning, spends five minutes, and
comes away with two or three companies they had not heard of and genuinely want
to talk to. Not fifty. Two or three.

Concretely, the app is working when:

1. **It surfaces companies the user could not have found by reading TechCrunch.**
   If every result is something already covered in the press, the Form D spine is
   not earning its keep and the app is a worse RSS reader.
2. **The user trusts the "what they do" line.** A single confidently-wrong product
   description costs more trust than ten "unknown"s.
3. **A weekly run costs a few dollars and under twenty minutes.**
4. **Tuning taste means editing `config/profile.yaml`, not code.**

## The north star

**An assistant, not a database.**

There are plenty of products that will sell you a funding database. This is not
trying to be Crunchbase. The value here is in the *judgement layer* — knowing this
specific person's taste well enough to say "this one, not those forty" and to
argue for it.

That means when there is a choice between "more data" and "better judgement about
the data we have," the answer is usually better judgement.

## Non-goals

Recorded so future agents don't spend effort here:

- **Not a comprehensive funding database.** Coverage gaps are acceptable. A missed
  company is a much cheaper error than a fabricated one.
- **Not real-time.** Weekly is the right cadence. Form D has a 15-day filing lag
  anyway, so chasing minutes is chasing noise.
- **Not multi-user.** One person, one profile. Every design choice that trades
  generality for a better single-user experience is the right trade.
- **Not a web service.** A CLI that writes files into a git repo is the whole
  product. Git gives us history, diffs, and durability for free.
- **Not investment advice.** The app describes and ranks. It does not tell anyone
  to put money anywhere, and the reports say so.

## The principle that matters most

**Unknown is cheap. Wrong is expensive.**

This app's output gets acted on — the user might email a founder or apply for a
job based on it. A dossier that says "I could not confidently identify this
company" costs the user ten seconds. A dossier that invents a plausible product
description costs them a wasted conversation and, more importantly, their trust in
every other row in the report.

Every prompt in this codebase is written to make admitting ignorance the easy
path. If you are editing prompts, preserve that. It is the difference between an
assistant and a plausible-sounding noise generator.

## Where this could go

Ranked by expected value, with detail in [ROADMAP.md](ROADMAP.md):

1. **Feedback loop.** The user marks companies interesting/not, and that history
   feeds back into scoring. Right now the app has no memory of taste beyond the
   static profile — this is the single biggest available improvement.
2. **Hiring signals as a first-class source.** For "should I join", an open senior
   engineering role is a stronger signal than the round size. Currently this is
   only discovered during research, too late to affect ranking.
3. **Tracking companies over time.** A company that raised 6 months ago and just
   tripled headcount is interesting in a way a single filing cannot express.
4. **Wider sources.** Non-US coverage is weak. See [DATA_SOURCES.md](DATA_SOURCES.md).

## A note on taste

The hardest part of this problem is not engineering, it is encoding taste. The
profile file is a first approximation and it will be wrong in ways that only show
up when the user reads a digest and thinks "why is this here?"

When that happens, the fix is almost always in `config/profile.yaml` or in the
rubric in `src/pipeline/score.ts` — not in the plumbing. Resist the urge to add
data sources when the real problem is that the app does not yet know what the user
likes.
