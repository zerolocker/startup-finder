# Scoring

_How a company gets a number, why the weights are what they are, and how to tune it._

---

## Two scores, different jobs

The most important thing to understand: **the prefilter score and the LLM score
are not the same kind of thing and are not comparable.**

| | Prefilter | LLM score |
|---|---|---|
| Purpose | Triage — who deserves an LLM call | Judgement — is this worth the user's time |
| Sees | Name, amount, industry code, location | The same, plus reasoning |
| Plan usage | none | ~$0.008-equiv/company |
| Optimize for | **Recall** | **Precision + honesty** |
| Shown to user? | No | Yes |

The prefilter exists only because scoring 330 companies with an LLM costs 3x what
scoring 120 does, for essentially the same top-20. It is a cost-control mechanism
wearing the costume of a score.

## `effectiveScore()` — the one ranking function

Defined in `src/pipeline/score.ts` and used by every report:

```ts
llm ? llm.fit : min(45, prefilter.total * 0.5)
```

The cap at 45 is load-bearing: a company the LLM never looked at must never
outrank one it validated. Without it, a company with a great-sounding name could
top the digest on keyword luck alone.

---

## The prefilter, signal by signal

Implemented in `src/pipeline/prefilter.ts`. Totals land roughly in 0–100.

| Signal | Max | Rationale |
|---|---:|---|
| **recency** | 30 | The largest single weight, because "recently funded" is the whole premise. Full marks ≤30 days, linear decay to zero at 180. |
| **amount** | 20 | Full marks inside the profile's `minRaiseUsd`–`maxRaiseUsd` window. Below the floor scales down rather than zeroing, because Form D's "sold so far" understates rounds still closing. Above the ceiling gets 8, not 0 — late-stage is less interesting, not uninteresting. |
| **industry** | 15 | SEC bucket × affinity table. `Computers`/`Other Technology` = 1.0; `Residential` never gets here (filtered upstream). News-only companies get 0.6 by default since press skews tech. |
| **theme** | 15 | Keyword match on name + evidence. Crude by necessity — often a name is all we have. |
| **antiTheme** | −12 each | Crypto, cannabis, gambling, real estate, extractive. Subtractive and stacking. |
| **geography** | 8 | Preferred state match. Small, because remote work makes location a weak signal. |
| **coverage** | 10 | Press mentions. Notability proxy. |
| **corroborated** | 8 | Appears in *both* an SEC filing and the press. The strongest signal available pre-LLM that this is a real, notable round. |
| **team** | 5 | ≥3 officers = 5. A solo-officer filing is often a shell or SPV. |

**Why recency dominates.** Every other signal is a guess about quality; recency is
a fact, and it is the one thing that makes this app different from browsing
Crunchbase. A stale company that scores well on everything else is still a
company the user could have found any time in the last year.

**Why unknown amounts score 5, not 0.** News frequently omits the amount, and
Form D amendments sometimes report `0`. Treating unknown as zero would
systematically bury exactly the non-US press-only companies that Form D misses.

### Tuning the prefilter

Only two failure modes matter:

- **Something good never reached the LLM.** This is the expensive failure. Run
  `pnpm sf show <id>` to see its `prefilter.breakdown` and `notes`, find which
  signal zeroed it, and loosen that one.
- **The shortlist is full of obvious junk.** Cheap failure — it costs LLM calls,
  not opportunities. Usually means a new anti-theme or a new fund-name pattern in
  `edgar.ts`.

Do not tune the prefilter to "be accurate." It cannot be — it has never seen what
a company does. Tune it to stop losing good companies.

---

## The LLM score

The rubric lives in `rubric()` in `src/pipeline/score.ts`. It is the most
important prompt in the codebase.

### The bands

| Range | Meaning |
|---|---|
| 85–100 | Rare. Strong theme match *and* clear evidence of a substantial technical company. |
| 70–84 | Strong match, credible evidence. Worth a serious look. |
| 50–69 | Plausible but thin evidence, or a mid-weight theme. |
| 30–49 | Weak or uncertain. |
| 0–29 | Clear mismatch, anti-theme, or not an operating tech company at all. |

Bands are anchored with prose descriptions rather than numbers alone, because
numeric-only rubrics drift badly between runs.

### The rules that keep it honest

Four instructions in the prompt do the real work:

1. **No web access at this tier, and the model is told so.** It is explicitly
   instructed to answer "Unknown — name suggests X but there is no evidence" and
   set `confidence: low` rather than invent a product description.
2. **Low confidence ≠ low score.** These are orthogonal, and conflating them
   would bury every company whose name is uninformative — which is most of them.
   A promising name with a solid raise can score 68 at low confidence.
3. **Non-startups score under 20 with a stated reason.** Holding companies and
   local businesses do slip past the EDGAR filters; this is the second net.
4. **Theme weights from the profile are respected explicitly.** An exact hit on a
   1.0-weight theme must outscore a loose hit on a 0.4-weight one.

### Observed distribution

From the reference run (120 companies scored):

```
80s:  1    70s:  6    60s: 11    50s:  7    40s: 12
30s: 22    20s: 23    10s: 16     0s: 22
confidence:  high 19  ·  medium 47  ·  low 54
```

That shape is healthy. The long left tail means the model is willing to say "no",
and the ~45% low-confidence share honestly reflects how little a Form D reveals.
**If you change the rubric and the distribution bunches up in the 50s–70s, or
low-confidence share collapses, the model has started guessing.** That is a
regression even if the top of the list looks fine.

---

## Research

`src/pipeline/research.ts` produces dossiers for the top ~15 and does not score.
Its prompt is built around one instruction:

> If you cannot confidently identify the company, say exactly that. An empty
> dossier is a useful result; a fabricated one is actively harmful.

It explicitly warns that company names are ambiguous and that search results may
describe a *different* company with a similar name — the single most likely way
this stage produces confident nonsense.

---

## Changing what "good" means

In order of preference:

1. **`config/profile.yaml`** — themes and weights, anti-themes, round-size window,
   geography, and the free-text `about` and `notes` fed verbatim to the model.
   This handles the large majority of "why is this here?" moments.
2. **The rubric** in `score.ts`, if the bands themselves are miscalibrated.
3. **Prefilter weights**, only if good companies are being lost before the LLM.
4. **Code**, last.

After editing the profile:

```bash
pnpm sf score --limit 200 && pnpm sf report
```

Re-scoring is light (~$1-equiv) and research is cached, so iterating on taste
barely touches your rate limit.

## Evaluating a change

There is no automated eval yet — see [ROADMAP.md](ROADMAP.md), where it is the
top-ranked item. Until there is, the honest procedure is:

1. Note the current top 20 and the score distribution.
2. Make the change; re-score.
3. Compare. Ask specifically: *did anything good fall out of the top 20?* Ranking
   changes are easy to see; silent losses are not.

Bear in mind that LLM responses are cached by prompt hash, so a prompt edit
invalidates the cache and a full re-score consumes plan capacity again.
