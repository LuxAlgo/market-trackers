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
  <YYYY>/<YYYY-MM-DD>.json   # daily delta: rows ingested on that UTC day
  latest.json                # byte-identical mirror of the newest daily delta
  snapshot.json.gz           # the entire dataset, gzipped
manifest.json                # row counts, watermarks, per-source health, schemaVersion
```

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

`snapshot.json.gz` — the full dataset as one gzipped JSON array — is rewritten on **every**
export, i.e. daily under the publish schedule. There is no separate weekly/monthly cadence:
deltas serve the tail, the snapshot serves cold starts, and the manifest says how fresh both
are. (`docket export --no-snapshot` exists for local delta-only runs; the publish workflow
always writes snapshots.)

## The manifest

`manifest.json` at the repo root is the trust surface — check it before relying on freshness:

| Field                                             | Meaning                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `generatedAt`                                     | ISO-8601 timestamp of the export.                                         |
| `schemaVersion`                                   | The published record-shape version (see policy below).                    |
| `datasets.<id>.title` / `.exportDir`              | Human title and the directory documented above.                           |
| `datasets.<id>.rows`                              | Total row count in the snapshot.                                          |
| `datasets.<id>.lastIngestedAt`                    | Newest `retrievedAt` in the dataset (null when empty).                    |
| `datasets.<id>.stale`                             | True when the dataset is older than its freshness window.                 |
| `sources.<id>.implementedDatasets`                | Which datasets this source can produce.                                   |
| `sources.<id>.lastSyncOk` / `.lastSyncAt`         | Outcome and start time of the newest sync run (null before the first).    |
| `sources.<id>.lastCanaryStatus` / `.lastCanaryAt` | Newest canary verdict (`green`/`amber`/`red`/`skip`) and when.            |
| `sources.<id>.watermarks`                         | The per-source incremental cursors (e.g. last completed EDGAR index day). |

## `schemaVersion` policy

`SCHEMA_VERSION` lives in `packages/core/src/schema/datasets.ts` and is recorded in every
manifest. It bumps **whenever a published record shape changes** — a field added, removed,
renamed, or re-typed in any dataset's exported rows (the zod schemas are the source of truth;
see CONTRIBUTING.md). Consumers should pin the major behavior on it: same `schemaVersion` means
previously written parsers keep working. Internal changes that don't alter published rows do
not bump it.

## Only CI writes

The data repository has exactly one writer: the `publish-dumps.yml` workflow in this repo,
committing as `docket-publish[bot]`. It rsyncs the export output with `--delete` (so files
removed from the layout disappear) while excluding `.git`, `README.md`, and `LICENSE` — those
two are installed from `templates/docket-data/` only when missing and then left to humans.
Human pull requests to data files in the data repo are closed on principle: a wrong row is a
parser or fixture bug in this repository, and the fix flows into the next publish. This is what
keeps every published row backed by a parser, a golden test, and a provenance link — instead of
a hand edit nobody can audit.
