# Source: Senate LDA (`lda`)

**Datasets:** `lobbying-filings`
**Status:** scaffolded — ingestor to build (`sources/lda/source.ts`)
**Auth:** none required; registering a **free** API key raises rate limits (config
`ldaApiKey` / `DOCKET_LDA_KEY`). Verify current anonymous vs keyed limits live.

## Access pattern

- `GET https://lda.senate.gov/api/v1/filings/` — paginated REST, filter by `filing_year` and
  walk pages ordered by posted date since the watermark (`lda.lastPostedDate`).
- Natural key: `filing_uuid`.
- Fields to normalize: registrant name, client name, income/expenses (null when unreported —
  keep null, don't zero it), filing year, filing period (keep the API's raw period codes),
  filing type, lobbying activity general issue codes.

## Client→ticker mapping

Same curated-map approach as contracts (`docs/sources/usaspending.md`), same
`resolve/normalize.ts` name normalization, same rule: unmatched clients stored with
`tickers: []`.

## Canary

API probe succeeds (hard; send the key if configured) · new filings within the quarterly-cadence
window (soft — lobbying discloses quarterly, so the window is long) · response-shape fingerprint
of a result row's field names (hard).

## Fixtures to build

A captured filings-list response page with expected normalized filings, including a no-amount
filing and a multi-issue filing.
