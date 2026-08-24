# Source: House Clerk financial disclosures (`house-clerk`)

**Datasets:** `congress-trades`
**Status:** scaffolded — ingestor to build (`sources/house-clerk/source.ts`)
**Auth:** none.

## Access pattern (verify live before relying on it)

1. Yearly index ZIP: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YYYY}FD.zip`
   containing `{YYYY}FD.xml` (and `.txt`) — one row per filing: name, filing type, state
   district, year, filing date, DocID.
2. Filing type **`P`** rows are Periodic Transaction Reports; per-filing PDFs live under
   `…/public_disc/ptr-pdfs/{YYYY}/{DocID}.pdf`.
3. House PTR PDFs are predominantly **text-layer PDFs with a consistent table layout** —
   layout-aware extraction (text positions, not OCR) at confidence **0.9**, parser id like
   `house-ptr-pdf@1`. True scans (rare) go through the scan-extractor interface at 0.7 +
   `needsReview`.

## Normalization rules

- Row natural key `house:{docId}:{rowIndex}`.
- Same amount-range, ticker-heuristic, and bioguide-resolution rules as Senate eFD
  (`docs/sources/senate-efd.md`) — one `congress-trades` schema, two chambers.
- House PTR tables carry: owner code, asset, transaction type (P/S/E), date, notification date,
  amount range, and an optional cap-gains-over-$200 flag. Keep raw text where classification is
  uncertain.

## Watermark & idempotency

Watermark on filing date within the current year's index (`clerk.lastFiledDate`); the yearly ZIP
re-download is cheap and conditional-GET-able (`fetch_cache` table). Year boundaries: walk both
the old and new year's index in January.

## Canary

Current year's ZIP downloads and its XML parses (hard) · at least one PTR in the last 72h window
(soft) · parse success ≥ 99% · fingerprint of the index XML's column structure and of the PTR
PDF layout signature (hard).

## Fixtures to build

Golden cases for: the index XML, a clean single-page PTR PDF, a multi-page PTR, a PTR with
footnoted/odd rows, and scanned-paper cases with hand-verified output.
