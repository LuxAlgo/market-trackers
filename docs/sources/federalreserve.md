# Source: Federal Reserve Board (`federalreserve`)

**Datasets:** `fed-communications`
**Status:** implemented
**Auth:** none; free public JSON feeds, keyless.

Federal Reserve Board monetary-policy communications — FOMC statements and minutes
announcements (via the Monetary Policy press category), governor/chair speeches, and
congressional testimony. Board publications are US government works. Rows are an **index with
receipts** (type/title/speaker/date/venue + a working deep link); the full text stays at
federalreserve.gov. No rate expectations, no tone scoring, no interpretation — an index of what
the Board published and when, verbatim.

## Endpoints

All three feeds are small whole-history JSON files, fetched in full every sync. **Each file
begins with a UTF-8 BOM** — strip it before `JSON.parse` (confirmed live; parsing fails
otherwise).

- `GET https://www.federalreserve.gov/json/ne-speeches.json` — array of items:
  `{"d":"8/5/2026 4:05:00 PM","t":"…","s":"Governor …","lo":"At the …","l":"/newsevents/speech/….htm","a":"","o":"no","v":"","video":"No"}`.
  `d` = datetime (`M/D/YYYY h:mm:ss AM/PM`, US-Eastern — only the DATE part is stored),
  `t` = title, `s` = speaker, `lo` = location/venue, `l` = relative link, `a` = addendum note,
  `v` = video link (sometimes).
- `GET https://www.federalreserve.gov/json/ne-testimony.json` — same shape (`s` e.g. a Chair,
  `lo` e.g. "Before the Committee on …, U.S. House of Representatives").
- `GET https://www.federalreserve.gov/json/ne-press.json` — same shape plus `pt`, the
  press-release category. **Only `pt === "Monetary Policy"` is kept** (FOMC statements, minutes
  availability, implementation notes); other categories (Enforcement Actions, Orders on Banking
  Applications, …) are out of scope for this dataset and are filtered at ingestion — parsed
  fine, counted as successes, never stored.
- Detail pages resolve at `https://www.federalreserve.gov{l}` (e.g.
  `/newsevents/pressreleases/monetary20251210a.htm`).
- Politeness: `createPoliteFetch` with a 2 req/s limiter and declared User-Agent — three tiny
  files per run.

## Ingestion

- **Every sync is the full pass:** fetch all three feeds, normalize, upsert everything.
  Natural-key upserts (id = the link path) make that idempotent; `--full` changes nothing
  because there is nothing narrower than the full pass. `--since`/`--until` are ignored for
  fetching — the feeds are whole files — and exist only so the backfill engine can drive the
  same pass (see "Depth").
- **Ids:** the feed link minus the `/newsevents/` prefix and `.htm` suffix —
  `"/newsevents/speech/cook20260805a.htm"` → `speech/cook20260805a`. Unique and stable; a link
  without the prefix keeps its full path minus the leading slash.
- **Type mapping:** speeches feed → `speech`; testimony feed → `testimony`; Monetary Policy
  press items by title — starting `"Minutes of the Federal Open Market Committee"` → `minutes`,
  containing `"FOMC statement"` (covers `"Federal Reserve issues FOMC statement"`) →
  `statement`, anything else → `pressRelease` (implementation notes, the Board's discount-rate
  minutes, …).
- **Field mapping:** `date` = the DATE part of `d` read verbatim from the string (never through
  `Date` and the process timezone); `speaker`/`venue`/`note` = `s`/`lo`/`a` with blank → null
  (press releases carry no `s`); `url` = absolute `https://www.federalreserve.gov` + `l`;
  `videoUrl` = absolutized `v` when non-blank. A missing/unusable `d`, `t`, or `l` fails that
  item (skip-and-count), never a partial row. `parser: "federalreserve-json@1"`,
  `confidence: 1`; `provenance.sourceUrl` is the feed URL.
- **Watermark** (`feeds.latestItemDate`) is informational only — the newest communication date
  seen — advanced only by a complete pass, never used as a fetch filter.
- **Short-feed note:** any feed returning fewer than 50 entries adds a run note
  (`… feed may have shortened`) so operators notice a quietly truncated feed.
- `--limit` caps items normalized this run (shared across the feeds, the same row-level reading
  the CFTC source gives it); hitting it notes `stopped at --limit` and holds the watermark.
- `--datasets` excluding `fed-communications` is a full no-op.
- An `HttpError` on one feed becomes a note and the other feeds still ingest; a 200 body that
  isn't a JSON array throws `FederalReserveFeedDriftError`, which always propagates and fails
  the sync loudly (deliberately not an `HttpError`, following `GovinfoListingDriftError`'s
  pattern).

## Depth

**Unknown, honestly:** the Board does not document how far back each feed reaches, and this
source treats the feed content as the coverage — it does not scrape archive pages to
manufacture deeper history. `backfill --source federalreserve` is registered as a
**single-pass** source (`SINGLE_PASS_SOURCES` in `backfill/engine.ts`): the window is walked as
ONE `[from, to]` chunk — the same full-feed pass daily sync performs — instead of a chunked
date walk that would repeat the identical fetch once per chunk. If deeper history is ever
wanted, it needs a deliberate archive-page ingestor with its own verification, not this one.

## Canary

- `probe-press-feed` (hard): `ne-press.json` fetches, parses to a non-empty array, and contains
  at least one `pt === "Monetary Policy"` entry.
- `fingerprint` (hard): sha256 of the first press item's sorted field names, stored under
  `press.item-fields` — catches the single-letter field names drifting.
- `parse-success-rate` (hard): normalizes the probe's Monetary Policy items and asserts ≥ 99%.
- `freshness-fed-communications` (soft): every healthy sync re-upserts the whole feeds (so
  `retrievedAt` refreshes each run) — staleness beyond 96h means the pipeline stopped running,
  not that the Fed went quiet.

## Fixtures

`fixtures/federalreserve/case-feeds/` — synthetic copies of the three feeds, each carrying a
real UTF-8 BOM (the happy-path test asserts the BOM is present, so it only passes if stripping
works). The speeches feed exercises a blank `lo` (null venue), a filled `a` (note kept), and a
filled relative `v` (absolutized videoUrl). The press feed mixes categories: three Monetary
Policy items proving the minutes/statement/pressRelease title mapping, plus one Enforcement
Actions and one Orders on Banking Applications item that must be filtered out.

## `[verify-live]`

Tested against the fixtures above, which mirror live shapes captured via the repo's verify-live
tooling on 2026-08-27:

- **All three feed URLs — CONFIRMED live** (200, keyless): `/json/ne-speeches.json`,
  `/json/ne-testimony.json`, `/json/ne-press.json`. Each body begins with a UTF-8 BOM.
- **Item shape — CONFIRMED live.** Speeches:
  `{"d":"8/5/2026 4:05:00 PM","t":"Outlook for the U.S. and Alaskan Economies","s":"Governor Lisa D. Cook","lo":"At the 2026 Economic Luncheon of …","l":"/newsevents/speech/cook20260805a.htm","a":"","o":"no","v":"","video":"No"}`.
  Press: `{"d":"8/25/2026 2:00:00 PM","t":"Minutes of the Board's discount rate meetings on July 20 and July 29, 2026","pt":"Monetary Policy","l":"/newsevents/pressreleases/monetary20260825a.htm"}`.
  Detail pages resolve (e.g. `/newsevents/pressreleases/monetary20251210a.htm` → 200).
- **Assumed, confirm on the next live probe:** (1) how far back each feed actually reaches
  (fetch each feed, report the min/max `d` and entry count — also calibrates the 50-entry
  short-feed threshold against reality); (2) that `v` values are always site-relative or
  absolute URLs (the normalizer absolutizes relative ones); (3) the exact live casing/wording
  of FOMC statement titles beyond the two captured forms (`"Federal Reserve issues FOMC
statement"`; the mapping is a case-sensitive contains on `"FOMC statement"`); (4) whether the
  press feed ever lists a Monetary Policy item whose `l` points outside
  `/newsevents/pressreleases/…` (ids would still be stable, but worth seeing once).
