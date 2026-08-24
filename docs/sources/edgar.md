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
   `company_tickers.json` map (refreshed weekly). 13F tickers resolve from the CUSIP cache
   (`resolve/cusip.ts`, OpenFIGI-backed).

## Format notes & quirks

- **Ownership XML wraps leaf values**: `<transactionDate><value>…</value></transactionDate>`.
  Some values are replaced by `<footnoteId/>` — treat as null, never guess.
- **Keep values as strings when parsing XML** — numeric coercion destroys zero-padded CIKs.
- **13F value units changed**: periods ending before 2023-01-01 report value in **thousands**;
  later periods in whole dollars. `parseThirteenf` normalizes; don't undo this.
- 13F information tables legitimately repeat a CUSIP (long + put rows, split discretion) — the
  natural key is accession + row index, not accession + CUSIP.
- Transaction codes stay raw (P, S, A, M, G, F, C, …); `INSIDER_TRANSACTION_CODES` ships the
  legend.

## Known gaps (owned by follow-up work)

- Multi-reporting-owner filings currently attribute rows to the first listed owner.
- Footnote text is not extracted.
- Amended filings (…/A) are ingested as their own accessions; supersede-the-original logic is
  not yet applied at query time.
- Bulk-file backfill path (faster than day-walking for deep history) not yet implemented.
- Real-document golden fixtures should replace/augment the synthetic bootstrap cases.

## Canary

Fetch last business day's master index (entries > 0) · parse success ≥ 99% on the last sync ·
header fingerprint unchanged · insider dataset fresh within 72h (soft).
