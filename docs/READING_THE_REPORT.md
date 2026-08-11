# Reading the report

_How much to trust a row, and what the app cannot see._

The other docs explain how this thing is built. This one is for the person
actually reading a digest, deciding whether to email a founder. Numbers below
come from a real 10-day run: 324 companies, 120 LLM-screened, 17 researched.

---

## The one trap worth knowing

**The score column mixes two different measurements.** A company that reached the
LLM gets its judgement (0–100). A company that did not gets a cheap keyword score
capped at 45.

In that run, 204 of 324 companies were never screened, and they land between
**3.9 and 29.1**. Meanwhile **55 screened companies also score in that range** —
judged, and found wanting.

> Below ~30, a score is ambiguous: it means *either* "the model looked and said
> no" *or* "nothing ever looked at this". Above ~50, a score always means a model
> read the evidence and formed a view.

To tell them apart, check whether the row has a rationale and a confidence badge.
Only screened companies have those. `pnpm sf show <id>` gives the full breakdown.

This is deliberate — the cap exists so an unexamined company can never outrank a
validated one — but it means **the bottom of the list is not a ranking of
badness.** It is mostly a ranking of "not looked at".

## Confidence is not score

They are orthogonal, and conflating them is the second-most-common misreading.

```
confidence among 120 screened:   low 62   medium 44   high 14
```

A company can score **68 with low confidence**: the name and raise look
promising, and the model is telling you it could not verify what they do. That is
a *lead*, not a verdict. High confidence at 78 is a much stronger claim.

Low confidence is common by design — see the next section.

## "Unknown" is a real answer, not a failure

**64 of 120 screened companies (53%) had a `whatTheyDo` starting with
"Unknown".** That is the system working.

The screening stage sees only what a Form D contains — a name, a dollar amount,
an industry code, and a list of officers. It has no web access, and it is
explicitly instructed to say so rather than guess. The alternative is a
confident, invented product description, which is far more expensive: you would
act on it, and it would be wrong.

Companies that survive screening get the research stage, which *does* search the
web. Those rows have real product, team, and hiring detail. The `Fit` table shows
the researched description when one exists.

## Merge is a union, not an intersection

A company needs only **one** source to be a real row.

```
EDGAR filing only : 299
news only         :  25
both              :   0
```

`both: 0` is not a bug and does not mean the merge failed. Most news-derived
companies are European, so no US filing exists for them at all; and Form D is due
within 15 days of *first sale* while press reports at *announcement*, so the two
rarely land in the same window. A single-source row is a normal, complete record.

The practical consequence: **a company with an SEC filing and no press coverage
is not lesser — it is the whole point.** Those are the ones you could not have
found by reading TechCrunch.

## Where the ranking signals come from

A fair question when you see signals like "industry" and "team": those sound like
Crunchbase fields. They are not — **every input to the ranking is a field in the
SEC filing or a regex over the headline.** Nothing is bought, and nothing is
inferred by a model at this stage.

| Signal | Actually read from |
|---|---|
| recency | `dateOfFirstSale` (falling back to `filedDate`) in the Form D XML, or the article's publish date |
| amount | `totalAmountSold`, falling back to `totalOfferingAmount`, or a `$20M`-style regex on the headline |
| industry | `industryGroupType` — one of ~40 coarse SEC buckets |
| theme / antiTheme | keyword regex over the **company name** and headline text |
| geography | `issuerAddress.stateOrCountry` on the filing |
| coverage | how many press items merged into the record |
| corroborated | whether both a filing and press exist |
| team | how many officers/directors the filing lists |

Read that table again and notice what is missing: **no product description, no
traction, no headcount, no growth rate, no valuation, no investor quality.** None
of it exists in a Form D, and the free press feeds do not supply it structurally.

That is the honest reason the prefilter is triage rather than judgement. It is
guessing from a name, a number, an industry code, and a location. Anything that
looks like real insight in the digest came from the two LLM stages downstream —
and only the research stage actually went and looked.

## What the app cannot see

| Blind spot | Consequence |
|---|---|
| Form D is **US-only** | Non-US startups appear only if the press covers them. European coverage is thin for small rounds. |
| Form D has a **15-day filing lag** | "Recently funded" really means "recently *filed*". A round may have closed weeks before it appears. |
| Form D contains **no product description** | Everything about what a company does is inferred or researched, never filed. |
| Form D has **no round label and no investors** | "Series B" and investor names come only from press. Their absence means nothing. |
| RSS feeds carry **only recent items** | A long gap between runs permanently loses the press side for that period. Filings backfill; news does not. |
| Auto-catch-up caps at **90 days** | A longer gap is reported, not silently skipped — the run tells you what it left out. |

## Reading the money

- The figure is **amount raised in this round**, never a valuation.
- We prefer `totalAmountSold` (what investors actually wired) and fall back to
  `totalOfferingAmount` (the target). A fresh filing often shows `sold: 0`
  against a large offering.
- `undisclosed` means genuinely unknown — Form D permits "Indefinite", and press
  often omits the number. It never means zero.
- **Non-USD amounts are not converted.** A €39.9M round is stored as
  `39,900,000`. Fine for bucketing, wrong for precise comparison.
- People listed under "On the SEC filing" are **officers and directors, not
  investors**. Form D does not name funds.

## What you never see

Two filters run before anything reaches you, and both are deliberately biased
toward dropping things:

1. **Non-startups.** Of 1,575 Form D filings in that run, ~1,258 were dropped as
   pooled investment funds, real-estate SPVs, and co-investment vehicles. The
   heuristics are name- and industry-based, so a genuine startup named
   "… Capital" or structured as an LP can be caught by mistake.
2. **The screening cutoff.** Only the top `--limit` (default 120) by prefilter
   score reach the LLM. The prefilter has never seen what a company does — it
   works from a name, an amount, an industry code, and a location. **A great
   company with an uninformative name can rank low and never be looked at.**

   This is measured, not hypothetical: screening the full corpus put
   **recall@120 at 75%** for strong matches, and the two missed companies
   included the highest-scoring company in the entire run — buried at rank #131
   because its name contained no recognizable keyword. If you suspect something
   was missed, raise `--limit` and re-score; it is cheap. Details in
   [SCORING.md](SCORING.md).

Nothing is deleted, though. Everything that survived merge is in the digest's
long-tail table and in `data/scored.jsonl`. If you know a company raised and
cannot find it, `pnpm sf show <id>` will tell you which signal buried it.

## Checking a row before you act

1. **Follow the links.** Every row carries its SEC filing and/or article URL.
   Anything without a link came from a model.
2. **Check the confidence badge** and whether a rationale exists.
3. **Treat the dossier as a lead, not a source.** It is a model reading the web.
   Company names are ambiguous, and the most likely failure is confident
   information about a *different* company with a similar name. The prompt warns
   against this explicitly, but verify the homepage before you write to anyone.
4. **Open roles are the most perishable field** — careers pages change daily.

## If the whole digest feels wrong

That is a taste problem, not a bug. Edit
[`config/profile.yaml`](../config/profile.yaml) and re-run:

```bash
pnpm sf score --limit 200 && pnpm sf report
```

Re-scoring is cheap and research is cached. `pnpm sf prompt --limit 3` prints the
exact text the screening stage sends, and `pnpm sf prompt --stage research`
prints what the research stage sends — both free, so you can see precisely how
your profile is described to the model at each step.
