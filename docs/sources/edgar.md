# Source: SEC EDGAR (`edgar`)

**Datasets:** `insider-transactions` (Forms 3/4/5), `thirteenf-holdings` (13F-HR)
**Status:** implemented
**Auth:** none. SEC fair access requires ≤ 10 req/s and a User-Agent declaring a contact —
both enforced in `sources/edgar/client.ts` (strict sliding-window limiter + mandatory UA).
Violations earn ~10-minute IP blocks; the client backs off automatically on 403/429.

## Endpoints

| What                                | URL                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Company↔ticker↔CIK map              | `https://www.sec.gov/files/company_tickers.json`                                                            |
| Daily master index                  | `https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/master.{YYYYMMDD}.idx`                        |
| Full submission                     | `https://www.sec.gov/Archives/` + index row path (`….txt`)                                                  |
| Filing index page (provenance link) | same path with `.txt` → `-index.htm`                                                                        |
| Per-company submissions JSON        | `https://data.sec.gov/submissions/CIK##########.json` (10-digit zero-padded)                                |
| Bulk backfill                       | nightly `submissions.zip` / `companyfacts.zip` bulk files — verify current paths on data.sec.gov before use |

## How ingestion works

1. Walk `master.{date}.idx` from the watermark (`daily-index.lastCompletedDay`) to today.
   Weekends skipped; holidays 404 and are marked done; **today is ingested but the watermark
   only advances through yesterday** (the index grows during the day; natural-key upserts make
   the re-walk free).
2. For each ownership/13F row: fetch the full-submission `.txt` (one request per filing), parse
   the embedded `<XML>` primary document, upsert.
3. Ticker recovery: filings sometimes blank `issuerTradingSymbol`; resolve via the cached
   `company_tickers.json` map (refreshed weekly **via conditional GET** — stored
   ETag/Last-Modified validators are replayed and a 304 just bumps the cache's freshness
   instead of re-downloading ~1MB of JSON). 13F tickers resolve from the CUSIP cache
   (`resolve/cusip.ts`, OpenFIGI-backed); rows whose CUSIP isn't cached yet stay
   `ticker: null` until `market-trackers resolve cusips` runs.

## CUSIP→ticker resolution (`market-trackers resolve cusips`)

13F filings identify holdings by CUSIP only. The enrichment loop is explicit:

```
market-trackers resolve cusips [--retry-misses] [--limit <n>] [--json]
```

- Collects `SELECT DISTINCT cusip … WHERE ticker IS NULL` from `thirteenf_holdings`, resolves
  through the OpenFIGI mapping API (keyless works at ~25 req/min; a free key via
  `MARKET_TRACKERS_OPENFIGI_KEY` raises limits and batch size), then back-fills tickers onto holding
  rows — never overwriting an already-resolved row.
- Mappings are cached in `cusip_map` (they almost never change), **misses included**, so
  unresolvable CUSIPs aren't re-queried every run. `--retry-misses` asks OpenFIGI again for
  cached misses (new listings become mappable over time); `--limit` caps a run.
- Future syncs pick tickers straight from the warmed cache at ingest time.

## Growing the golden corpus

`scripts/add-fixture.mjs` turns a real filing into a fixture case on a machine with network
access (`--file` works offline): it fetches the full-submission `.txt` (User-Agent from
`MARKET_TRACKERS_CONTACT`, refused without it), derives accession/filedAt from the SEC header, runs the
real parser from `packages/core/dist`, and writes `input.txt` + `expected.json` + `meta.json`
with `"synthetic": false, "verified": false`. A human verifies `expected.json` against the
primary document and flips `verified` — unverified cases are a review queue, not a green light.

## Format notes & quirks

- **Ownership XML wraps leaf values**: `<transactionDate><value>…</value></transactionDate>`.
  Some values are replaced by `<footnoteId/>` — treat as null, never guess (fixture:
  `case-form4-footnote-only-price`).
- **Multi-reporting-owner filings** (joint filings by affiliated funds, GP/LP pairs): rows are
  attributed to the first listed owner and **every row is flagged `needsReview: true`** —
  per-transaction share counts stay correct, the attribution is what needs a human eye.
- **Empty transaction/holding tables are a valid parse** (zero rows, not an error) — e.g. a
  Form 3 with `noSecuritiesOwned=1`.
- **Keep values as strings when parsing XML** — numeric coercion destroys zero-padded CIKs.
- **13F value units changed**: periods ending before 2023-01-01 report value in **thousands**;
  later periods in whole dollars. `parseThirteenf` normalizes; don't undo this (fixture pair:
  `case-13f-2022-thousands-prn` / `case-13f-2026`).
- 13F information tables legitimately repeat a CUSIP (long + put rows, split discretion) — the
  natural key is accession + row index, not accession + CUSIP. Amounts can be PRN (principal)
  rather than SH, and numbers occasionally carry commas.
- Amended filings (4/A, 13F-HR/A, …) parse and store as their own accessions.
- Transaction codes stay raw (P, S, A, M, G, F, C, …); `INSIDER_TRANSACTION_CODES` ships the
  legend.
- **Old-era daily indexes (roughly pre-2011) write Date Filed as bare `YYYYMMDD`**;
  `parseMasterIndex` normalizes to dashed form. Without it every row-producing filing in a
  deep backfill fails the schema's `filedAt` regex (a 2004 shift once parsed 57k filings and
  ingested zero rows).
- **13F informationTable XML exists only from EDGAR's structured-13F rollout in mid-2013**
  (`THIRTEENF_XML_SINCE = 2013-05-01`); earlier 13Fs are typed text tables. The sync skips
  those without fetching — deep backfills would otherwise spend budget downloading multi-MB
  submissions that can only fail parse. Pre-2013 holdings history is a known gap until a
  text-table parser exists.

## Known gaps (owned by follow-up work)

- Footnote text is not extracted (footnote-only values parse as null).
- Amendments are stored as their own accessions; supersede-the-original logic is not yet
  applied at query time.
- Bulk-file backfill path (faster than day-walking for deep history) not yet implemented.
- 13F holdings before mid-2013 (pre-XML text tables) are skipped, not parsed.

## Canary

Fetch last business day's master index (entries > 0) · company↔ticker map endpoint reachable
(hard — ticker recovery breaks silently without it) · parse success ≥ 99% on the last sync ·
header fingerprint unchanged · insider dataset fresh within 72h (soft).

## Division of labor with `edgar-bulk`

The deep insider history (2006 Q1 → the newest published quarter) is ingested by the
`edgar-bulk` source from the SEC's official quarterly insider-transactions data sets —
sharing this walk's row identity, so the two paths dedupe through the natural-key upsert.
This daily-index walk owns 2004–2005 (before the data sets begin) and the live edge the
quarterly files haven't reached yet; its deep backfill is therefore dispatched with
`--to 2005-12-31`. See docs/sources/edgar-bulk.md.
