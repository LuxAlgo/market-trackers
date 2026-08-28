# alt-datasets

**Free daily dumps of the public record of US markets.** Congress trades, insider filings,
13F holdings, government contracts and grants, lobbying, short-sale volume, committee
assignments, patents, clinical trials, FDA drug approvals, futures positioning — normalized
JSON (with Parquet siblings), published
here every day by CI from [LuxAlgo/alt-data](https://github.com/LuxAlgo/alt-data). No API keys, no
accounts, no paywall: one URL per file.

Everything here is parsed from **primary sources only** (SEC EDGAR, Senate eFD, the House
Clerk, USAspending, the Senate LDA API, FINRA, the unitedstates/congress-legislators project,
PatentsView, ClinicalTrials.gov, openFDA, the CFTC), and every row carries `provenance` with a
deep link to the primary document it came from.

## Layout

Each dataset lives in its own directory and follows the same shape:

```
<dataset-dir>/
  <YYYY>/<YYYY-MM-DD>.json   # daily delta: rows ingested on that (UTC) day
  latest.json                # the newest daily delta, at a stable URL
  snapshot.json.gz           # the entire dataset, gzipped
manifest.json                # row counts, watermarks, per-source health, schema version
```

| Dataset              | Directory               |
| -------------------- | ----------------------- |
| Congressional trades | `congress/trades/`      |
| Insider transactions | `insider/transactions/` |
| 13F holdings         | `thirteenf/holdings/`   |
| Government contracts | `contracts/awards/`     |
| Lobbying filings     | `lobbying/filings/`     |
| Short-sale volume    | `short-volume/daily/`   |

Delta files are bucketed by **ingestion day**, not event day: `2026/2026-08-24.json` is what
the pipeline ingested on 2026-08-24. Deltas for the most recent days may be rewritten while
late rows are still landing; older delta files are immutable. `snapshot.json.gz` is always the
whole dataset. The root `manifest.json` reports, per dataset, the row count and last-ingested
time, and per source, sync/canary health and watermarks — check it before trusting freshness.

The record shapes are defined by the schemas in
[LuxAlgo/alt-data](https://github.com/LuxAlgo/alt-data); the manifest's `schemaVersion` bumps
whenever a published shape changes.

## Feeds, Parquet, and the explorer

- **Feeds.** Every dataset directory also has a `feed.xml` — RSS 2.0 over its newest rows, each
  item linking straight back to the primary-source document. Point a feed reader (or anything
  that already watches feeds) at it for zero-infrastructure notice of new rows.
- **Parquet.** Every `snapshot*.json.gz` has a `.parquet` sibling with the same rows, for
  DuckDB/pandas/polars/Spark and anything else that would rather read columnar data than parse
  gzipped JSON. Column types there are inferred, not pinned — the JSON stays the exact,
  canonical form of the data.
- **Explorer.** If this repository has an `index.html` at its root (alongside this README), it's
  a small static site for browsing the data in a browser; enable GitHub Pages on this repo,
  pointed at the root, to serve it.

## Written only by CI

Data files in this repository are produced exclusively by the publish workflow in
[LuxAlgo/alt-data](https://github.com/LuxAlgo/alt-data). **Human pull requests to data files are
closed.** If a row is wrong, the fix belongs upstream — in the parsers and golden fixtures of
LuxAlgo/alt-data — so the next publish corrects it here. Please open issues there.

## License

The data in this repository is dedicated to the public domain under
[CC0 1.0 Universal](LICENSE). The underlying records are US-government public records; the
normalized form stays as unencumbered as its sources. Use it for anything, commercial or not,
no attribution required — though a link back helps others find fresh data.

## How to cite

- Cite the dataset as a whole via [`manifest.json`](manifest.json), which records when the
  data was generated, row counts, and per-source health at publish time.
- Cite an individual row via its `provenance.sourceUrl` — a working deep link to the primary
  document (the SEC filing, disclosure, or daily file) the row was parsed from.
