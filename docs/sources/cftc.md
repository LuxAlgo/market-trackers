# Source: CFTC Commitments of Traders (`cftc`)

**Datasets:** `cot-reports`
**Status:** scaffolded — ingestor to build (`sources/cftc/source.ts`)
**Auth:** none for polite use (Socrata; an app token is optional and not required).

## Access pattern (verify live)

- `GET https://publicreporting.cftc.gov/resource/6dca-aqww.json` — the legacy futures-only
  combined dataset (`[verify-live]` the resource id and that "futures only" vs "combined"
  is the intended universe; pick futures-only and document it). Filter with Socrata params:
  `$where=report_date_as_yyyy_mm_dd >= '…'`, `$order=report_date_as_yyyy_mm_dd`,
  `$limit`/`$offset` paging.
- Fields (`[verify-live]` exact names): `market_and_exchange_names`,
  `report_date_as_yyyy_mm_dd`, `cftc_contract_market_code`, `open_interest_all`,
  `comm_positions_long_all`, `comm_positions_short_all`, `noncomm_positions_long_all`,
  `noncomm_positions_short_all`, `nonrept_positions_long_all`, `nonrept_positions_short_all`.
  Values arrive as strings — parse to numbers; a malformed row is a parse failure, never a
  zero.
- Reports publish weekly (Friday afternoons, for Tuesday data); freshness window 10 days.
- Watermark `cot.lastReportDate` (minus one report-week re-walk).

## Normalization

- Natural key `${reportDate}:${contractCode}`; market name verbatim.
- Published position numbers only — net positioning arithmetic is the consumer's.
- Provenance sourceUrl: the Socrata resource query for that report date (a reproducible
  primary link). Parser id `cftc-cot-legacy@1`, confidence 1.

## Canary

Probe succeeds (hard) · row field-name fingerprint (hard) · parse rate ≥ 99% (hard) · a
report within the 10-day window (soft).

## Fixtures to build

A captured response page (format-faithful synthetic) with expected rows across two report
dates, including a string-number edge ("1,234" vs "1234" — verify which the API emits) and a
malformed row pinning parse-stat accounting.
