# Source: Senate eFD (`senate-efd`)

**Datasets:** `congress-trades`
**Status:** scaffolded — ingestor to build (`sources/senate-efd/source.ts`)
**Auth:** none, but the site requires accepting an agreement that sets a session cookie before
search works.

## Access pattern (verify live before relying on it — endpoints have moved before)

1. `GET https://efdsearch.senate.gov/search/home/` → collect `csrftoken` cookie.
2. `POST` the agreement acceptance (`prohibition_agreement=1` + CSRF) → session cookie.
3. `POST https://efdsearch.senate.gov/search/report/data/` — a DataTables-style JSON grid
   (`start`, `length`, `report_type` filter for Periodic Transaction Reports, date range) →
   rows of filings with document links.
4. Filings come in two forms:
   - **Web-table PTRs** (`/search/view/ptr/{uuid}/`) — the majority. Parse the HTML table
     directly: transaction #, transaction date, owner, ticker, asset name, asset type,
     buy/sell, amount range, comment. Confidence **0.9**, parser id like `efd-ptr-html@1`.
   - **Scanned paper PTRs** (`/search/view/paper/{uuid}/`) — image scans. These go through the
     pluggable scan-extractor interface; every extracted row carries confidence **0.7** and
     `needsReview: true`. Without an extractor configured, record the filing as pending rather
     than inventing rows.

## Normalization rules

- `docId` = the filing UUID; row natural key `senate:{docId}:{rowIndex}`.
- Amounts parse via `lib/amount-ranges.ts` — bounds only, never midpoints; keep the verbatim
  text in `amountRange.text`. Unparseable range text ⇒ `needsReview: true`, never a guess.
- Ticker extraction is heuristic (eFD has a ticker column that is often `--`); keep the asset
  description verbatim and leave `ticker` null when unresolvable.
- Member identity via `resolve/members.ts` (bioguide); unmatched ⇒ null, never a guess.
- Both dates matter: `transactedAt` (trade) and `filedAt` (disclosure).

## Watermark & idempotency

Watermark on filing date (`efd.lastFiledDate`); re-walking a window is safe — upserts by natural
key. Amendments file as new documents with their own UUIDs.

## Canary

Agreement + search POST succeeds · at least one PTR filed in the last 72h window (soft — quiet
days happen) · parse success ≥ 99% on web-table PTRs · structural fingerprint of the search
response shape and PTR table headers (hard — format drift must go red before silent misparse).

## Fixtures to build

Golden cases for: a clean web-table PTR, a multi-row PTR with exchanges and open-ended top
ranges, a PTR with unparseable asset text, and ≥ 5 scanned-paper PTRs with hand-verified
expected output (the DoD for congress data).
