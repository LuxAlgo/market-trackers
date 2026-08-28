# Source: PatentsView (`patentsview`)

**Datasets:** `patents`
**Status:** implemented
**Auth:** free USPTO Open Data Portal (ODP) API key (config `patentsviewApiKey` /
`MARKET_TRACKERS_PATENTSVIEW_KEY`), sent as the `x-api-key` header on every request. With no key
configured, `sync` skips the source with a polite note (keyless multi-source runs still ship
every other source's data) and the canary reports a soft skipped-no-key note.

**Getting a key:** create a USPTO.gov account (MFA required), complete the four required "Open
Data Portal" fields on the account profile, then use **Manage API Key** on
[data.uspto.gov](https://data.uspto.gov). The key is free.

## The ODP migration

The legacy PatentsView PatentSearch API this source originally consumed is decommissioned —
`search.patentsview.org` no longer resolves in DNS (**verified live**, 2026-08). There is no
query-style search API on its replacement: PatentsView's granted-patent data now ships as a
**bulk dataset product** on the USPTO Open Data Portal, and this source ingests it as bulk files.
The same env var (`MARKET_TRACKERS_PATENTSVIEW_KEY`) carries over; only the host, model, and parser
(`patentsview-odp@1`) changed. The emitted `patents` row shape is unchanged.

## Endpoints

- Product metadata (the sync driver, 1 request):
  `GET https://api.uspto.gov/api/v1/datasets/products/pvgpatdis` (product id is
  case-insensitive) with `accept: application/json` and `x-api-key`. Envelope (**verified
  live**): `{count, bulkDataProductBag: [{…, productFrequencyText: "QUARTERLY",
lastModifiedDateTime, productFileTotalQuantity: 37, productFileBag: {count, fileDataBag:
[{fileName, fileSize, fileDataFromDate, fileDataToDate, fileTypeText, fileDownloadURI,
fileReleaseDate, fileLastModifiedDateTime}]}}]}`.
  - **Never send the `fileDataFromDate`/`fileDataToDate` query params** — they filter the file
    bag in non-obvious ways (**verified live**). Fetch the product bare and select files by
    `fileName`.
- File downloads: each entry's `fileDownloadURI`
  (`https://api.uspto.gov/api/v1/datasets/products/files/PVGPATDIS/<fileName>`), same
  `x-api-key` header, streamed to disk — the table zips run 0.5–2 GB compressed and are never
  buffered whole.
- Error semantics (**verified live**): no key → 401 `{"message":"Unauthorized"}`; unknown route →
  403 `{"message":"Missing Authentication Token"}`; authenticated request for a nonexistent
  product id → 404 `{"code":404,"message":"Not Found","requestIdentifier":"…"}`. The client maps
  401-with-key to an actionable "key rejected" error (revoked key / incomplete ODP profile) and
  the product 404 to drift, not a transient note.
- Rate limits are generous (documented in the millions of requests per week); the client still
  runs through the standard polite fetch with a small limiter (`{limit: 4, windowMs: 1000}`) —
  a sync makes exactly 4 requests.

## The quarterly release model

The product refreshes **quarterly** as whole-table replacement files covering January 1976 →
present, so date-chunked walking makes no sense here. Sync is release-driven:

1. Fetch the product metadata. `lastModifiedDateTime` is the release stamp.
2. If it is `<=` the stored watermark (`patentsview.odpRelease`) and `--full` wasn't passed:
   no-op with a note. One metadata request is the whole cost of a daily sync between releases.
3. Otherwise download the three table zips to a temp dir (`os.tmpdir()`), stream-parse and
   upsert (below), then advance the watermark to the release stamp — only after a fully
   completed pass, and only forward.

Consequences, all deliberate:

- **One completed sync IS the full 1976→present history.** There is no backfill ladder for
  patents anymore: `market-trackers backfill` skips this source (`DATE_UNBOUNDED_SOURCES`), and
  `--since`/`--until` are ignored by `sync` with an explanatory note.
- `--limit N` caps patents **upserted** this run (smoke tests); hitting it stops the stream,
  notes it, and leaves the watermark untouched — a partial ingest must never mask the rest of
  the release.
- `--full` ignores the watermark and re-ingests the current release (idempotent upserts).
- `--datasets` excluding `patents` is a full no-op.

## Table files consumed

Three of the product's 37 files, selected from the bag by exact `fileName`
(a missing one is drift and fails loudly before any download):

| File                               | Columns used                                                         | Role                                                         |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `g_patent.tsv.zip`                 | `patent_id`, `patent_date`, `patent_title`, `wipo_kind`, `withdrawn` | One row per granted patent — the rows the dataset emits.     |
| `g_assignee_disambiguated.tsv.zip` | `patent_id`, `assignee_sequence`, `disambig_assignee_organization`   | First-listed organization + total assignee count per patent. |
| `g_cpc_current.tsv.zip`            | `patent_id`, `cpc_sequence`, `cpc_class`                             | First (lowest-sequence) present CPC class per patent.        |

Each zip holds one TSV (the zip name minus `.zip`): one header row, tab-separated, with a
quoted-field dialect (`"`-wrapped values, `""` escaping, embedded tabs/newlines legal inside
quotes). The reader (`tsv-zip.ts`) streams the archive through fflate's streaming `Unzip` —
already a dependency; its streaming decoder handles deflate, ZIP64 local headers, and
data-descriptor entries — and assembles records line-by-line, so memory stays flat regardless
of file size. A required column missing from a header is drift (`OdpProductDriftError`), since
it would otherwise silently blank that field on ~9.5M rows.

## Join strategy

~9.5M patents, ~15M assignee rows, tens of millions of CPC rows. The assignee and CPC tables
are streamed first into a throwaway better-sqlite3 file (`join-scratch.ts`) holding one
aggregate row per patent (org of the lowest org-bearing sequence, total count, first CPC class);
then `g_patent` streams through, looks each patent up, and upserts finished rows in batches of 500. A scratch table was chosen over two in-heap Maps because ~9.5M-entry Maps retain 2–3 GB —
fine on CI's 12 GB heap, risky on end-user machines with Node's default old-space ceiling — and
because it behaves identically whether the main store is SQLite or Postgres. Ticker resolution
memoizes per organization name (`resolveEntityTickersTiered`, the same two-tier
curated-map-then-SEC-names resolver as USAspending/LDA).

- **Withdrawn patents** (`withdrawn = 1`) parse fine but are never emitted — they were withdrawn
  from issue and are not granted patents in force. The sync notes how many it skipped.
- A malformed row (missing `patent_id`/title, unparseable `patent_date`) is a per-row parse
  failure, skip-and-counted, never a zeroed field.

## Field mapping

- `assignee.name` = `disambig_assignee_organization` on the **lowest `assignee_sequence`** row
  that has one — individual (organization-less) assignees are passed over for the name but still
  count toward `assigneeCount`. A patent with no assignee rows, or only individuals, keeps
  `name: null`. Sequence order decides, not file order.
- `assignee.tickers` resolves through the curated map then the SEC issuer-name index
  (`resolveEntityTickersTiered`). Unmatched assignees are stored with `tickers: []`.
- `cpcClass` = `cpc_class` on the lowest `cpc_sequence` row where it's non-empty, uppercased;
  `null` when the patent has no CPC rows or none with a class.
- `kind` = `wipo_kind` verbatim (trimmed); `null` when blank.
- `grantDate` = `patent_date` (`YYYY-MM-DD`); `id`/`patentId` = `patent_id` (the natural key —
  utility, design (`D…`), and reissue (`RE…`) numbering all pass through as published).
- `provenance.sourceUrl` = `https://data.uspto.gov/patents/{patent_id}` — the ODP per-patent
  page (**verified live**: returns 200; the previous provenance target, the ppubs Patent Public
  Search print endpoint `ppubs.uspto.gov/dirsearch-public/print/downloadPdf/{id}`, now returns
  404 and is gone). `parser: "patentsview-odp@1"`, `confidence: 1`.

## Canary

- `probe-product` (hard; soft skipped-no-key note when no key is configured): the product
  metadata fetches AND its file bag names `g_patent.tsv.zip`. 1 request.
- `fingerprint` (hard): hash of the first file-bag entry's sorted field names, stored under
  `patentsview.odp-file-entry-fields` — catches the metadata shape drifting out from under the
  extraction.
- `parse-success-rate` (hard, `>= 99%`): reuses the last recorded sync run's stats
  (`store.latestSyncRun`) instead of re-probing — re-parsing live rows would mean re-downloading
  a multi-GB table.
- `freshness-patents` (soft): a row ingested within the `patents` freshness window (120 days —
  the product is quarterly, with slack for a late release).

## Fixtures

`fixtures/patentsview/case-odp-quarterly-2026/` — one synthetic quarterly release: product
metadata in the live envelope shape (decoy non-table entries lead the bag), three Python
`zipfile`-built table zips (deflate + stored; a cross-implementation check on the fflate
reader), the drift/401/404 bodies, and the hand-verified `expected.json`. Covers mapped /
unmapped / absent assignees, sequence-beats-file-order for both assignees and CPC, lowercase
CPC uppercased, an empty `cpc_class` passed over, quoted titles with embedded tabs/newlines,
a withdrawn patent, a bad-date parse failure, and an unusable (patent_id-less) assignee row.
See that directory's README for the full row-by-row table.

## `[verify-live]`

Confirmed live via the repo's verify-live workflow (opt-in `use_patentsview_key` mode), 2026-08:
the DNS death of `search.patentsview.org`; the product endpoint, envelope, and per-file field
names; the 401/403/404 semantics; the date-param bag-filtering quirk; `productFileTotalQuantity:
37`; and `https://data.uspto.gov/patents/11000000` returning 200 while the old ppubs print
endpoint 404s.

Still to confirm with an authenticated probe before trusting a full production ingest — the
fixtures mirror assumptions for everything below, and the canary/drift errors above fail loudly
the moment the metadata side moves:

- **Exact table file names in the full bag.** `g_patent.tsv.zip`,
  `g_assignee_disambiguated.tsv.zip`, `g_cpc_current.tsv.zip` — assumed from PatentsView's
  standard granted-patent table naming. Probe the product URL (no date params) and check the
  37-entry bag lists all three verbatim.
- **TSV headers.** Column names assumed from PatentsView's published grant data dictionary:
  `patent_id`, `patent_type`, `patent_date`, `patent_title`, `wipo_kind`, `num_claims`,
  `withdrawn` (g_patent); `patent_id`, `assignee_sequence`, `disambig_assignee_organization`,
  `disambig_assignee_individual_name_first`, `disambig_assignee_individual_name_last`,
  `assignee_type` (assignee); `patent_id`, `cpc_sequence`, `cpc_section`, `cpc_class`,
  `cpc_subclass`, `cpc_group` (CPC). Download each zip and check its header row — a rename
  fails the sync with `OdpProductDriftError` naming the missing column.
- **`withdrawn` encoding.** Assumed `0`/`1` (with `true` tolerated). Check real values.
- **Missing-value encoding.** Assumed empty string (never a literal `NULL` marker).
- **Quoting dialect.** Assumed `"`-wrapped fields with `""` escapes and legal embedded
  tabs/newlines; unquoted fields split on raw tabs. Check a title containing quotes.
- **Zip structure.** Assumed a single TSV entry at the archive root named `<zip name minus
.zip>`, decodable by fflate's streaming `Unzip` (deflate/stored, ZIP64 local headers,
  data-descriptor entries). Confirm one real table zip streams end-to-end.
- **`fileDownloadURI` auth flow.** Assumed the URI serves bytes directly with `x-api-key` (any
  redirect stays on a host where dropping the key header is harmless). Confirm a download works
  through a redirect-following client.
- **`lastModifiedDateTime` ordering.** Assumed the `"YYYY-MM-DD HH:MM:SS"` form sorts
  lexicographically release-over-release (it does for this fixed format); the watermark
  comparison relies on it.
- **Provenance URL across kinds.** `https://data.uspto.gov/patents/{patent_id}` verified for a
  utility number; spot-check a design (`D…`) and reissue (`RE…`) id.
