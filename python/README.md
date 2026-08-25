# alt-datasets (Python)

A small, dependency-light reader for [LuxAlgo Alt Data](https://github.com/LuxAlgo/alt-data)'s published
dumps — the public record of US markets (congress trades, insider filings, 13F holdings,
government contracts and grants, lobbying, short-sale volume, committee assignments, patents,
clinical trials, FDA events, CFTC positioning) published as free CC0 JSON at
[LuxAlgo/alt-datasets](https://github.com/LuxAlgo/alt-datasets), with per-row primary-source
provenance.

This package reads those dumps. It computes nothing — no scores, no signals, no predictions.
Stdlib only; pandas is an optional extra.

## Install

```bash
pip install alt-datasets          # stdlib only
pip install alt-datasets[pandas]  # + to_dataframe()
```

## Quick start

```python
from alt_datasets import load_manifest, load_snapshot, to_dataframe

ROOT = "https://raw.githubusercontent.com/LuxAlgo/alt-datasets/main"

manifest = load_manifest(ROOT)
print(manifest["schemaVersion"], manifest["generatedAt"])
for dataset_id, info in manifest["datasets"].items():
    print(dataset_id, info["rows"], "rows, stale:", info["stale"])

# The whole congressional-trades dataset, resolved through the manifest — works
# whether the dataset is small enough for one combined snapshot file, or big
# enough to need year-sharded files; either way you get one flat list back.
rows = load_snapshot(ROOT, dataset="congress-trades")
print(len(rows), "congress-trades rows")

df = to_dataframe(rows)  # requires the [pandas] extra
print(df.head())
```

## Loading one file directly

Every file in the layout — a daily delta, `latest.json`, or a specific
`snapshot-YYYY.json.gz` shard — is also just a URL (or local path) you can hand to
`load_snapshot` directly, with no `dataset=`:

```python
from alt_datasets import load_snapshot

latest = load_snapshot(
    "https://raw.githubusercontent.com/LuxAlgo/alt-datasets/main/insider/transactions/latest.json"
)
print(len(latest), "new insider transactions in the newest delta")

one_day = load_snapshot(
    "https://raw.githubusercontent.com/LuxAlgo/alt-datasets/main/congress/trades/2026/2026-08-24.json"
)

# A local alt-datasets checkout works identically — no scheme needed.
local = load_snapshot("/path/to/alt-datasets/short-volume/daily/latest.json")
```

## What this does not do

- It does not fetch prices, compute returns, or join anything. See the
  [analytics module](https://github.com/LuxAlgo/alt-data/blob/main/docs/analytics.md) in the
  main LuxAlgo Alt Data package (TypeScript) for the bring-your-own-prices arithmetic, or see
  [`notebooks/`](https://github.com/LuxAlgo/alt-data/tree/main/notebooks) in that repo for the
  equivalent worked in plain pandas once you have `rows` here.
- It does not cache, retry, or rate-limit — each call makes one plain HTTP GET (via
  `urllib`) or one local file read. For heavy or repeated use, clone
  [LuxAlgo/alt-datasets](https://github.com/LuxAlgo/alt-datasets) and pass local paths instead
  of URLs — both work identically.
- It does not validate row shapes against LuxAlgo Alt Data's schemas — rows are returned exactly as
  published. See
  [docs/alt-datasets.md](https://github.com/LuxAlgo/alt-data/blob/main/docs/alt-datasets.md) in
  the main repo for the published-record contract, and
  [docs/sources/](https://github.com/LuxAlgo/alt-data/tree/main/docs/sources) for what each
  dataset's fields mean.

## Every row has receipts

Every row carries a `provenance.sourceUrl` — a deep link to the primary document (the SEC
filing, the disclosure, the daily file) it was parsed from:

```python
for row in rows[:5]:
    print(row["provenance"]["sourceUrl"])
```

## Running the tests

```bash
python3 -m unittest discover python/tests
```

Fully offline, against fixture files checked into `python/tests/fixtures/` — no network
access, no live dumps repo required.

## License

MIT for this reader. The data itself (at alt-datasets) is CC0 — public domain, no attribution
required.
