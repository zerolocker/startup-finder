# Data sources

_What we pull, what it can and cannot tell us, and what to add next._

---

## SEC EDGAR Form D — the spine

**What it is.** Companies raising private capital under Regulation D must file a
Form D with the SEC within 15 days of the first sale in a round. Filings are
public immediately, free, structured as XML, and there is no API key or rate
agreement to sign.

**Why it is the backbone of this app.** It is the only source that is
*comprehensive rather than selective*. Tech press covers what its readers find
interesting; Form D covers everyone who took money. Finding companies before they
are legible to everyone else is the entire premise, and no curated source can
deliver that by construction.

### Endpoints used

| Purpose | URL |
|---|---|
| Daily filing index | `https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/form.{YYYYMMDD}.idx` |
| Filing document | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/primary_doc.xml` |
| Full-text search (unused) | `https://efts.sec.gov/LATEST/search-index?q=...&forms=D` |

The daily index is fixed-width-ish text; we split on runs of 2+ spaces rather than
trusting column offsets, which have shifted historically.

### What a filing gives you

Issuer name, CIK, address, jurisdiction, entity type; the industry group (a coarse
SEC bucket); total offering amount, amount sold, amount remaining; investor count;
date of first sale; and **the list of officers and directors with their roles** —
which is often the most valuable field, since it tells you who is behind the
company when the name tells you nothing.

### What it does NOT give you

This list matters more than the one above:

- **No round label.** "Series A" appears nowhere in a Form D. Any round label in
  this app came from press.
- **No investor names.** Related persons are officers/directors, not funds.
- **No valuation.** It reaches the report only via press, picked up during
  research. When press is silent the app derives a *range* from the raise
  instead — see [ADR-011](DECISIONS.md) and `src/pipeline/valuation.ts`.
- **No description of the business.** The industry group is one of ~40 buckets;
  most tech companies land in `Other Technology`, which tells you almost nothing.
- **No non-US companies.** This is a US securities filing.

### Gotchas that cost real debugging time

- `totalOfferingAmount` can be the literal string **`"Indefinite"`**. Parse
  defensively — coercing it to `0` silently ranks a company as having raised
  nothing. Handled in `asAmount()`.
- **Most filers are not startups.** ~1,575 filings over 10 days reduced to 316
  operating companies. The rest are pooled investment funds, real-estate SPVs, and
  co-investment vehicles. Filtering is done in `isLikelyOperatingStartup()` by
  industry bucket, entity type, and name pattern.
- `totalAmountSold` is what has actually been wired; `totalOfferingAmount` is the
  target. A fresh filing often shows `sold: 0` against a large offering. We prefer
  sold and fall back to offering.
- **Rate limits are enforced by IP ban**, roughly 10 req/s, for about 10 minutes,
  with no warning. `util/http.ts` throttles to ~8/s and caches everything.
- The SEC asks automated clients to send a descriptive `User-Agent` with contact
  info. Set `SF_CONTACT=you@example.com`.
- Weekend and holiday index files return 404. Expected, not an error.
- Form **D/A** amendments are follow-on closes on an existing round; we ingest them
  and merge them into the same company.

### The lookback window

Ingestion walks one daily index per day, backwards from today. With `--days`
omitted the window is derived from the newest `filedDate` already in
`data/filings.jsonl` (plus 2 days of overlap, floored at 7, capped at 90), so
consecutive runs never leave a hole. `autoLookbackDays()` in `edgar.ts` is the
pure function that decides, and it is unit-tested.

The overlap matters: a day whose filings were all filtered out as funds leaves
no trace in `filings.jsonl`, so without it that day would look "already
covered". The cap matters because cost is linear — ~160 filings per day of
window, throttled to ~8/s. A clamped run logs a warning naming the exact number
of uncovered days and the command to backfill them; it never skips silently.

### Filtering heuristics, and their bias

`isLikelyOperatingStartup()` is deliberately biased toward **exclusion**. A false
negative costs one missed company; a false positive wastes an LLM call and puts a
real-estate SPV in the user's digest. Excluded: pooled-investment/real-estate/
extractive industry buckets, `Limited Partnership` entity types, and names matching
fund patterns (`Fund III`, `Co-Invest`, `... Investors, LLC`, `a series of ...`).

If you find it dropping real companies, loosen it **and add a test case** to
`test/edgar.test.ts` — that file already pins both directions.

---

## Funding news RSS — the enrichment layer

**Why it is here.** Form D tells you a company raised; press tells you *what the
company does*, who led the round, and what it's called. News also covers non-US
rounds, which Form D structurally cannot.

**Why it is not the spine.** It is biased toward companies that already have PR,
which is close to the opposite of what this app is for. It enriches; it does not
lead.

### Feeds currently polled

| Slug | Source | Notes |
|---|---|---|
| `techcrunch-venture` | TechCrunch Venture | High volume, US-centric |
| `techcrunch-startups` | TechCrunch Startups | Overlaps the above |
| `crunchbase-news` | Crunchbase News | Good round detail |
| `venturebeat` | VentureBeat | Mixed funding/product coverage |
| `tech-eu` | Tech.eu | Best European coverage |
| `eu-startups` | EU-Startups | European, high volume |
| `sifted` | Sifted | European, analytical |

All verified reachable when added. A feed that starts failing logs a warning and is
skipped — one dead publisher must not fail a run.

**FinSMEs** (`finsmes.com/feed`) returns 403 to both scripted and browser user
agents and is therefore not included, despite being a good funding-only source.

### Headline extraction, and its failure modes

`extractHeadlineFacts()` pulls company, amount, and round from a headline with
regexes. It is a cheap first pass — roughly 70% accurate — and the LLM stages can
correct it. Non-USD amounts are **not** FX-converted; they are used at face value,
which is fine for bucketing and avoids a live currency dependency.

The interesting part is what gets **rejected**. Every one of these produced a bogus
"company" on the first real run, and each now has a regression test:

| Headline | Bad extraction | Now rejected because |
|---|---|---|
| `The Week's 10 Biggest Funding Rounds` | (roundup) | `isRoundup()` |
| `July funding: European startups raised €4B` | "July funding: European startups" | `isRoundup()` |
| `White Star Capital closes $250M Fund IV` | "White Star Capital" | `isFundAnnouncement()` — a VC, not a startup |
| `'A Rare Land-Grab Moment': Menlo Ventures'...` | "'A Rare" | leading quotation mark |
| `Travis Kalanick's robotics company raises $1.7B` | "Travis Kalanick's robotics company" | possessive + generic noun |
| `Repeat founder Ryan Williams raises $10M` | "Repeat founder Ryan Williams" | role noun ⇒ a person |
| `Defense tech Hadrian raises $1.37B` | "Defense tech Hadrian" | descriptor prefix stripped ⇒ "Hadrian" |
| `The browser is where attacks land.` | "The browser is where attacks" | bare-stem verb — inflected forms only |
| `How to build secure … AI` | "How to build" | bare "secure" was an adjective |
| `QMUL spinouts looking to raise` | "QMUL spinouts looking to" | bare "raise"; subject ends in a function word |
| `Edtech platform raises $4.5M` | "Edtech platform" | subject is only category words, no name |

The lesson generalizes: **funding vocabulary is identical for startups raising
rounds, VCs raising funds, and journalists summarizing both.** Any new headline
parsing needs to distinguish the subject, not just detect the keywords.

A second lesson, from the last four rows: **only inflected verbs count.** Every
bare stem in the funding vocabulary is also a common noun or adjective — "attacks
land", "build secure AI", "looking to raise" — so accepting `raise` alongside
`raises` invented three companies out of opinion pieces. A real funding headline
is always "X raises" or "X raised", so requiring inflection costs nothing.

Measured on the 52 items then on disk: 25 companies extracted, 4 of them junk
(16%). After the fix: 21 real companies, 0 junk.

---

## Sources worth adding

Roughly in order of value per unit of work:

**Hiring signals (highest value for the "join" use case).** An open senior
engineering role is a stronger signal than round size for someone evaluating where
to work. Currently discovered only during research — too late to influence
ranking. A source that checks careers pages (or Greenhouse/Lever/Ashby public job
APIs, which are free and structured) would let hiring feed the prefilter.

**Y Combinator / accelerator directories.** Public, structured, and a strong
quality prior. Good for enriching companies we already found.

**Hacker News (Algolia API, free).** "Launch HN" posts and the monthly "Who is
hiring" threads are high-signal and completely uncovered right now.

**Product Hunt API.** Free, shows shipped product — a useful corrective to
companies that raised on a deck.

**GitHub.** For dev-tool companies, repo activity and contributor count are real
traction signals available for free.

**SEC full-text search** (`efts.sec.gov`, already verified working). Would let us
search Form D text directly rather than crawling daily indexes — useful for
backfilling history, which the daily-index approach makes expensive.

**Paid databases** (Crunchbase, PitchBook, Dealroom, Specter). Would fill in
valuations, investor names, and headcount trends — genuinely valuable and
genuinely expensive. Deliberately avoided so far; see
[ADR-001](DECISIONS.md#adr-001-free-public-sources-only).

## A note on coverage honesty

The app should never imply coverage it does not have. Non-US early rounds are
substantially under-covered; a quiet week in the digest may mean a quiet week in
the feeds, not a quiet week in the market. If you add a source that changes the
coverage story, update this file and the "Honest limitations" section of the
README in the same change.
