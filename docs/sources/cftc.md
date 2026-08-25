# Source: CFTC Commitments of Traders (`cftc`)

**Datasets:** `cot-reports`
**Status:** implemented
**Auth:** none for polite use (Socrata; an app token is optional and not required).

## Endpoints

- `GET https://publicreporting.cftc.gov/resource/6dca-aqww.json` — the legacy futures-only
  combined dataset (`[verify-live]` the resource id and that "futures only" vs "combined" is the
  intended universe; futures-only was picked and is what this ingestor walks). Filtered with
  Socrata (SODA) params: `$where` on `report_date_as_yyyy_mm_dd` bounded both below (the
  watermark, minus a re-walk) and above (`--until`, defaulting to today), `$order` ascending on
  the same field, `$limit`/`$offset` paging.
- Fields (`[verify-live]` exact names): `market_and_exchange_names`,
  `report_date_as_yyyy_mm_dd`, `cftc_contract_market_code`, `open_interest_all`,
  `comm_positions_long_all`, `comm_positions_short_all`, `noncomm_positions_long_all`,
  `noncomm_positions_short_all`, `nonrept_positions_long_all`, `nonrept_positions_short_all`.
  Numeric fields arrive as strings; a missing, blank, non-numeric, or negative value fails that
  **whole row** — never a zeroed field. `[verify-live]` whether the live API ever emits
  comma-grouped digit strings (e.g. `"1,234"`) alongside plain ones (e.g. `"1234"`); the parser
  (`parseCotCount`) strips commas defensively either way, so this is not a silent-failure risk.
- Reports publish weekly (Friday afternoons, for Tuesday data); freshness window 10 days.

## Ingestion

- Walks a single `[start, end]` report-date window ascending, via `$limit`/`$offset` paging,
  until a short page comes back. `start` is `--since`, or `cot.lastReportDate - 7 days` (one
  report-week — reports occasionally revise after first posting), or `backfillDays` back from
  today with no watermark; `end` is `--until`, defaulting to today. `--full` ignores the
  watermark and re-walks from `backfillDays` back.
- `--limit` counts raw rows fetched (one row is one report-date × contract, so this maps 1:1 to
  output rows attempted).
- Watermark `cot.lastReportDate` advances to the max `reportDate` among succeeded rows, only on a
  completed walk (no HTTP error, `--limit` not hit), and only forward. A `--until`-bounded run
  (used by the backfill engine to run bounded chunks) advances the watermark only up to what that
  bound actually covers.

## Field mapping

- Natural key `${reportDate}:${contractCode}` (`cotReportId`); `marketName` kept verbatim
  (trimmed only — no case-folding).
- `report_date_as_yyyy_mm_dd` arrives as a floating-timestamp string (e.g.
  `"2026-08-05T00:00:00.000"`); the first 10 characters become `reportDate`
  (`YYYY-MM-DD`) after validating the `^\d{4}-\d{2}-\d{2}` prefix.
- The seven position/open-interest fields are **published numbers, verbatim** — this ingestor
  computes no net positioning or any other derived figure; that arithmetic is left to the reader.
- `provenance.sourceUrl` = a reproducible Socrata query for every row published on that report
  date (`cotReportDateQueryUrl`, `$where=report_date_as_yyyy_mm_dd = '<date>T00:00:00'`) — a
  per-page, offset-bearing URL would not reproduce the same result once newer data shifts the
  paging, so provenance is keyed on the report date instead. `parser: "cftc-cot-legacy@1"`,
  `confidence: 1`.

## Canary

Probe succeeds (hard) · response-shape fingerprint: hash of a result row's sorted field names
(hard — this is what catches the field-name drift called out below) · parse success ≥ 99% on the
probe rows (hard) · a report within the 10-day freshness window (soft).

## Fixtures

`fixtures/cftc/case-legacy-futures-page/` — a synthetic, format-faithful Socrata page spanning
two report dates one week apart: a plain-digit-string row (Crude Oil), a comma-grouped-digit
row on the same date (Natural Gas — the string-number edge case), a normal row on the newer date
(Gold), and a malformed row on the newer date (Silver, non-numeric `open_interest_all`) that
fails as a whole row rather than being zeroed.

## `[verify-live]`

Built and tested fully offline against the fixture above — this environment cannot reach
`publicreporting.cftc.gov`. Confirm the following against the live API before depending on it in
production; the fingerprint canary above goes red the moment the result-row shape drifts, rather
than misparsing silently:

- **Resource id and universe.** Assumed `6dca-aqww` is the legacy **futures-only** combined
  report (as opposed to "futures-and-options combined", which is a different Socrata resource).
  Confirm the id still resolves to that exact dataset on `publicreporting.cftc.gov`.
- **Field names.** `market_and_exchange_names`, `report_date_as_yyyy_mm_dd`,
  `cftc_contract_market_code`, `open_interest_all`, `comm_positions_long_all`,
  `comm_positions_short_all`, `noncomm_positions_long_all`, `noncomm_positions_short_all`,
  `nonrept_positions_long_all`, `nonrept_positions_short_all`. The canary's row fingerprint
  hashes the probe row's sorted field names, so any live rename, addition, or removal turns it
  red.
- **`$where` floating-timestamp literal form.** Assumed `field >= '<date>T00:00:00'` /
  `field <= '<date>T00:00:00'` is accepted syntax for this column's type; Socrata SoQL is
  generally tolerant of bare-date literals too, but the explicit midnight timestamp is used to
  be unambiguous.
- **Numeric string formatting.** Assumed the live API emits plain digit strings (e.g. `"1234"`),
  not comma-grouped ones — `parseCotCount` accepts both, so a wrong assumption here degrades
  nothing, it just means the comma-handling branch may be exercised more (or less) than expected
  in production.
- **Page size ceiling.** `COT_PAGE_LIMIT = 1000` is a conservative default; Socrata's own `$limit`
  ceiling is documented as higher, so this only affects how many requests a deep backfill makes,
  not correctness.
