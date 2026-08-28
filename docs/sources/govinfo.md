# Source: GPO GovInfo (`govinfo`)

**Datasets:** `bills`
**Status:** implemented
**Auth:** none; free bulk data, keyless.

## Endpoints

- Directory listing: `GET https://www.govinfo.gov/bulkdata/json/BILLSTATUS/{congress}/{billType}`
  with header `Accept: application/json`. Envelope: a bare `{ files: [...] }` object.
  **Confirmed live** (`[verify-live]` below): each entry names the file in `justFileName` and its
  modification time in `formattedLastModifiedTime` (a `"DD-Mon-YYYY HH:MM"` string, e.g.
  `"13-Jul-2026 23:36"` — not ISO-8601), plus a `folder` boolean distinguishing subfolders from
  files. `fileName`/`lastModified` are also accepted, for legacy/fixture tolerance only — the
  live service does not send them. A 404 here is read as "nothing published for this type yet"
  (some resolution types can be empty early in a new congress), not an error.
- Individual bill: `GET https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{billType}/BILLSTATUS-{congress}{billType}{number}.xml`
  — the raw BILLSTATUS XML for one bill.
- The 8 bill types walked every sync, matching `schema/bill.ts`'s `billType` values: `hr`, `s`,
  `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`.

## Congress numbering

- `congress = floor((year - 1789) / 2) + 1` — `currentCongress()` derives it from `ctx.now()`;
  `congressForDate()` derives it from an arbitrary `YYYY-MM-DD` string the same way, used to map
  a `--since`/`--until` window onto a congress range (see "Ingestion" below). 2025 and 2026 both
  resolve to the 119th; 2027 resolves to the 120th. `congressForDate` deliberately approximates
  the Jan-3 start-of-term boundary in a congress's first (odd) year — harmless, since adjacent
  congresses are adjacent walk chunks and every upsert is idempotent.
- `ordinal()` renders it for the human-facing URL (`119th`, `121st`, `122nd`, `123rd`, with the
  11–13 "always th" exception handled).
- `provenance.sourceUrl` is the **congress.gov** bill page, not a GovInfo URL:
  `https://www.congress.gov/bill/{ordinal(congress)}-congress/{slug}/{number}`, where `slug` maps
  `hr`→`house-bill`, `s`→`senate-bill`, `hjres`→`house-joint-resolution`,
  `sjres`→`senate-joint-resolution`, `hconres`→`house-concurrent-resolution`,
  `sconres`→`senate-concurrent-resolution`, `hres`→`house-resolution`, `sres`→`senate-resolution`.

## Ingestion

- **The date window selects which congresses to walk, not which files.** `--since`/`--until`
  (`YYYY-MM-DD`) pick WHICH congress-directory listings `sync` walks — the only way to reach a
  historical congress, since GovInfo's directories are keyed by congress, not by date:
  - With `--since` set: every congress from `max(108, congressForDate(--since))` through
    `min(congressForDate(--until or today), currentCongress(now))` — 108 is BILLSTATUS's
    earliest-covered congress. A window spanning two congresses walks both.
  - With no `--since`: only the current congress — daily `sync`'s behavior is unchanged.
  - `--until` alone, with no `--since`, has no effect: there is no window to map to a range.
  - Congresses are walked oldest first; within each, each of the 8 bill types is walked
    independently, in a fixed order (`hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`,
    `sres`).
- **Watermark model:** one watermark per (congress, bill type) —
  `billstatus.{congress}.{type}.lastModified` — the max file `lastModified` (canonicalized to a
  full ISO-8601 instant, whatever precision/offset the live field actually uses) among files this
  ingestor has successfully fetched for that (congress, type). Walking a chosen congress fetches
  only files newer than that watermark; with no watermark yet (first walk of that congress/type)
  or `--full`, it fetches everything the listing names. A file's `lastModified` is **never** used
  to filter which candidates a walk fetches — see "Why lastModified can't be a date filter" below.
  - The watermark only advances for a (congress, type) once its **entire** walk that run
    completed — every candidate file was fetched (whether or not it went on to parse
    successfully) and `--limit` was never hit. A single bad file (network error or unparseable
    XML) leaves that watermark exactly where it was, so the next sync retries the whole set
    rather than silently skipping past the failure.
  - `--limit` is a soft cap on bill XML files **fetched** this run, shared across every congress
    walked and all 8 types (not multiplied per congress or per type) — congresses are walked
    oldest-first, each type in order within a congress, and each spends from what's left; hitting
    it stops that type's walk (noted in the result) and skips the listing fetch entirely for any
    later (congress, type) that starts with zero budget remaining.
  - `--datasets` is respected the way a single-dataset source does: anything excluding `"bills"`
    is a full no-op.
  - Unlike a paginated search API, one file's failure never blocks its siblings — the walk tries
    every candidate file, skip-and-counting failures into `SourceSyncResult.parse`, and only lets
    that fact hold the watermark back.

### Why `lastModified` can't be a date filter

GPO regenerates old congresses' files — a 113th-congress file can carry a `lastModified` from
years after that congress adjourned. A modification date says nothing about when the underlying
legislative event happened, so filtering candidates by it would silently and permanently exclude
real data from a deep backfill: a chunk targeting, say, `[2013-01-01, 2014-01-01]` would miss any
113th-congress file GPO happened to touch later. The date window's only job is picking which
congress directories to walk, in full; `lastModified` only ever feeds the incremental watermark
once inside one.

## Field mapping

- Parsed straight from the BILLSTATUS XML (`bill-xml.ts`) with a small tolerant tag/block
  extractor (`xml.ts`) — no new dependency, no full DOM: a missing or empty tag reads as absent
  (`null`) rather than throwing, and the caller decides which fields are actually required.
  - **Required** (a missing/unusable value fails the whole file, skip-and-counted): `congress`,
    `type` (must be one of the 8 known types), `number`, `title`, `introducedDate`.
  - The document's own `congress`/`type`/`number` are cross-checked against what was
    requested (the directory + file name that led to fetching it) — a mismatch is treated as a
    parse failure rather than trusted blindly.
  - **Optional** (absent → `null`/`0`, never a failure): `latestAction/actionDate` + `text`, the
    first `sponsors/item`'s `bioguideId` + `fullName`, `policyArea/name`, and the count of
    `cosponsors/item` entries (`0` for no `<cosponsors>` block at all, an empty one, or a
    self-closing one).
  - BILLSTATUS carries both a single top-level `<title>` (the display title) and a `<titles>`
    list of every title variant — each item of which has its own nested `<title>`. The parser
    excludes the entire `<titles>` block before searching for `<title>`, so the top-level one is
    always what's read regardless of which happens to come first in the live document's element
    order (`[verify-live]`).
  - `title`/`latestActionText` unwrap a CDATA-wrapped value verbatim, or decode standard XML
    entities otherwise (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, numeric refs) — `&amp;`
    decodes last so a literal escaped entity in the source text is never double-unescaped.
- Natural key: `billId(congress, billType, billNumber)` (`"{congress}-{billType}-{billNumber}"`).
  `parser: "govinfo-billstatus@1"`, `confidence: 1`.

## Depth

BILLSTATUS bulk data covers the 108th Congress (2003) onward. `sync --since <date> [--until
<date>]` reaches any of it: the date window maps to a congress range (see "Ingestion" above),
floored at the 108th as GovInfo's earliest congress with any BILLSTATUS coverage — a `--since`
before 2003 just clamps up to 108 rather than erroring. With no `--since`, `sync` still walks
only the current congress (daily behavior, unchanged). `alt-data backfill` drives a historical
walk the same way it drives every other date-walking source (see `docs/backfill.md`); the 108th
floor exists because that's where GovInfo's own directories stop, not because of any
per-congress modification date (see "Why lastModified can't be a date filter" above).

## Canary

- `probe-listing` (hard): the current congress's `hr` directory listing fetches successfully AND
  lists at least one file. Mid-congress, `hr` is never legitimately empty, so a listing that
  fetches fine but names zero files is still a hard failure, independent of whether `sync` itself
  throws on the same listing.
- `fingerprint` (hard): hash of that listing's first file entry's sorted field names, stored under
  `govinfo.listing-fields` — this is what catches the live listing shape drifting out from under
  the `[verify-live]` assumptions below.
- `parse-success-rate` (hard): reuses `parseAttempted`/`parseSucceeded` from the last recorded
  sync run (`store.latestSyncRun`, the same pattern `house-clerk`/`senate-efd`/`edgar` use)
  rather than re-probing live — fetching and parsing a real bill XML file on every canary run
  would spend a request on a number the last sync already measured across every type it walked.
- `freshness-bills` (soft): a row ingested within the `bills` dataset's freshness window (10
  days — BILLSTATUS refreshes daily, but a quiet week must not page anyone).

## Fixtures

`fixtures/govinfo/case-billstatus-hr-and-s/` — congress 119, two of the eight bill types
fixtured (the test's mock returns an empty listing for the other six): `listing-hr.json` names a
folder entry (skipped), a non-BILLSTATUS file name (skipped at discovery, never fetched), and 3
real files — `BILLSTATUS-119hr1234.xml` (a full bill: a sponsor, 2 cosponsors, a latest action, a
policy area, and a `<titles>` list whose nested alternate title must not be picked over the
top-level one), `BILLSTATUS-119hr5678.xml` (sparse: no cosponsors/latestAction/policyArea, a
CDATA-wrapped title, a full-timestamp `introducedDate`), and `BILLSTATUS-119hr9999.xml` (no
`<title>` — the deliberate parse failure). `listing-s.json` + `BILLSTATUS-119s200.xml` is the
second bill type, proving per-type watermark/fingerprint independence: `hr`'s watermark never
advances (its one bad file keeps failing every run) while `s`'s does.

## `[verify-live]`

Tested against the fixtures above, which mirror the live shapes confirmed below via the repo's
verify-live workflow:

- **Listing envelope and field names — CONFIRMED live.** A bare `{ files: [...] }` object; each
  non-folder entry names the file in `justFileName` and its modification time in
  `formattedLastModifiedTime`. Real captured row:
  `{"displayLabel":"BILLSTATUS-119hr152.xml","fileExtension":"xml","folder":false,"formattedLastModifiedTime":"13-Jul-2026 23:36","formattedSize":"17.6 KB","justFileName":"BILLSTATUS-119hr152.xml","link":"https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr152.xml","mimeType":"application/xml","name":"BILLSTATUS-119hr152.xml","size":18015}`.
  There is no `fileName` or `lastModified` field live — those are still accepted, for
  legacy/fixture tolerance only. Extra fields (`fileExtension`, `formattedSize`, `mimeType`,
  `link`, `size`, `displayLabel`, `name`) pass through untouched and don't affect parsing, but do
  affect the fingerprint (it hashes every field name on the sampled row).
- **`formattedLastModifiedTime` format — CONFIRMED live.** `"DD-Mon-YYYY HH:MM"` (e.g.
  `"13-Jul-2026 23:36"`), not ISO-8601. `Date.parse` accepts it directly, reading it as a local
  time — `toIsoInstant` canonicalizing it to the matching UTC instant depends on the process
  running in UTC, true of both this test suite and CI.
- **Shape drift throws, loudly, instead of parsing to zero rows.** A listing response that names
  at least one non-folder file but yields zero entries after extraction — every candidate row
  failed both the file-name and modification-time lookups — raises `GovinfoListingDriftError`
  (naming the URL and the first row's field names) instead of returning an empty `entries` array.
  Deliberately not an `HttpError`: `syncBillType` only downgrades `HttpError` to a note, so a
  drift error propagates out of `sync` and fails the run loudly, rather than the source reporting
  a clean 0-row success. The `probe-listing` canary independently treats a genuinely empty `hr`
  listing as a hard failure too, since mid-congress that's never legitimate either.
- **Window→congress model, with a 108th-congress floor.** `--since`/`--until` select which
  congress directories to walk (`congressForDate`, clamped to `[108, currentCongress(now)]`) —
  see "Ingestion" and "Depth" above. A file's `lastModified` is never a date filter on candidates
  within a chosen congress; it only ever feeds that (congress, type)'s own incremental watermark.
- **BILLSTATUS XML's top-level `<title>` vs. `<titles>` ordering.** Assumed a single top-level
  `<title>` element distinct from the `<titles>` array of title variants; the parser strips the
  whole `<titles>` block before searching, so it's robust to either ordering, but confirm a
  top-level `<title>` genuinely exists in the live schema (rather than, say, the display title
  only ever living inside a `<titles>` item).
- **`<type>` casing.** Assumed uppercase (`HR`, `S`, `HJRES`, …) in the live XML; the parser
  lowercases before comparing against the known 8 types, so either casing works.
- **`<cosponsors>` shape.** Assumed a flat `<item>` per cosponsor with no nested `<item>` of its
  own; the count is a raw regex count of `<item>` occurrences inside the block, which would
  over-count if a cosponsor item ever nests another `<item>`-tagged list internally.
