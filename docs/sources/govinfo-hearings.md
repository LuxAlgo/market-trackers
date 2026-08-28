# Source: GPO GovInfo CHRG (`govinfo-hearings`)

**Datasets:** `congress-hearings`
**Status:** implemented
**Auth:** none; free public sitemaps + metadata, keyless.

Congressional hearing transcripts as published by the US Government Publishing Office — US
government works, public domain. Rows are a rich **index with receipts**: title, chamber,
congress/session, held date, committees, witnesses, member bioguide ids, and working deep links
to the transcript's details page / HTML / PDF. The transcript text itself stays at govinfo.gov.

## Endpoints

- Sitemap index: `GET https://www.govinfo.gov/sitemap/CHRG_sitemap_index.xml` — standard
  `sitemapindex` XML, one `<sitemap>` per year: a `<loc>` naming
  `https://www.govinfo.gov/sitemap/CHRG_{year}_sitemap.xml` and a `<lastmod>`. **Confirmed live**
  (`[verify-live]` below): years reach from the late 1990s through the current year, and old
  years' sitemaps are actively regenerated — a 2015 entry carried a minutes-old `lastmod` — so
  `lastmod` is a refresh hint, never a statement about hearing dates (the same lesson as
  BILLSTATUS `lastModified` in `docs/sources/govinfo.md`).
- Per-year sitemap: `GET https://www.govinfo.gov/sitemap/CHRG_{year}_sitemap.xml` — standard
  `urlset` XML; each `<url><loc>` points at a package details page
  `https://www.govinfo.gov/app/details/CHRG-{congress}{chamber-code}hrg{jacket}`. The package id
  is the loc's last path segment (e.g. `CHRG-118hhrg52977`).
- Package metadata: `GET https://www.govinfo.gov/metadata/pkg/{packageId}/mods.xml` — MODS XML
  carrying everything a row needs (see "Field mapping"). This URL is every row's
  `provenance.sourceUrl`.
- Politeness: the same host and the same polite fetch as the govinfo bills source
  (`createGovinfoFetch`, 5 req/s shared limiter, declared User-Agent, backoff on 403/429/5xx).

## Ingestion

- **The date window selects which YEAR sitemaps to walk, not which packages.**
  `--since`/`--until` map to a calendar-year range (clamped to
  `[EARLIEST_CHRG_YEAR (1995), currentYear]`); with no `--since`, the daily default walks the
  current year **plus the previous one** — GPO publishes transcripts weeks-to-months after the
  hearing, so late-year hearings keep landing in the next calendar year's sitemap runs. The
  sitemap year approximates the hearing's event year, but a package can surface under its
  publication year instead — draw backfill windows generously.
- **Within a chosen year:** fetch the year sitemap, extract package ids, **skip ids already in
  the store** (the diff runs through `store.existingIds`), fetch `mods.xml` per new id, upsert.
  `--full` skips both the lastmod shortcut and the id diff and re-fetches everything the sitemap
  names — idempotent upserts (natural key = package id) make re-walks safe.
- **Watermark model:** one watermark per year — `sitemap.{year}.lastmod` — set to the year
  sitemap's `<lastmod>` (as reported by the index) once that year's walk fully completed: every
  candidate mods.xml was fetched and parsed, and `--limit` was never hit. On a later run, a year
  whose index `lastmod` equals its stored watermark is skipped without even fetching the year
  sitemap. Any change in `lastmod` re-walks the year; the id diff keeps that cheap. A single
  failed package (transport error or unusable mods) holds that year's watermark back, so the
  next run re-diffs and retries it.
- `--limit` caps mods.xml documents fetched this run, shared across all years walked
  (oldest-first). Exhausting it mid-year notes `stopped at --limit` on that year; exhausting it
  exactly at a year boundary notes `stopped at --limit ... before {year}` — either way the note
  contains `--limit`, which the backfill engine reads as "stop and resume here".
- `--datasets` excluding `congress-hearings` is a full no-op.
- An `HttpError` on the sitemap index or a year sitemap becomes a note (the canary is the loud
  channel for outages); a `GovinfoHearingsDriftError` (see below) always propagates and fails
  the sync loudly.

## Field mapping (mods.xml)

Parsed with the same tolerant tag/block primitives as BILLSTATUS (`../govinfo/xml.ts`) plus a
small opening-tag attribute reader (`attrValue`) — no new dependency, no DOM. The document is
first truncated at the first `<relatedItem>` (granule metadata trails the package-level
metadata), so package fields are never polluted by per-granule titleInfo/extension blocks.

- **Required** (missing/unusable fails the whole document — skip-and-count, never a partial
  row): `titleInfo > title` (CDATA unwrapped / entities decoded), `congress` (falls back to the
  congress embedded in the package id, e.g. `CHRG-118…` → 118), and an event date: the first
  `<heldDate>` (multi-day hearings carry several; the first is the event date), falling back to
  `originInfo > dateIssued` on the rare package with no heldDate at all.
- The document's `<accessId>` is cross-checked against the package id the sitemap named — a
  mismatch is a parse failure, never trusted blindly.
- **Optional** (absent → `null`/`[]`): `chamber` (`HOUSE`→`house`, `SENATE`→`senate`, `JOINT`
  and anything else → `null`; `docClass` keeps the raw code — HHRG/SHRG/JHRG …), `docClass`,
  `session`, `preferredCitation`, `congCommittee` list (name prefers the `authority-standard`
  `<name>`, then `authority-short`, then the first `<name>`; `authorityId` from the attribute),
  `witness` list (verbatim lines), `congMember` list (the `bioGuideId` attribute, deduped), and
  the three `location > url` renditions selected by their `displayLabel` attribute (`Content
Detail` → detailUrl, `HTML rendition` → htmlUrl, `PDF rendition` → pdfUrl; a missing Content
  Detail url falls back to the constructed details URL).
- Natural key: the package id. `parser: "govinfo-hearings-mods@1"`, `confidence: 1`.

## Drift (`GovinfoHearingsDriftError`)

Deliberately NOT an `HttpError` (only those are downgraded to notes), following
`GovinfoListingDriftError`'s pattern. Thrown when:

- a 200 sitemap (index or year) yields **zero** extractable locs/package ids — a published
  sitemap always names something; a year with nothing has no sitemap (404) instead;
- a 200 mods.xml has **neither** a title **nor** an `<accessId>` — every CHRG MODS carries
  both, so their joint absence means the format moved, not that one document is bad.

A document with an accessId but a missing required field throws `HearingModsParseError`
instead: one skip-and-count failure that holds the year's watermark back.

## Depth

The sitemap index lists year sitemaps back to the late 1990s, so
`backfill --source govinfo-hearings --from 1997-01-01` can walk the whole collection —
year-chunked by the standard backfill engine (each `since`/`until` chunk maps to the year range
it covers, exactly like govinfo bills maps windows to congresses). Because a package can appear
under its publication year rather than its event year, a full-collection backfill is the only
way to guarantee complete event-date coverage for any given year.

## Canary

- `probe-sitemap-index` (hard): the sitemap index fetches and lists at least one year sitemap.
- `parse-success-rate` (hard): reuses `parseAttempted`/`parseSucceeded` from the last recorded
  sync run rather than re-probing live (the govinfo bills pattern).
- `freshness-congress-hearings` (soft): a row ingested within the dataset's 30-day window —
  generous because GPO publishes transcripts on its own schedule and congressional recesses
  produce real multi-week quiet stretches.
- No field-name fingerprint: sitemaps are a fixed public standard, and mods drift fails loudly
  through `GovinfoHearingsDriftError` instead.

## Fixtures

`fixtures/govinfo-hearings/case-chrg-sitemap-and-mods/` — a 2025+2026 walk: the sitemap index
(2 CHRG years + one non-CHRG loc skipped silently), the 2026 urlset (a duplicate loc deduped, a
non-details loc warned about, 3 real packages), the 2025 urlset (1 package), and four mods
documents — the rich house case (witnesses, members, committees, entities in the title, a
trailing `<relatedItem>` granule that must not leak), the senate minimal case (CDATA title, no
heldDate → dateIssued fallback, PDF only), a joint hearing (chamber `JOINT` → null, multi-day
heldDate, authority-short committee name), and a deliberate parse failure (accessId but no
title) that keeps 2026's watermark from advancing.

## `[verify-live]`

Tested against the fixtures above, which mirror live shapes captured via the repo's verify-live
tooling on 2026-08-27:

- **Sitemap index shape — CONFIRMED live.** `GET
https://www.govinfo.gov/sitemap/CHRG_sitemap_index.xml` → 200, standard `sitemapindex`; per
  year: `<sitemap><loc>https://www.govinfo.gov/sitemap/CHRG_2015_sitemap.xml</loc><lastmod>2026-08-27T18:01:00.111Z</lastmod></sitemap>`.
  Years ~1997→2026. The 2015 entry's lastmod was minutes old at capture — old years DO get
  regenerated, so `lastmod` is only a refresh hint.
- **Year sitemap shape — CONFIRMED live.** `GET
https://www.govinfo.gov/sitemap/CHRG_2026_sitemap.xml` → 200, standard `urlset`; each
  `<url><loc>` points at `https://www.govinfo.gov/app/details/CHRG-…` (package id = last path
  segment, e.g. `CHRG-118hhrg52977`).
- **mods.xml fields — CONFIRMED live** (fragment from `CHRG-118hhrg52977`):
  `<titleInfo><title>` (the display title), `<location>` urls with
  `displayLabel="Content Detail" / "HTML rendition" / "PDF rendition"`,
  `<originInfo><dateIssued encoding="w3cdtf">2023-07-12</dateIssued>`, and extension fields
  `<docClass>HHRG</docClass> <accessId>CHRG-118hhrg52977</accessId> <type>O</type>
<chamber>HOUSE</chamber> <congress>118</congress> <session>1</session>
<heldDate>2023-07-12</heldDate> <preferredCitation>Serial No. 118-32</preferredCitation>`,
  plus repeated `<witness>` elements, `<congCommittee authorityId="hsju00" …>` with
  `authority-standard`/`authority-short` names, and `<congMember>` elements carrying
  `bioGuideId` attributes. Multiple witness/committee/member elements occur; some hearings have
  zero witnesses; `heldDate` can be absent on rare packages (dateIssued stands in); senate
  hearings (docClass SHRG) and appropriation prints share the shape.
- **Assumed, confirm on the next live probe:** (1) `<relatedItem>` granule blocks always FOLLOW
  the package-level metadata in document order — the parser truncates at the first one
  (`GET https://www.govinfo.gov/metadata/pkg/CHRG-118hhrg52977/mods.xml`, check element order);
  (2) the `congMember` attribute is spelled `bioGuideId` (matched case-insensitively here);
  (3) a package-level `<location>` block precedes any granule locations; (4) the earliest year
  sitemap in the index (this module clamps `--since` at 1995 — probe
  `https://www.govinfo.gov/sitemap/CHRG_1997_sitemap.xml` and neighbors to pin the real floor);
  (5) joint hearings' `<chamber>` value is literally `JOINT`.
