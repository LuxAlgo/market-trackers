# Source: USAspending (`usaspending`)

**Datasets:** `gov-contracts`
**Status:** scaffolded — ingestor to build (`sources/usaspending/source.ts`)
**Auth:** none; free JSON API.

## Access pattern (verify payload shape live)

- `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` with a JSON body:
  `filters.time_period` (`action_date` range from the watermark), `filters.award_type_codes`
  (contracts: `A`, `B`, `C`, `D`), requested `fields` (award id, recipient name/UEI, awarding
  agency/sub-agency, obligated amount, action date, description, NAICS), `page`/`limit`
  pagination, sorted by action date.
- Natural key: `generated_internal_id`. Paginate until exhausted; watermark on action date
  (`usaspending.lastActionDate`).
- Be polite: modest rate limit (the API is free but shared), backoff on 5xx.

## Recipient→ticker mapping

- Curated map shipped as data: `packages/core/data/recipient-tickers.json` — UEI and normalized
  recipient name → tickers[], seeded with the obvious public primes (LMT, RTX, BA, NOC, GD,
  LHX, LDOS, HII, BAH, SAIC, CACI, PLTR, KBR, TDY, …) and their major subsidiaries.
- Matching: exact UEI first, then normalized-name match via `resolve/normalize.ts`.
- **Unmatched recipients are still stored** with `tickers: []` — resolution improves over time
  without re-ingesting; the map itself is versioned data worth publishing.

## Canary

API probe (count endpoint or a 1-row search) succeeds (hard) · new awards within 96h (soft) ·
response-shape fingerprint: hash of the sorted field names of a result row (hard).

## Fixtures to build

A captured `spending_by_award` response page (JSON) with expected normalized awards, including
an unmatched recipient and a multi-ticker parent match.
