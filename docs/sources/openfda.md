# Source: openFDA Drugs@FDA (`openfda`)

**Datasets:** `fda-approvals`
**Status:** scaffolded — ingestor to build (`sources/openfda/source.ts`)
**Auth:** none required; an optional free key (config `openfdaApiKey` / `DOCKET_OPENFDA_KEY`)
raises rate limits, sent as the `api_key` query parameter. `[verify-live]` current
anonymous vs keyed limits (documented historically as 240/min/IP keyless, higher keyed).

## Access pattern (verify live)

- `GET https://api.fda.gov/drug/drugsfda.json` with a `search` on
  `submissions.submission_status_date:[YYYYMMDD TO YYYYMMDD]` since the watermark
  (`openfda.lastStatusDate`, minus a re-walk), paged via `limit` (≤ 100) + `skip`
  (`[verify-live]` the skip ceiling; if the window's results exceed it, narrow the date
  window and continue).
- Results are applications: `application_number`, `sponsor_name`, optional
  `openfda.brand_name[]`, and `submissions[]` each carrying `submission_type`,
  `submission_number`, `submission_status`, `submission_status_date`.

## Normalization

- One row per application **submission event** whose status date falls in the window —
  natural key `${applicationNumber}:${submissionType}:${submissionNumber}`.
- Status codes stay raw (`AP`, `TA`, …); dates normalize YYYYMMDD → YYYY-MM-DD.
- `brandName` = first `openfda.brand_name` when present.
- Sponsor→ticker via the curated map; unmatched sponsors keep `tickers: []`.
- Provenance sourceUrl: the Drugs@FDA application page
  (`https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=…`)
  or, if its stability is in doubt, the openFDA query URL — pick one, document it. Parser id
  `openfda-drugsfda@1`, confidence 1.
- **Non-goal guard:** recorded regulatory events only — no pending-decision calendar is
  synthesized.

## Canary

Probe succeeds (hard; key attached when configured) · result-row field fingerprint (hard) ·
parse rate ≥ 99% (hard) · freshness within 12 days (soft — Drugs@FDA refreshes on a lag).

## Fixtures to build

A captured response (format-faithful synthetic) with expected rows: an original approval, a
supplement, a multi-brand application, and an application with a submission missing its
status (skipped or nulled per schema, never guessed).
