# Source: PatentsView (`patentsview`)

**Datasets:** `patents`
**Status:** implemented
**Auth:** free API key required by the provider (config `patentsviewApiKey` /
`ALT_DATA_PATENTSVIEW_KEY`), sent as the `X-Api-Key` header. There is no anonymous tier: `sync`
fails fast with a friendly, actionable error when no key is configured, and the canary reports a
soft skipped-no-key note instead of probing anonymously.

## Endpoint

- `GET https://search.patentsview.org/api/v1/patent/` — the PatentSearch endpoint, queried with a
  single grant-date range (`patent_date` between `since` and `until`) and paged forward via the
  API's cursor-style "after" parameter, sorted ascending by `patent_id`.
- Natural key: `patent_id`.

## Ingestion

- With no watermark (or `--full`) the walk starts `backfillDays` back from today — the same
  default first-sync depth as FINRA/EDGAR. With a watermark it starts a small trailing re-walk,
  `patents.lastGrantDate` minus 3 days: patents occasionally get corrected/republished within the
  same weekly grant batch. The walk runs through `opts.until ?? today`.
- Pages forward with `o.after` set to the previous page's last `patent_id` (ascending sort makes
  this a stable, monotonic cursor). A walk is exhausted once cumulative rows fetched reach the
  response's `total_hits`, falling back to "page shorter than requested" if that field is ever
  absent.
- Watermark `patentsview.lastGrantDate` advances only after a fully completed walk, and only
  forward — the USAspending/LDA pattern.
- `--limit` is a soft cap checked between pages (a page already in flight is always upserted in
  full before stopping, and the watermark is left untouched). `--since`, `--until`, `--full`, and
  `--datasets` behave the same as the other incremental sources.

## Field mapping

- `assignee.name` = the first assignee entry that has an organization name
  (`assignees[].assignee_organization`), skipping any individual (organization-less) entries
  ahead of it. A patent with no assignees at all, or only individual assignees, keeps
  `name: null`. `assigneeCount` is the total number of assignee entries, individuals included.
- `assignee.tickers` resolves through the curated map (`resolve/recipients.ts`), the same map and
  matching rules as USAspending recipients and LDA clients. Unmatched assignees are still stored,
  with `tickers: []`.
- `cpcClass` = the first present `cpc_current[].cpc_class_id`, uppercased; `null` when the patent
  has no CPC classification in the response.
- `kind` = `wipo_kind` verbatim (trimmed); `null` when absent. See `[verify-live]` — this field's
  real semantics need confirming.
- `provenance.sourceUrl` = the USPTO Patent Public Search PDF for the patent (`patentDocumentUrl`)
  — see `[verify-live]`. `parser: "patentsview-api@1"`, `confidence: 1`.

## Canary

Keyed probe succeeds (hard; soft skipped-no-key note when no key is configured, instead of
probing anonymously) · result-row field-name fingerprint (hard) · parse success ≥ 99% on the
probe rows (hard) · new grants within the 12-day freshness window (soft — patents grant weekly,
on Tuesdays, so a couple of quiet days is normal).

## Fixtures

`fixtures/patentsview/case-weekly-grants-2026/` — a synthetic, format-faithful paged pair (page 1
full, page 2 short/final) covering: a mapped assignee by exact name (Microsoft Corporation →
MSFT), an unmapped assignee (Example Innovations Inc.), a fully unassigned patent (empty
`assignees`, name stays null, assigneeCount 0), a multi-assignee patent (first-listed organization
wins the display name — Northrop Grumman → NOC — while `assigneeCount` keeps the total of 2) with
a second CPC entry ignored in favor of the first, and a second mapped assignee by exact name after
legal-suffix stripping (International Business Machines Corporation → IBM).

## `[verify-live]`

Built and tested fully offline against the fixtures above — this environment cannot reach
`search.patentsview.org`. Confirm the following against the live API before depending on it in
production; the fingerprint canary above goes red the moment any of it drifts, rather than
misparsing silently:

- **`q`/`f`/`o`/`s` parameter encoding.** Assumed a GET request with all four JSON-encoded in the
  query string (not a POST body): `q: {"_and":[{"_gte":{"patent_date":since}},{"_lte":{"patent_date":until}}]}`,
  `f: ["patent_id","patent_title","patent_date","wipo_kind","assignees.assignee_organization","cpc_current.cpc_class_id"]`,
  `o: {"size":<=1000[,"after":<cursor>]}`, `s: [{"patent_id":"asc"}]`. This mirrors the classic
  PatentsView Search API's q/f/o/s convention carried into the v1 PatentSearch docs; confirm it
  still holds, and whether very large queries must move to a POST body instead.
- **Pagination cursor.** Assumed `o.after` takes the literal `patent_id` value of the last row on
  the previous page (search-after style, safe because the sort is ascending `patent_id`). Confirm
  the cursor's expected shape and that a stale/malformed one errors cleanly rather than silently
  truncating or repeating results.
- **`total_hits`.** Assumed present on every page and stable across pages of the same query; used
  to know when the walk is complete. The client falls back to "page shorter than requested" when
  it's absent — confirm which of the two actually happens live, so the fallback path gets real
  coverage too.
- **Field names.** `patent_id`, `patent_title`, `patent_date`, `wipo_kind`, `assignees[].assignee_organization`,
  `cpc_current[].cpc_class_id`. In particular, `wipo_kind` is assumed to carry the WIPO ST.16 kind
  code as published (e.g. `"B2"`); if PatentsView instead only exposes a coarser `patent_type`
  (`"utility"`/`"design"`/`"plant"`/…), `kind` should be repointed there, or left `null` if no
  literal kind code is available at all. The canary's row fingerprint hashes the result row's
  sorted top-level field names, so any live rename, addition, or removal turns it red immediately.
- **Auth header.** Assumed `X-Api-Key: <key>` per the provider's key-request documentation.
  Confirm the header name/casing hasn't changed.
- **Rate limit.** Documented ~45 requests/minute with a key; shipped conservatively at
  `{limit: 40, windowMs: 60_000}` — confirm the currently published ceiling.
- **Page size ceiling.** Shipped requesting up to 1000 rows per page — confirm the provider's
  actual maximum `o.size` with a registered key.
- **Provenance URL.** `https://ppubs.uspto.gov/dirsearch-public/print/downloadPdf/{patent_id}` —
  USPTO's Patent Public Search PDF endpoint, chosen over a PatentsView listing page or a Google
  Patents rendering (explicitly not the record). Confirm this path is still current, reachable
  without authentication, and correct for every patent kind this source ingests (utility, design,
  plant, and reissue numbering).
