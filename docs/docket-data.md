# docket-data: the published-dump contract

This is the producer-side design doc for
[LuxAlgo/docket-data](https://github.com/LuxAlgo/docket-data) — the public repository the daily
publish workflow writes Docket's JSON dumps into. The consumer-facing landing page lives in the
data repo itself (installed from [`templates/docket-data/`](../templates/docket-data/) on first
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

| Dataset id             | `exportDir`            |
| ---------------------- | ---------------------- |
| `congress-trades`      | `congress/trades`      |
| `insider-transactions` | `insider/transactions` |
| `thirteenf-holdings`   | `thirteenf/holdings`   |
| `gov-contracts`        | `contracts/awards`     |
| `lobbying-filings`     | `lobbying/filings`     |
| `short-volume`         | `short-volume/daily`   |

Files are single-line JSON arrays with a trailing newline. Rows are emitted in id order and one
JSON shape, so re-exports are byte-stable and the data repo's diffs stay reviewable. Every row
is a zod-validated dataset record carrying `provenance` (`source`, `sourceUrl`, `retrievedAt`,
`parser`, `confidence`, `needsReview`). Writes are atomic (write to a temp file, then rename) —
a crashed export never leaves a half-written file behind.

## Delta semantics

- Deltas are bucketed by **ingestion day** — the UTC day Docket ingested the row — not by the
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
manifest says how fresh both are. (`docket export --no-snapshot` exists for local delta-only
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

## The data explorer

The data repo can also carry a small static site — built and maintained by a separate effort,
not by this document's exporter/writer code — that browses the published data in a browser
instead of raw JSON/Parquet files. `publish-dumps.yml` copies it in from
`templates/docket-data/explorer/` in this repo whenever that directory exists, as its own commit
after the day's data commit, so the explorer stays in sync with whatever that effort ships
without this repo's export pipeline knowing anything about it. Until it exists, this step is a
no-op — nothing here depends on it, and none of the layout above changes because of it.

If GitHub Pages is enabled on the data repo, this is what it serves: the explorer template is
installed at the data repo's root (alongside `manifest.json`, `README.md`, and the dataset
directories), the same way `README.md`/`LICENSE` are installed from `templates/docket-data/` —
so a plain root-folder Pages configuration just works, with no separate branch or build step.

## Only CI writes

The data repository has exactly one writer: the `publish-dumps.yml` workflow in this repo,
committing as `docket-publish[bot]`. It rsyncs the export output with `--delete` (so files
removed from the layout disappear) while excluding `.git`, `README.md`, and `LICENSE` — those
two are installed from `templates/docket-data/` only when missing and then left to humans.
Human pull requests to data files in the data repo are closed on principle: a wrong row is a
parser or fixture bug in this repository, and the fix flows into the next publish. This is what
keeps every published row backed by a parser, a golden test, and a provenance link — instead of
a hand edit nobody can audit.

`sync-fast.yml` (see `docs/operations.md`) also writes to the data repo between daily publishes,
under the same `docket-publish[bot]` identity and the same no-human-edits principle — it is not a
second, independent writer so much as this same CI pipeline running a narrower slice of itself
more often. It never uses `--delete` and never touches `manifest.json`, so it can only add or
update the two fast datasets' delta/feed files; retiring files from the layout, snapshots, the
manifest, and the health board all stay `publish-dumps.yml`'s job alone.
