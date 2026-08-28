# Deep-history backfill

`market-trackers sync` is an incremental tail: it walks forward from a watermark, a few days at a
time, and is meant to run often (daily, in CI). `market-trackers backfill` is the other direction —
walking a source's history **backward** in time, potentially years deep, as one command
instead of a string of manually-chosen `--since`/`--until` invocations.

It reuses `market-trackers sync` under the hood (same parsers, same idempotent upserts, same
per-source watermark) — backfill's only job is to drive it in bounded, resumable chunks so a
multi-year walk survives being interrupted.

## Quick start

```bash
# Local: walk USAspending grants from 2010 through today, 30 days at a time.
market-trackers backfill --source usaspending --from 2010-01-01

# A bounded window, human-readable progress:
market-trackers backfill --source finra --from 2015-01-01 --to 2015-12-31 --chunk-days 14

# Machine-readable summary (what the CI workflow uses):
market-trackers backfill --source edgar --from 2015-01-01 --to 2015-12-31 --json
```

Flags (see `market-trackers backfill --help`):

| Flag               | Meaning                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `--source <ids>`   | Comma-separated source ids. Defaults to every implemented source, same as `market-trackers sync`. |
| `--from <date>`    | Start of the window (`YYYY-MM-DD`). **Required.**                                                 |
| `--to <date>`      | End of the window, inclusive. Defaults to today.                                                  |
| `--chunk-days <n>` | Calendar days per resumable chunk. Defaults to 30.                                                |
| `--limit <n>`      | Soft cap on documents fetched **per source** this run (demos/smoke tests).                        |
| `--full`           | Ignore the `backfill.completedThrough` resume watermark and re-walk the whole window.             |

Exit code is `0` when every requested source walked all the way through `--to`, `1` when any
source stopped early (a chunk hit `--limit`, or errored) — the process also prints a resume
hint in that case. In both cases, whatever WAS ingested is already committed to the store;
nothing is rolled back.

## The chunk/resume model

`runBackfill` (`packages/core/src/backfill/engine.ts`) walks each requested source
independently:

1. For each source, `[from, to]` is split into consecutive, non-overlapping `chunkDays`-day
   windows (the last window is shorter when the range doesn't divide evenly).
2. Each window becomes one `runSync(ctx, { sources: [id], since: chunkStart, until: chunkEnd,
limit: <remaining budget> })` call — the exact same sync path `market-trackers sync` uses, just
   date-bounded. `SyncOptions.until` (honored by every date-walking source; see below) is what
   makes a chunk stop exactly at its end date instead of walking through today.
3. Progress is recorded in a **separate** watermark, `backfill.completedThrough`, namespaced
   per source — distinct from the source's own incremental watermark (e.g.
   `usaspending.lastActionDate`). The two never collide: incremental `market-trackers sync` still only
   ever moves its own watermark forward from wherever it last stopped, and backfilling old
   ground can't regress it (see "Never regresses the live watermark" below).
4. A chunk that completes (reaches its end date with no error and without exhausting the
   budget) advances `backfill.completedThrough` to that chunk's end date and moves on. A chunk
   that errors, or reports it stopped on `--limit`, stops that source's walk **without**
   advancing past it — so the next run retries that same chunk instead of skipping it.
5. Re-running `market-trackers backfill` with the same (or an earlier) `--from` skips ahead to the day
   after `backfill.completedThrough` automatically. Pass a `--from` that's already fully
   covered and the source reports zero chunks — a safe, cheap no-op. To re-walk covered ground
   anyway, pass `--full`: it ignores the `backfill.completedThrough` resume watermark for this
   run (idempotent upserts make the re-walk duplicate-free).
6. **One source failing never stops the others.** Sources are walked one at a time and each
   source's own chunk loop is isolated — an error on `edgar`'s third chunk still lets `finra`
   and `usaspending` run their full windows in the same invocation.

### Sources that don't support backfill

A few sources replace their table wholesale on every sync instead of walking by date:
`congress-legislators` ingests **current state** (committee assignments as of right now, not a
history of who sat on what), and `patentsview` ingests a **whole-history bulk release** (the
quarterly USPTO Open Data Portal product — one completed sync already covers 1976→present).
Backfilling either is a no-op by construction: `market-trackers backfill` skips it with an explanatory
note and reports it as trivially complete rather than pretending a chunked date walk means
anything for it.

A source that's still a scaffold (not yet implemented — `market-trackers status` shows these) simply
no-ops each chunk, the same way `market-trackers sync --source <scaffold>` already does.

### Single-pass sources

One step short of "skip entirely": a source whose whole free history arrives in one small
whole-feed fetch (`federalreserve` — the Board's JSON feeds ARE the coverage) isn't skipped,
but it isn't date-chunked either. `market-trackers backfill --source federalreserve` runs the window
as **one** `[from, to]` chunk — the same full-feed pass daily `market-trackers sync` performs — because
chunking would just repeat the identical fetch once per chunk. The run is still recorded and
resumable like any other (`SINGLE_PASS_SOURCES` in `packages/core/src/backfill/engine.ts`).

### Never regresses the live watermark

Every date-walking source (`edgar`, `finra`, `senate-efd`, `house-clerk`, `lda`,
`usaspending`) only ever advances its **own** incremental watermark forward — never backward,
even when a bounded backfill chunk walks ground far behind where regular `market-trackers sync` has
already reached. That guarantee is what makes it safe to backfill 2015 data on a store whose
live watermark is already at last week: the incremental watermark stays at last week, and the
next plain `market-trackers sync` still just picks up from there — it never re-discovers a multi-year
gap and re-walks it.

## Per-source free-history depth

How far back each source's free primary API or bulk index actually goes — **[verify-live]**
against the source itself before relying on it for a real archive; these are working
estimates, not guarantees, and some sources thin out (or change shape) well before their
earliest technically-available record:

| Source             | Free history depth (approx.)     | Notes                                                                                                                        |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `edgar`            | Daily index back to ~1994        | EDGAR's full-text/daily index starts with EDGAR itself; forms and coverage thinned in the earliest years.                    |
| `lda`              | ~1999                            | Senate LDA filings are electronic from the database's start; pre-1999 paper filings aren't in the API.                       |
| `usaspending`      | ~2000s (contracts and grants)    | USAspending's own historical coverage improves markedly after ~2008; earlier award records exist but are sparser.            |
| `finra`            | ~2009                            | Reg SHO daily short-sale volume files begin in the late 2000s.                                                               |
| `senate-efd`       | ~2012                            | Senate electronic Periodic Transaction Report filing began in 2012; paper-era trades aren't covered.                         |
| `house-clerk`      | ~2008                            | House financial disclosure e-filing (and the Clerk's online index) is reliable from roughly this point.                      |
| `cftc`             | Decades (Commitments of Traders) | The CFTC's public reporting API serves the legacy futures-only report far back; earliest decades are [verify-live].          |
| `patentsview`      | 1976 → present, in one sync      | The quarterly ODP bulk release replaces the whole grant history; backfill skips it — a plain `sync` already ingests it all.  |
| `clinicaltrials`   | ~2000 (registrations)            | ClinicalTrials.gov registrations begin with the registry itself (2000); early records are sparse and unevenly maintained.    |
| `openfda`          | ~1939 (Drugs@FDA records)        | Drugs@FDA carries approval records for very old applications; completeness and dating conventions vary widely by era.        |
| `wikimedia`        | 2015-07-01 (pageviews API)       | The per-article pageviews API starts 2015-07-01; there is no earlier per-article daily data in this API.                     |
| `govinfo`          | 113th congress (2013)            | Bulk BILLSTATUS coverage begins with the 113th congress; older congresses need a not-yet-existing config knob to target.     |
| `fec`              | Cycles back to 1980              | Bulk files exist per two-year cycle; the source currently syncs the current cycle only (per-cycle history is future config). |
| `govinfo-hearings` | Sitemaps back to ~1997           | The CHRG sitemap index lists year sitemaps to the late 1990s; a package can surface under its publication year — walk wide.  |
| `federalreserve`   | Feed depth is [verify-live]      | The Board's JSON feeds are the coverage; single-pass backfill (one full-feed chunk), no archive-page scraping.               |

`congress-legislators` is current-state and `patentsview` is a whole-history quarterly release
(each replaces its dataset on sync); neither has a backfill-relevant date walk.
`federalreserve` re-reads its whole feeds every sync, so backfill runs it as a single-pass
chunk (see above) rather than a date walk.

## Running it in CI

`.github/workflows/backfill.yml` is `workflow_dispatch`-only (Actions tab → "Backfill" → "Run
workflow") — deep backfills are deliberate, not scheduled. Inputs: `source`, `from`, `to`
(optional, defaults to today), `chunk_days` (default 30), `limit` (optional).

The job: build → `market-trackers backfill --source <source> --from <from> [--to <to>] --chunk-days
<chunk_days> [--limit <limit>] --db backfill-{source}.db --json` (using `vars.MARKET_TRACKERS_CONTACT`
for the EDGAR User-Agent when `source: edgar`) → `market-trackers export --db backfill-{source}.db --out
dumps --snapshots-only` (only the year-shard snapshots below get archived, so deltas/latest.json/
feed.xml/entity feeds aren't worth producing here) → uploads `dumps/` as a 30-day run artifact →
if `vars.ALT_DATASETS_REPO` and `secrets.ALT_DATASETS_TOKEN` are both configured, publishes the
run's year-shard snapshot files as release assets in the data repo (see below). The job fails
(after all of the above still runs) when the backfill didn't fully reach `--to`, printing the
resume hint — re-dispatch with the same `source`/`from` to continue.

**GitHub Actions caps a job at 6 hours.** A window spanning many years — especially for a
daily-granularity source like `edgar` or `finra` — can exceed that easily. Dispatch large
backfills in **year-sized (or smaller) windows** rather than one multi-decade run: each
dispatch is its own job with its own 6-hour budget, and because progress is resumable, a
window that itself runs long simply continues on the next dispatch. There's no cost to
splitting further than a single job needs — resuming an already-complete window is a fast
no-op (see "The chunk/resume model" above).

## The archive-release layout

Each configured CI run tags a GitHub Release in the data repository (`vars.ALT_DATASETS_REPO`)
as:

```
archive-{source}-{from}-{to}
```

using the run's _actual_ resolved `from`/`to` (from the backfill JSON summary — so an omitted
`--to` resolves to the real date it defaulted to, not left blank). The release's assets are
that run's `snapshot-{YYYY}.json.gz` files — the same year-sharded, gzipped full-dataset
snapshots `market-trackers export` always produces (see [`docs/market-trackers-data.md`](market-trackers-data.md)), one
release note explaining the source and window. Re-dispatching the same window (e.g. resuming
after a timeout, or re-running to pick up a parser fix) reuses the same release and replaces
same-named assets rather than creating duplicates.

A single asset over GitHub's 2GB release-asset limit is reported and **skipped**, never
aborting the rest of the run — the workflow's own note tells you which asset and suggests
either a manual publish (checkout the data repo and add it directly, the same as any human
edit there — see [`docs/market-trackers-data.md`](market-trackers-data.md) — "Only CI writes") or re-dispatching
that window in smaller slices so each year's shard stays under the limit.

This archive is deliberately separate from the daily `publish-dumps.yml` publish: that
workflow keeps the data repo's live layout (`<exportDir>/<year>/<day>.json`, `latest.json`,
one rolling `snapshot.json.gz`) current; backfill releases are dated snapshots of exactly what
one deep-history run produced, kept alongside it as GitHub Releases rather than committed
into the live tree.

## Restoring from an archive

`market-trackers import` is the mirror image of `market-trackers export` — the published dumps (daily or
backfill-archived) are the durable, rebuildable copy of the store, by design (see
[`docs/market-trackers-data.md`](market-trackers-data.md)).

- **From a data-repo checkout** (the live layout, or a clone at an old commit):

  ```bash
  git clone https://github.com/<owner>/market-trackers-data
  market-trackers import market-trackers-data --db restored.db
  ```

  Walks every dataset's `exportDir`, importing every delta and snapshot file it finds — safe
  to run repeatedly (upserts by natural key).

- **From downloaded release assets** (a `backfill.yml` archive release, or a manually-saved
  snapshot): download the `snapshot-*.json.gz` file(s) you want, then import each one with an
  explicit `--dataset` — a bare downloaded file's path can't tell `market-trackers import` which
  dataset it belongs to the way a data-repo checkout's directory structure can:

  ```bash
  market-trackers import snapshot-2015.json.gz --dataset gov-grants --db restored.db
  ```

  Run it once per file (and per dataset, if the release bundles more than one dataset's
  shards); order doesn't matter, and importing the same file twice is a no-op the second time.

Either way, the result is a store indistinguishable from one built by running the original
sources live — same rows, same provenance, same schema — because that's exactly what the
published dumps contract guarantees.

## Known gaps

- EDGAR backfill here still walks the daily index one day at a time, same as incremental sync
  — there's no bulk-file (`Archives/edgar/full-index/*.zip`) fast path (see the note in
  `docs/sources/edgar.md`). It works, and is resumable, but a deep EDGAR backfill makes
  roughly one request per trading day plus one per filing — budget CI dispatch windows (and
  `--chunk-days`) accordingly.
