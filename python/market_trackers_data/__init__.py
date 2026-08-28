"""market_trackers_data — a small, dependency-light reader for LuxAlgo Market Trackers's published dumps.

LuxAlgo Market Trackers (https://github.com/LuxAlgo/market-trackers) publishes the public record of US
markets — congressional trades, insider filings, 13F holdings, government
contracts and grants, lobbying, short-sale volume, committee assignments,
patents, clinical trials, FDA events, and CFTC positioning — as free, CC0
JSON dumps with per-row primary-source provenance, published at
https://github.com/LuxAlgo/market-trackers-data.

This package only reads those dumps. It computes nothing: no scores, no
signals, no predictions — LuxAlgo Market Trackers doesn't ship those, and neither does this
reader. It is stdlib-only; pandas is an optional extra, imported lazily only
by `to_dataframe`.
"""

from __future__ import annotations

import gzip
import json
import urllib.request
from typing import Any, Sequence
from urllib.parse import urlparse

__all__ = ["load_snapshot", "load_manifest", "to_dataframe", "TrackerDataError"]

__version__ = "0.1.0"


class TrackerDataError(Exception):
    """Raised for problems reading or interpreting a LuxAlgo Market Trackers dump."""


def _is_url(path_or_url: str) -> bool:
    return urlparse(path_or_url).scheme in ("http", "https")


def _join(base: str, *parts: str) -> str:
    """Joins path/URL segments with '/', tolerating a trailing slash on base
    and on each part."""
    joined = base.rstrip("/")
    for part in parts:
        joined = f"{joined}/{part.strip('/')}"
    return joined


def _read_bytes(path_or_url: str) -> bytes:
    if _is_url(path_or_url):
        with urllib.request.urlopen(path_or_url) as response:  # noqa: S310 — caller-provided URL, read-only GET
            return response.read()
    with open(path_or_url, "rb") as f:
        return f.read()


def _read_json(path_or_url: str) -> Any:
    raw = _read_bytes(path_or_url)
    if path_or_url.endswith(".gz"):
        raw = gzip.decompress(raw)
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise TrackerDataError(f"{path_or_url}: not valid JSON ({exc})") from exc


def load_manifest(path_or_url: str) -> dict[str, Any]:
    """Loads a dumps manifest.json.

    `path_or_url` may point directly at a manifest file (anything ending in
    `.json`), or at the dumps repo root (e.g. a local market-trackers-data checkout,
    or a raw.githubusercontent.com tree URL) — a `manifest.json` is then
    assumed to sit at that root.
    """
    target = (
        path_or_url if path_or_url.rstrip("/").endswith(".json") else _join(path_or_url, "manifest.json")
    )
    manifest = _read_json(target)
    if not isinstance(manifest, dict) or "datasets" not in manifest:
        raise TrackerDataError(f"{target}: does not look like a LuxAlgo Market Trackers manifest.json (missing 'datasets')")
    return manifest


def _snapshot_files(manifest: dict[str, Any], dataset: str) -> tuple[str, list[str]]:
    """Returns (exportDir, files) naming the file(s) that together cover a
    dataset's full snapshot.

    The exporter writes year-sharded `snapshot-YYYY.json.gz` files always,
    plus a combined `snapshot.json.gz` only when the dataset is small enough
    (see docs/market-trackers-data.md) — and when it exists, the combined file
    duplicates every shard's rows. So: prefer the combined file alone when
    the manifest lists one; otherwise every listed shard is needed.
    """
    datasets = manifest.get("datasets", {})
    info = datasets.get(dataset)
    if info is None:
        raise TrackerDataError(f"unknown dataset {dataset!r} — known datasets: {sorted(datasets)}")
    export_dir = info.get("exportDir")
    snapshots = info.get("snapshots") or []
    files = [s["file"] for s in snapshots]
    if "snapshot.json.gz" in files:
        return export_dir, ["snapshot.json.gz"]
    if not files:
        raise TrackerDataError(
            f"dataset {dataset!r} has no snapshot files in this manifest (rows={info.get('rows', 0)}); "
            f"try load_snapshot(f'{{root}}/{export_dir}/latest.json') for the newest delta instead"
        )
    return export_dir, files


def load_snapshot(path_or_url: str, dataset: str | None = None) -> list[dict[str, Any]]:
    """Loads a LuxAlgo Market Trackers dump as a list of row dicts.

    Two ways to call it:

    - A direct file: `load_snapshot(".../congress/trades/latest.json")`, or
      any other `.json`/`.json.gz` delta or snapshot file — read verbatim.
    - A dataset by id, resolved through the manifest:
      `load_snapshot(repo_root, dataset="congress-trades")` reads
      `manifest.json` at `repo_root`, finds that dataset's snapshot file(s)
      (the combined `snapshot.json.gz` when one exists, otherwise every
      year-sharded `snapshot-YYYY.json.gz`), and concatenates their rows.

    Rows are returned exactly as published — this function does not
    validate, reshape, or compute anything over them.
    """
    if dataset is None:
        rows = _read_json(path_or_url)
        if not isinstance(rows, list):
            raise TrackerDataError(f"{path_or_url}: expected a JSON array of rows")
        return rows

    manifest = load_manifest(path_or_url)
    export_dir, files = _snapshot_files(manifest, dataset)
    rows: list[dict[str, Any]] = []
    for file in files:
        chunk = _read_json(_join(path_or_url, export_dir, file))
        if not isinstance(chunk, list):
            raise TrackerDataError(f"{file}: expected a JSON array of rows")
        rows.extend(chunk)
    return rows


def to_dataframe(rows: Sequence[dict[str, Any]]) -> Any:
    """Converts a list of row dicts (as returned by `load_snapshot`) into a
    pandas DataFrame.

    Requires pandas — install with `pip install market-trackers-data[pandas]` or
    `pip install pandas` directly. Imported lazily so the base package stays
    dependency-free for callers who don't need a DataFrame.
    """
    try:
        import pandas as pd
    except ImportError as exc:
        raise ImportError(
            "to_dataframe() requires pandas. Install it with `pip install market-trackers-data[pandas]` "
            "or `pip install pandas`."
        ) from exc
    return pd.DataFrame(list(rows))
