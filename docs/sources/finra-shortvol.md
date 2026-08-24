# Source: FINRA Reg SHO daily short-sale volume (`finra`)

**Datasets:** `short-volume`
**Status:** implemented
**Auth:** none.

## Endpoints

- Daily files: `https://cdn.finra.org/equity/regsho/daily/{MARKET}shvol{YYYYMMDD}.txt`
  (pipe-delimited: `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market`).
- Default market file: `CNMS` (consolidated); other market files (e.g. `FNYX`, `FNSQ`) are
  config (`finraMarkets`).
- Optional: FINRA Query API at developer.finra.org (free key) for bulk history — not needed for
  the daily path.

## Format notes

- **Two volume eras**: integer volumes historically; decimal volumes effective 2026-02-23.
  `parseShortVolumeFile` accepts both so backfills normalize identically.
- The `Market` column inside CNMS rows lists reporting venues (`B,Q,N`); Docket's `market`
  field is the **file's** market code (part of the natural key `date:ticker:market`).
- `shortRatio` = shortVolume / totalVolume (null when total is 0). Descriptive arithmetic; this
  is daily reported short-sale volume, **not** short interest — the MCP tool says so in its
  data notes.

## Ingestion

Watermark per market (`shortvol.{MARKET}.lastDay`). Day-walk from the watermark; weekends
skipped; 404 on a past day = holiday (mark done); 404 today = not yet published (retry next
run). Files publish evenings US-time.

## Canary

Latest business-day file fetches (walk back ≤ 6 days) and parses with ≥ 99% success (hard) ·
header-line fingerprint unchanged (hard) · dataset fresh within 96h (soft).

## Known gaps

- Per-exchange market files beyond CNMS are supported by config but not exercised by fixtures
  yet.
- Deep backfill via the Query API not implemented.
