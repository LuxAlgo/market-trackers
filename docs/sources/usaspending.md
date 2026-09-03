# Source: USAspending (`usaspending`)

**Datasets:** `gov-contracts`, `gov-grants`
**Status:** implemented (`sources/usaspending/source.ts`)
**Auth:** none; free JSON API.

## Access pattern (verify payload shape live)

- `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` with a JSON body:
  `filters.time_period` (a signing-date window, `date_type: "new_awards_only"`, from the
  watermark), `filters.award_type_codes`, requested `fields` (award id, recipient name/UEI,
  awarding agency/sub-agency, obligated amount, `Base Obligation Date`, `Start Date`,
  description, NAICS), sorted ascending on `Base Obligation Date`, paged with
  `last_record_unique_id` / `last_record_sort_value` (search_after). See "Walk semantics".
- **One endpoint, two award universes** — only `award_type_codes` differs:
  - Contracts: `A`, `B`, `C`, `D` (BPA calls, purchase orders, delivery orders, definitive
    contracts) → `gov-contracts`, unchanged from before this dataset existed.
  - Grants: `02`, `03`, `04`, `05` — **[verify-live]**, documented as Block Grant, Formula
    Grant, Project Grant, and Cooperative Agreement respectively → `gov-grants`. Confirm these
    against USAspending's live award-type reference; the canary's per-universe fingerprint (see
    below) fails loudly if the result-row shape for either universe drifts.
- Natural key: `generated_internal_id`, shared across both universes (no collision risk — an
  award is either a contract or a grant, never both). Paginate until exhausted per universe.
- Two **independent** watermarks (newest signing date of a completed walk; the key names
  predate the switch from action dates), so one universe lagging or drifting never masks the
  other:
  - `usaspending.lastActionDate` — contracts.
  - `usaspending.grants.lastActionDate` — grants.
- `SyncOptions.datasets` restricts to one universe (`["gov-contracts"]` or `["gov-grants"]`);
  omitted, both run in one `sync()` call, contracts first. `SyncOptions.until` bounds either
  universe's walk to a fixed end date instead of today — this is what the backfill engine
  (`market-trackers backfill`, see [`../backfill.md`](../backfill.md)) chunks through history with.
  `SyncOptions.limit` is a **shared** budget across both universes in one run (matching its
  "soft cap on documents fetched this run" documentation): contracts spends from it first, and
  grants only gets what's left — a run with `--limit 50` never fetches 50 contracts _and_ 50
  grants.
- Be polite: modest rate limit (the API is free but shared), backoff on 5xx.

## Walk semantics

The window and the sort key agree, and they have to. The server evaluates a bare
`time_period` asymmetrically — `start_date` against the award's latest action date, `end_date`
against its signing date — so every long-running award with any activity after the window
start matches every window, and a walk sorted on a date keeps returning the same oldest awards
for each one. Observed live: a multi-year backfill that upserted ~20k rows per 30-day chunk
and still held fewer than 20k distinct awards, with event years back to 1949, and a live
watermark that had climbed to 2027 (period-of-performance start dates run years ahead), which
pinned the daily window to an empty `[today, today]`.

- **Window:** `date_type: "new_awards_only"` — only awards whose base transaction was signed
  inside `[start_date, end_date]`. Each award falls in exactly one window.
- **Sort and date:** `Base Obligation Date` (the signing date, `date_signed` server-side),
  ascending. It is also the row's `actionDate`; a record with no signing date falls back to its
  `Start Date`.
- **Paging:** every response's `page_metadata.last_record_unique_id` /
  `last_record_sort_value` is echoed on the next request, which switches the server to
  search_after paging with no result-window cap. Live, the cursor request has answered 503
  for this sort field, so a cursor request that fails is retried once by page number and the
  walk stays on page numbers from then on; those answer 422 past the result window
  (`ES_AWARDS_MAX_RESULT_WINDOW`, 50k rows), which the walk reports as an early stop with
  the day it reached, and the backfill engine resumes from that day. Keep backfill chunks
  small enough (7 days) that a window rarely reaches the cap.
- **Resume point:** rows arrive sorted on the signing date, so when a walk stops early (time
  budget, `--limit`, or the API giving out after the polite fetch's retries) every award signed
  strictly before the newest stored date is in the store; the sync reports `stoppedEarly` and
  `completedThrough` = that date minus one day, and the backfill engine resumes there.
- **Watermark:** advanced only by a completed walk, only forward, and never past the walked
  window's end. A stored watermark later than today is treated as today and rewritten by the
  next completed walk.

## Why one parser for both universes

Grants and contracts are normalized by the exact same function
(`normalizeAwardRow`) into the exact same shape (`GovContractAward` — `gov-grants`'s schema is
a type alias of it, see `schema/datasets.ts`), so both carry `parser: "usaspending-awards@1"`.
There's no behavior difference to version separately: a contracts-shaped row and a
grants-shaped row hit identical field mapping, identical null handling, identical
recipient→ticker resolution. If a future change makes grant rows need genuinely different
normalization (a grants-only field worth capturing, say), that's the point to fork a
`usaspending-grants@1` parser id — not before.

## Recipient→ticker mapping

- Curated map shipped as data: `packages/core/data/recipient-tickers.json` — UEI and normalized
  recipient name → tickers[], seeded with the obvious public primes (LMT, RTX, BA, NOC, GD,
  LHX, LDOS, HII, BAH, SAIC, CACI, PLTR, KBR, TDY, …), major defense/IT subsidiaries, and a
  handful of pharma/health primes (PFE, MRNA, JNJ, …) that also show up as HHS/NIH/BARDA grant
  recipients.
- Matching: exact UEI first, then normalized-name match via `resolve/normalize.ts`.
- **Unmatched recipients are still stored** with `tickers: []` — resolution improves over time
  without re-ingesting; the map itself is versioned data worth publishing.
- Grant recipients skew toward universities, hospitals, and other nonprofits that have no
  ticker to map to in the first place — an unmapped `gov-grants` row is very often _correctly_
  unmapped, not a gap in the curated map. Candidates worth adding if seen recurring in real
  data: public biotech/pharma grantees not yet listed (e.g. Regeneron/REGN, Gilead/GILD,
  Illumina/ILMN) and public national-lab-adjacent contractors (most — Battelle, MITRE, Bechtel
  — are themselves nonprofit or private and have no ticker to add).

## Canary

Runs once per award universe, independently:

- Probe (a 1-row search over the trailing 30 days) succeeds — hard. `probe-award-search`
  (contracts) / `probe-grant-search` (grants).
- Response-shape fingerprint: hash of the sorted field names of a probe result row — hard.
  `fingerprint` (contracts) / `fingerprint-grants` (grants), stored under
  `usaspending.award-row-fields` / `usaspending.grants.award-row-fields`.
- Parse-success rate over the probe rows ≥ 99% — hard. `parse-success-rate` /
  `parse-success-rate-grants`.
- Freshness (new rows within the dataset's freshness window) — soft. `freshness-gov-contracts`
  / `freshness-gov-grants`.

## Fixtures

Two independent fixture cases in `packages/core/fixtures/usaspending/`, each a captured
(synthetic, format-faithful) `spending_by_award` response pair with hand-verified expected
output:

- `case-award-search/` — contracts. A curated-map exact match (Lockheed Martin → LMT), a
  word-boundary prefix match (Pratt & Whitney Military Engines → RTX), an unmapped recipient,
  and a null-amount + null-description row.
- `case-grant-search/` — grants. A curated-map exact match (Pfizer Inc → PFE), an unmapped
  university recipient, and a word-boundary prefix match (Modernatx Biodefense Division →
  MRNA) that doubles as the null-amount + null-description row. NAICS fields are null
  throughout — grant awards generally don't carry one.

The test suite's mock dispatches on the request body's `award_type_codes` to route to whichever
case applies, so both universes are exercised end-to-end (paging, normalization, ticker
resolution, watermark/fingerprint independence, the dataset filter, and `--until`) without any
network access.

## Ticker resolution

Recipient names resolve through a two-tier resolver
(`resolveEntityTickersTiered`, `resolve/sec-names.ts`), tried in this order:

1. **Curated map** (`resolveEntityTickers`, see "Recipient→ticker mapping" above) — exact UEI,
   then exact normalized name, then an unambiguous word-boundary prefix. Authoritative: it wins
   whenever it hits, even if the SEC tier below would also match the same name.
2. **SEC issuer-name fallback** (`resolveEntityTickersSec`) — the store's `cik_tickers` table
   (the SEC's own `company_tickers.json`, refreshed by `refreshCikTickersIfStale` during EDGAR
   syncs; on the order of 10k listed issuers) matched by **exact normalized name only**. No
   prefix, no fuzzy: SEC titles are issuer names, and USAspending recipients are frequently
   subsidiaries or DBAs ("APPLE OPERATIONS INTERNATIONAL"), which must never inherit a parent
   issuer's ticker just because a prefix lines up. A normalized name shared by more than one CIK
   is excluded from the SEC index as ambiguous; one issuer's several share classes (e.g.
   GOOGL/GOOG) all come through.

A miss at both tiers still stores the row, with `tickers: []` — a wrong ticker is worse than no
ticker, and resolution is meant to improve over time (curated-map growth, the SEC's own ticker
file refreshing) without re-ingesting anything.
