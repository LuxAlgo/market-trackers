# Source: GPO GovInfo (`govinfo`)

**Datasets:** `bills`
**Status:** implemented
**Auth:** none; free bulk data, keyless.

## Endpoints

- Directory listing: `GET https://www.govinfo.gov/bulkdata/json/BILLSTATUS/{congress}/{billType}`
  with header `Accept: application/json`. `[verify-live]` exact envelope shape — assumed a bare
  `{ files: [...] }` object, each entry carrying (at least) `fileName` and `lastModified`, plus a
  `folder` boolean distinguishing subfolders from files (see below). A 404 here is read as
  "nothing published for this type yet" (some resolution types can be empty early in a new
  congress), not an error.
- Individual bill: `GET https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{billType}/BILLSTATUS-{congress}{billType}{number}.xml`
  — the raw BILLSTATUS XML for one bill.
- The 8 bill types walked every sync, matching `schema/bill.ts`'s `billType` values: `hr`, `s`,
  `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`.

## Congress numbering

- `congress = floor((year - 1789) / 2) + 1`, derived from `ctx.now()` — the source always syncs
  the **current** congress; there is no config knob yet to target a different one (see "Depth"
  below). 2025 and 2026 both resolve to the 119th; 2027 resolves to the 120th.
- `ordinal()` renders it for the human-facing URL (`119th`, `121st`, `122nd`, `123rd`, with the
  11–13 "always th" exception handled).
- `provenance.sourceUrl` is the **congress.gov** bill page, not a GovInfo URL:
  `https://www.congress.gov/bill/{ordinal(congress)}-congress/{slug}/{number}`, where `slug` maps
  `hr`→`house-bill`, `s`→`senate-bill`, `hjres`→`house-joint-resolution`,
  `sjres`→`senate-joint-resolution`, `hconres`→`house-concurrent-resolution`,
  `sconres`→`senate-concurrent-resolution`, `hres`→`house-resolution`, `sres`→`senate-resolution`.

## Ingestion

- Each of the 8 bill types is walked independently against the current congress's directory
  listing, in a fixed order (`hr`, `s`, `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres`).
- **Watermark model:** one watermark per (congress, bill type) —
  `billstatus.{congress}.{type}.lastModified` — the max file `lastModified` (canonicalized to a
  full ISO-8601 instant, whatever precision/offset the live field actually uses) among files this
  ingestor has successfully fetched for that type. A sync lists the directory and fetches only
  files newer than that watermark; with no watermark yet (first sync of that type) or `--full`,
  it fetches everything the listing names.
  - `--since` (`YYYY-MM-DD`) **overrides** the watermark as an inclusive floor
    (`lastModified >= since`, from the start of that day) — it replaces the watermark check, it
    does not additionally combine with it.
  - `--until` (`YYYY-MM-DD`) bounds the window inclusively at the end of that day (up to, but not
    including, the following midnight) — what the backfill engine chunks a historical walk
    through.
  - The watermark only advances for a type once its **entire** walk that run completed — every
    candidate file in the window was fetched (whether or not it went on to parse successfully)
    and `--limit` was never hit. A single bad file (network error or unparseable XML) leaves that
    type's watermark exactly where it was, so the next sync retries the whole window rather than
    silently skipping past the failure.
  - `--limit` is a soft cap on bill XML files **fetched** this run, shared across all 8 types (not
    multiplied per type) — types are walked in order and each spends from what's left; hitting it
    stops that type's walk (noted in the result) and skips the listing fetch entirely for any
    later type that starts with zero budget remaining.
  - `--datasets` is respected the way a single-dataset source does: anything excluding `"bills"`
    is a full no-op.
  - Unlike a paginated search API, one file's failure never blocks its siblings — the walk tries
    every candidate file in the window, skip-and-counting failures into
    `SourceSyncResult.parse`, and only lets that fact hold the watermark back.

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

BILLSTATUS bulk data covers the 113th Congress (2013) onward. This ingestor only ever syncs the
current congress (see "Congress numbering" above) — a historical congress could in principle be
ingested by running sync with `--since`/`--full` scoped to that congress's own directory, but
there is **no config knob yet** to point the source at a congress other than the current one.
Noted plainly here as **not yet configurable**, rather than silently unsupported.

## Canary

- `probe-listing` (hard): the current congress's `hr` directory listing fetches successfully.
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

Built and tested fully offline against the fixtures above — this environment cannot reach
`www.govinfo.gov`. Confirm the following against the live service before depending on it in
production; the fingerprint canary above goes red the moment the listing shape drifts, rather
than misparsing silently:

- **Listing envelope and field names.** Assumed a bare `{ files: [...] }` object, each entry
  carrying (at least) `fileName`, `lastModified`, and `folder`. The parser only reads these
  three; extra fields (`fileSize`, `formattedFileSize`, `mimeType`, `link`, …) pass through
  untouched and don't affect parsing, but do affect the fingerprint (it hashes every field name
  on the sampled row). Confirm the real field names against a live
  `GET .../bulkdata/json/BILLSTATUS/119/hr` response.
- **`lastModified` format.** Assumed some `Date`-parseable string (ISO-8601, with or without a
  timezone offset, a trailing "Z", or fractional seconds); canonicalized to a full UTC ISO
  instant (`toIsoInstant`) before any comparison, so the exact live format doesn't matter as long
  as `Date.parse` accepts it. Confirm that it does.
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
- **113th-congress-onward depth**, and the eventual config knob to target a non-current congress
  (see "Depth" above) — not yet configurable.
