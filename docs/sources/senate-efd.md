# Source: Senate eFD (`senate-efd`)

**Datasets:** `congress-trades`
**Status:** implemented
**Auth:** none, but search only answers a session that has accepted the ethics-act
prohibition agreement — a cookie-based handshake performed once per client
(`sources/senate-efd/client.ts`).

## Endpoints

| What                                | URL                                                          |
| ----------------------------------- | ------------------------------------------------------------ |
| Search home (csrf + agreement form) | `GET/POST https://efdsearch.senate.gov/search/home/`         |
| Search grid (DataTables JSON)       | `POST https://efdsearch.senate.gov/search/report/data/`      |
| Web-table PTR                       | `GET https://efdsearch.senate.gov/search/view/ptr/{uuid}/`   |
| Scanned paper PTR                   | `GET https://efdsearch.senate.gov/search/view/paper/{uuid}/` |

`efdsearch.senate.gov` is unreachable from this build's network policy, so nothing above has
been exercised against the live site — see **`[verify-live]`** below. Everything is proven
against fixtures (`fixtures/senate-efd/`) and a mocked handshake instead.

## How ingestion works

1. Refresh the cached member map if stale (`resolve/members.ts`, weekly) so filed names resolve
   to bioguide IDs.
2. `GET` the search home to collect the `csrftoken` cookie, then `POST` the same URL with
   `prohibition_agreement=1` + `csrfmiddlewaretoken` to earn the session cookie. The 3xx hop is
   followed **manually** (`lib/http.ts`'s new `redirect: "manual"` option) — auto-following would
   discard the hop's `Set-Cookie` header. Done once per client instance.
3. Page `POST /search/report/data/` (report type filtered to Periodic Transaction Reports,
   ordered by filed date ascending) from `filedAfter` — the stored watermark
   (`efd.lastFiledDate`) minus a 7-day re-walk to catch late postings, or `--since`/`--full`/the
   configured backfill window. Pages dedupe by filing UUID and sort by filed date before
   processing.
4. **Web-table PTRs** (`docType: "ptr"`): fetch the view page and parse the transactions table
   directly (`ptr-html.ts`, parser id `efd-ptr-html@1`, confidence 0.9).
5. **Scanned paper PTRs** (`docType: "paper"`): routed through the pluggable extractor seam in
   `scan-extract.ts`. Every extracted row must carry confidence 0.7 and `needsReview: true` — the
   source validates that contract before upserting and treats a violation as a parse failure.
   With no extractor registered, the filing is counted and reported as pending in the sync
   result's notes, never fabricated.
6. Member identity resolves via `matchMember(members, filedName, "senate")`; no or ambiguous
   match leaves `bioguideId`/`party`/`state` null rather than guessing.
7. Rows upsert into `congress-trades` by natural key (`senate:{docId}:{rowIndex}`). The watermark
   advances only through filed dates whose every filing that run actually processed, so a
   `--limit` stop never skips the remainder of a day.

## Format notes & quirks

- Amounts stay ranges (`lib/amount-ranges.ts`) — bounds only, never a midpoint. Range text the
  parser doesn't recognize (free text, an inverted range, etc.) keeps its verbatim form with
  `{ min: 0, max: null }` and `needsReview: true` rather than a guess.
- The ticker column is heuristic and frequently blank or `--`; both map to `ticker: null`.
- Both `filedAt` (disclosure date) and `transactedAt` (trade date) are tracked separately.
- Amendments file under a fresh UUID rather than updating the original — the 7-day re-walk plus
  natural-key upserts pick them up without special-casing.
- Politeness: a shared rate limiter caps the client at 2 requests/second plus a declared alt-data
  User-Agent on every request, in the same spirit as the EDGAR and FINRA clients.

## Canary

- **Agreement + search probe** (hard) — the handshake and a grid page must both succeed.
- **Structural fingerprint** (hard) — a hash of the search grid's column shape plus the PTR
  table's header row. First run records a baseline via `store.get/setFingerprint`; every run
  after compares against it, so format drift goes red before it can silently misparse.
- **Parse success rate ≥ 99%** (hard) — computed from the last recorded sync run
  (`store.latestSyncRun`), not the canary probe itself.
- **PTR freshness within 72h** (soft) — latest filed date seen in the probe window; quiet days
  are expected and only turn this amber.

## Fixtures

`fixtures/senate-efd/` holds a search-grid response (two web-table rows and one paper row) and
three golden web-table PTR cases: a clean multi-row filing (purchase/full-sale/partial-sale,
self/spouse/joint owners, a linked ticker and a `--` ticker), an edge-range filing (the
open-ended `"Over $50,000,000"` top bucket, the `"None (or less than $1,001)"` sub-threshold
bucket, and an Exchange transaction), and a junk-asset filing (free-text and inverted-range
amount cells exercising the unknown-bounds + `needsReview` convention). All are format-faithful
synthetic documents (`meta.json`: `"synthetic": true`), per `fixtures/README.md`.

## Known gaps

- No scan extractor ships for paper PTRs; those filings are enumerated and reported pending, and
  the honesty contract (confidence 0.7, `needsReview: true`) is enforced on whatever extractor a
  future integration registers.
- Ticker extraction is heuristic only — no CUSIP or company-name cross-reference.
- Fixtures are synthetic; real primary-source cases (particularly hand-verified scanned-paper
  PTRs once an extractor exists to check them against) should replace/augment them, per
  `fixtures/README.md`.

## `[verify-live]` — assumptions to confirm against the live site

Network access to `efdsearch.senate.gov` was unavailable while building this ingestor. The
points below are inferred from the public eFD search UI (its DataTables grid and agreement form)
rather than observed directly, and should be confirmed before depending on this in production:

- `[verify-live]` The agreement is accepted by `POST`-ing back to `/search/home/` itself (not a
  separate endpoint), and a successful acceptance responds with a 302 to `/search/`. Confirm both
  the URL and the redirect target are still current.
- `[verify-live]` The search grid endpoint (`POST /search/report/data/`) and its field names —
  `report_types`, `filer_types`, `submitted_start_date`/`submitted_end_date`
  (`MM/DD/YYYY HH:MM:SS`), `candidate_state`, `senator_state`, `office_id`, `first_name`,
  `last_name`, and the DataTables `order[0][column]`/`order[0][dir]` pair. Confirm the field set
  and that column `4` is still the filed-date column used for ordering.
- `[verify-live]` The Periodic Transaction Report filter value `report_types=[11]` — this ordinal
  is read off the search page's report-type checkboxes and could change if the site reorders
  them.
- `[verify-live]` The JSON response shape `{ data: string[][], recordsTotal }` with each row laid
  out as `[firstName, lastName, office, reportLinkHtml, filedDate]`, and that the report link
  still embeds `/search/view/(ptr|paper)/{uuid}/`.
- `[verify-live]` CSRF handling: cookie name `csrftoken`, form field `csrfmiddlewaretoken`
  (mirrored in the home page's form and preferred over the cookie value), and header
  `X-CSRFToken` on the JSON `POST` — standard Django conventions, but unconfirmed against the
  live deployment.
- `[verify-live]` The web-table PTR transactions table is located by a header row containing
  "Transaction Date" and "Amount" (case-insensitively), with further columns named "Owner",
  "Ticker", "Asset Name" (or "Asset"), "Asset Type", and "Type"/"Transaction Type". The
  structural-fingerprint canary will flag a header change, but confirm the current wording once
  live.
- `[verify-live]` Transaction "Type" cell values are assumed to start with "Purchase", "Sale", or
  "Exchange" (case-insensitively) with nothing else in current use.
