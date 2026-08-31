# Source: SEC insider transactions data sets (`edgar-bulk`)

**Datasets:** `insider-transactions`
**Auth:** none; SEC's fair-access policy requires a declared contact in the User-Agent
(config `contactEmail` / `MARKET_TRACKERS_CONTACT`), same as the `edgar` source.

## Why this source exists

DERA (the SEC's Division of Economic and Risk Analysis) publishes an official structured
extraction of every Form 3/4/5 filing as one ZIP of TSV tables per calendar quarter, from
2006 Q1 onward. One quarter download replaces a month-by-month walk of the daily indexes —
the 2006→present insider history lands in hours instead of the months the `edgar` ladder
would need at its fair-access request budget.

**Division of labor with `edgar`:** this source owns the deep history (2006 Q1 → the newest
published quarter). The `edgar` daily-index walk owns 2004–2005 (before the data sets begin)
and the live edge the quarterly files haven't reached yet.

## Endpoints

- `GET https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{yyyy}q{q}_form345.zip`
  — one archive per quarter, TSV tables inside: `SUBMISSION.tsv`, `REPORTINGOWNER.tsv`,
  `NONDERIV_TRANS.tsv`, `NONDERIV_HOLDING.tsv`, `DERIV_TRANS.tsv`, `DERIV_HOLDING.tsv`
  (plus footnote/signature tables this source doesn't read).
- A quarter's ZIP publishes with a lag after the quarter ends (assumed ~45 days). A 404 on
  a recent quarter is that lag; a 404 on a quarter more than ~200 days past its end is
  treated as URL/catalog drift and fails the run loudly.

## Row identity — shared with the ownership-XML walk on purpose

Rows carry the same natural key the `edgar` walk assigns: `${accession}:${nd|d}:${index}`,
where each table orders transactions first, then holdings, in document order. The data
sets' surrogate keys (`NONDERIV_TRANS_SK` et al.) stand in for XML document order, so the
same physical transaction gets the same id from either path and overlapping coverage
dedupes through the natural-key upsert. Field mapping mirrors `form-ownership-xml@1`:
first reporting owner attributed with `needsReview: true` on joint filings, `NONE`/`N/A`
tickers null, `I` → indirect ownership, holdings rows with null date/code, per-filing
provenance deep link to `…/Archives/edgar/data/{cik}/{accession}-index.htm`.
Parser id: `form345-dataset@1`.

## Ingestion

- **Backfill** (`until` set — how the engine always calls it): quarters ascending from the
  window's start (never before 2006 Q1), one ZIP per quarter, upserted in batches. Runs as
  a single `[from, to]` chunk (`SINGLE_PASS_SOURCES`); completed quarters bank through
  `completedThrough`, the engine's deadline stops the walk between quarters, and exhausted
  retries stop it as `"upstream"`. Reaching a not-yet-published quarter completes the walk
  by design — each future quarterly release belongs to the daily top-up.
- **Daily top-up** (no `until`): when the newest expected quarter (publication lag applied)
  is beyond the `edgar-bulk.lastQuarter` watermark, ingest it; a cold store takes only the
  newest published quarter, and catch-up after an outage is capped at two quarters — the
  deep walk always belongs to the backfill.
- A run that fetches 100+ rows with zero parsed throws (format-drift tripwire); a required
  column missing from any table throws `BulkFormatError` before a single wrong row lands.

## Canary

HEAD probe of the newest expected quarter's ZIP (one quarter of publication-lag slack,
hard) · dataset freshness (soft — the dataset is shared with the `edgar` daily walk, so
this corroborates rather than proves this source's liveness).

## `[verify-live]`

Built offline; this environment cannot reach `www.sec.gov`. The first CI contact verifies:

- **The ZIP URL pattern and catalog start.** Assumed
  `…/insider-transactions-data-sets/{yyyy}q{q}_form345.zip` from 2006 Q1. If the path
  differs, every quarter 404s and the old-quarter drift check reds the first run
  immediately — fix is one constant.
- **Column names.** Required: SUBMISSION `ACCESSION_NUMBER`, `FILING_DATE`,
  `DOCUMENT_TYPE` (or `FORM_TYPE`), `ISSUERCIK`, `ISSUERNAME`; REPORTINGOWNER
  `ACCESSION_NUMBER`, `RPTOWNERCIK`, `RPTOWNERNAME`; NONDERIV_TRANS `ACCESSION_NUMBER`,
  `NONDERIV_TRANS_SK` (and the DERIV/HOLDING analogues). A miss throws `BulkFormatError`
  naming the table and the columns it actually has. Relationship flags accept either
  boolean columns or a relationship text; absent both they stay false (attribution
  metadata only).
- **Date format.** `DD-MON-YYYY`, `YYYY-MM-DD`, and `YYYYMMDD` all parse; anything else
  counts as a parse failure, never a wrong date.
- **Surrogate keys follow document order.** The id-parity contract above assumes DERA
  assigns `*_SK` in document order within a filing. If that ever proves false for some
  filings, the affected overlap rows duplicate under a second id (data stays correct;
  dedup is a follow-up), and this note is where that investigation starts.
- **TSVs are unquoted.** A quoted field would surface as literal quotes in values.
- **HEAD support** on `/files/` paths for the canary probe.

## Follow-up

The SEC publishes the same style of quarterly data sets for Form 13F (2013 Q2 onward);
this source's quarter machinery is deliberately generic enough to add a
`thirteenf-holdings` sibling walker later.
