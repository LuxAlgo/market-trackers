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
- The `Market` column inside CNMS rows lists reporting venues (`B,Q,N`); LuxAlgo Alt Data's `market`
  field is the **file's** market code (part of the natural key `date:ticker:market`).
- `shortRatio` = shortVolume / totalVolume (null when total is 0). Descriptive arithmetic; this
  is daily reported short-sale volume, **not** short interest — the MCP tool says so in its
  data notes.

## Ingestion

Watermark per market (`shortvol.{MARKET}.lastDay`). Day-walk from the watermark; weekends
skipped; 404 or 403 on a past day = holiday (mark done); 404 or 403 today = not yet published (retry next
run). Files publish evenings US-time.

## Canary

Latest business-day file fetches (walk back ≤ 6 days) and parses with ≥ 99% success (hard) ·
header-line fingerprint unchanged (hard) · dataset fresh within 96h (soft).

## Known gaps

- Per-exchange market files beyond CNMS are supported by config but not exercised by fixtures
  yet.
- Deep backfill via the Query API not implemented.

## The 403-for-missing quirk (verified live)

FINRA's CDN answers **HTTP 403**, not 404, for objects that don't exist — first observed live
on the current day's not-yet-published file (canary run, 2026-08-25). The client therefore
excludes 403 from its retry statuses and the sync/canary treat 403 exactly like 404 ("no such
file"), so an unpublished day is a quiet skip instead of a retry storm followed by a red.
