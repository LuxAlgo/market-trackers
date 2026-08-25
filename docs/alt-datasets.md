# alt-datasets: the published-dump contract

This is the producer-side design doc for
[LuxAlgo/alt-datasets](https://github.com/LuxAlgo/alt-datasets) — the public repository the daily
publish workflow writes LuxAlgo Alt Data's JSON dumps into. The consumer-facing landing page lives in the
data repo itself (installed from [`templates/alt-datasets/`](../templates/alt-datasets/) on first
publish); this document pins down the contract the exporter
(`packages/core/src/export/writer.ts`) and the publish workflow guarantee.

## Layout contract

Every dataset exports into its own directory (the `exportDir` in
`packages/core/src/schema/datasets.ts`), all with the same shape:

```
<exportDir>/
  <YYYY>/<YYYY-MM-DD>.json    # daily delta: rows ingested on that UTC day
  latest.json                 # byte-identical mirror of the newest daily delta
  feed.xml                    # RSS over the same rows latest.json mirrors (see Feeds below)
  snapshot-<YYYY>.json.gz     # the dataset, gzipped, sharded by event year (see Snapshot cadence)
  snapshot.json.gz            # small datasets also get one combined-history file
manifest.json                 # row counts, watermarks, per-source health, schemaVersion
```

(Each `.json.gz` above also gets a `.parquet` sibling — see Parquet siblings below.)

| Dataset id              | `exportDir`               |
| ----------------------- | ------------------------- |
| `congress-trades`       | `congress/trades`         |
| `insider-transactions`  | `insider/transactions`    |
| `thirteenf-holdings`    | `thirteenf/holdings`      |
| `gov-contracts`         | `contracts/awards`        |
| `gov-grants`            | `grants/awards`           |
| `lobbying-filings`      | `lobbying/filings`        |
| `short-volume`          | `short-volume/daily`      |
| `committee-assignments` | `congress/committees`     |
| `patents`               | `patents/grants`          |
| `clinical-trials`       | `clinical-trials/studies` |
| `fda-approvals`         | `fda/approvals`           |
| `cot-reports`           | `cot/legacy-futures`      |
| `wiki-pageviews`        | `wiki/pageviews`          |
| `bills`                 | `congress/bills`          |
| `fec-candidates`        | `fec/candidates`          |
| `fec-contributions`     | `fec/contributions`       |

Files are single-line JSON arrays with a trailing newline. Rows are emitted in id order and one
JSON shape, so re-exports are byte-stable and the data repo's diffs stay reviewable. Every row
is a zod-validated dataset record carrying `provenance` (`source`, `sourceUrl`, `retrievedAt`,
`parser`, `confidence`, `needsReview`). Writes are atomic (write to a temp file, then rename) —
a crashed export never leaves a half-written file behind.

## Delta semantics

- Deltas are bucketed by **ingestion day** — the UTC day LuxAlgo Alt Data ingested the row — not by the
  event or filing date. `2026/2026-08-24.json` answers "what did the pipeline learn on
  2026-08-24", which is the right unit for consumers tailing the feed; event-time queries
  belong on the snapshot.
- **Recent days are rewritten; older days are immutable.** Rows keep landing on the current
  day (and upserts can revise rows ingested just before), so each export rewrites the delta
  files of the last `rewriteRecentDays` days — default 2, i.e. today and the two preceding UTC
  days. A delta file older than that is never rewritten once it exists (a missing older file is
  still written, e.g. after a backfill).
- `latest.json` is re-pointed at the newest ingestion day on every export — one stable URL for
  "give me the newest delta" consumers.
- A day with no ingested rows simply has no file; consumers must treat missing days as empty,
  not as errors.

## Snapshot cadence

The full dataset, gzipped, is rewritten on **every** export, i.e. daily under the publish
schedule — there is no separate weekly/monthly cadence. It's sharded by event year
(`snapshot-<YYYY>.json.gz`, one per year with any rows) so no single file grows unbounded; a
dataset under the exporter's combined-snapshot row cap (200k rows by default) additionally gets
one convenience `snapshot.json.gz` with every year concatenated, for consumers who'd rather fetch
one URL than reassemble shards. Deltas serve the tail, snapshots serve cold starts, and the
manifest says how fresh both are. (`alt-data export --no-snapshot` exists for local delta-only
runs, and is what the intraday fast lane uses — see `docs/operations.md`; the daily publish
workflow always writes snapshots.)

## Feeds (RSS)

Every dataset directory also carries a `feed.xml` — RSS 2.0 over the same rows `latest.json`
mirrors (the newest ingestion day, newest-first, capped at 100 items), rewritten alongside it on
every export (the exporter's `feeds` option defaults to on; there is no CLI flag to disable it —
only the programmatic `exportDumps({ feeds: false })`, which today only local/test callers use).
It exists so anything that already watches feeds — a reader, an alerting rule, a script polling
one URL — gets zero-infrastructure notice of new rows without polling the JSON and diffing it by
hand.

Each `<item>` is a strictly factual, dataset-specific one-line restatement of the row (see the
per-dataset titlers in `packages/core/src/export/feeds.ts`) with a `<link>` to the row's
`provenance.sourceUrl` — the primary-source document, not a summary of it — and a stable
`<guid isPermaLink="false">` of `{datasetId}:{rowId}`. A dataset with zero ingested rows in its
history has no `latest.json` and no `feed.xml` yet, same as the delta-file convention above.

## Parquet siblings

`snapshot.json.gz` and each year-sharded `snapshot-<YYYY>.json.gz` (see above) get a `.parquet`
sibling in the same directory — `snapshot.parquet`, `snapshot-<YYYY>.parquet` — written by
`scripts/make-parquet.mjs` via DuckDB immediately after export, for consumers who'd rather point
DuckDB/pandas/polars/Spark at a columnar file than parse gzipped JSON. They are not written by
the exporter itself (`packages/core/src/export/writer.ts` has no DuckDB dependency and knows
nothing about Parquet) — they are a post-export conversion step the publish workflow runs, and
they degrade gracefully: a dataset can legitimately have snapshots but no `.parquet` siblings yet
if that step's DuckDB install didn't succeed on a given run (see `docs/operations.md`).

Row content is identical to the JSON; column _types_ are inferred by DuckDB from the JSON at
conversion time rather than pinned from the zod schemas, so treat the JSON as the canonical,
exact representation of a dataset and the Parquet files as a best-effort mirror of it. Deltas and
`latest.json` are not mirrored to Parquet — only the full-history snapshots, which is where a
columnar format earns its keep.

## The manifest

`manifest.json` at the repo root is the trust surface — check it before relying on freshness:

| Field                                             | Meaning                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generatedAt`                                     | ISO-8601 timestamp of the export.                                                                                                                                                                    |
| `schemaVersion`                                   | The published record-shape version (see policy below).                                                                                                                                               |
| `datasets.<id>.title` / `.exportDir`              | Human title and the directory documented above.                                                                                                                                                      |
| `datasets.<id>.rows`                              | Total row count in the snapshot.                                                                                                                                                                     |
| `datasets.<id>.lastIngestedAt`                    | Newest `retrievedAt` in the dataset (null when empty).                                                                                                                                               |
| `datasets.<id>.stale`                             | True when the dataset is older than its freshness window.                                                                                                                                            |
| `datasets.<id>.snapshots`                         | `[{ file, rows }, ...]` for this export's snapshot shard(s) — see Snapshot cadence above. Empty when the export ran with no snapshots (e.g. the fast lane's `--no-snapshot`), regardless of dataset. |
| `datasets.<id>.feed`                              | `<exportDir>/feed.xml` when the dataset has any rows, else `null`. Not a Parquet field — Parquet siblings aren't tracked in the manifest at all (see Parquet siblings above).                        |
| `sources.<id>.implementedDatasets`                | Which datasets this source can produce.                                                                                                                                                              |
| `sources.<id>.lastSyncOk` / `.lastSyncAt`         | Outcome and start time of the newest sync run (null before the first).                                                                                                                               |
| `sources.<id>.lastCanaryStatus` / `.lastCanaryAt` | Newest canary verdict (`green`/`amber`/`red`/`skip`) and when.                                                                                                                                       |
| `sources.<id>.watermarks`                         | The per-source incremental cursors (e.g. last completed EDGAR index day).                                                                                                                            |

## `schemaVersion` policy

`SCHEMA_VERSION` lives in `packages/core/src/schema/datasets.ts` and is recorded in every
manifest. It bumps **whenever a published record shape changes** — a field added, removed,
renamed, or re-typed in any dataset's exported rows (the zod schemas are the source of truth;
see CONTRIBUTING.md). Consumers should pin the major behavior on it: same `schemaVersion` means
previously written parsers keep working. Internal changes that don't alter published rows do
not bump it.

## The bundled explorer

[`templates/alt-datasets/explorer/index.html`](../templates/alt-datasets/explorer/index.html) is
a single, self-contained static page (no build step, no external assets) that browses the
published dumps client-side: it fetches `manifest.json`, renders a table of every dataset with
links to its `latest.json`/`feed.xml`/snapshots, and lets a visitor pick a dataset and filter
its `latest.json` rows, each linking its `provenance.sourceUrl`. It resolves `manifest.json`
path-relatively (`../manifest.json`, with a same-directory fallback) so it works wherever the
data repo is served — a raw checkout, `python3 -m http.server`, or GitHub Pages — and reads
`prefers-color-scheme` for dark/light.

`publish-dumps.yml` installs it into the data repo at `explorer/index.html` and refreshes it
whenever the template here changes, as its own commit after the day's data commit. Unlike
`README.md`/`LICENSE` (installed only when missing, then left to humans), the explorer is code
owned by this repository: hand-edits to it in the data repo get overwritten by the next refresh
— changes belong in the template here. The daily dumps rsync excludes `/explorer` from its
`--delete` (the exporter never produces that directory, so without the exclusion every publish
would delete it and re-commit it minutes later). If GitHub Pages is enabled on the data repo
(plain root-folder configuration, no build step), the explorer is served at `/explorer/`
alongside the raw data files it reads.

## Only CI writes

The data repository has exactly one writer: the `publish-dumps.yml` workflow in this repo,
committing as `alt-data-publish[bot]`. It rsyncs the export output with `--delete` (so files
removed from the layout disappear) while excluding `.git`, `README.md`, `LICENSE`, and
`/explorer` — the first two are installed from `templates/alt-datasets/` only when missing and
then left to humans; the explorer is installed and refreshed from the same templates directory
and stays owned by this repo (see The bundled explorer above).
Human pull requests to data files in the data repo are closed on principle: a wrong row is a
parser or fixture bug in this repository, and the fix flows into the next publish. This is what
keeps every published row backed by a parser, a golden test, and a provenance link — instead of
a hand edit nobody can audit.

`sync-fast.yml` (see `docs/operations.md`) also writes to the data repo between daily publishes,
under the same `alt-data-publish[bot]` identity and the same no-human-edits principle — it is not a
second, independent writer so much as this same CI pipeline running a narrower slice of itself
more often. It never uses `--delete` and never touches `manifest.json`, so it can only add or
update the two fast datasets' delta/feed files; retiring files from the layout, snapshots, the
manifest, and the health board all stay `publish-dumps.yml`'s job alone.
