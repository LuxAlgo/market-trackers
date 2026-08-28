"""Offline tests for alt_datasets, run with plain `python3 -m unittest`.

Every case reads from python/tests/fixtures/ — no network access, no live
alt-datasets checkout required.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make `alt_datasets` importable without installing the package, regardless
# of the current working directory this test is invoked from.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]  # .../python
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from alt_datasets import AltDatasetsError, load_manifest, load_snapshot, to_dataframe  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class LoadManifestTests(unittest.TestCase):
    def test_loads_a_manifest_given_directly(self):
        manifest = load_manifest(str(FIXTURES / "manifest.json"))
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertIn("congress-trades", manifest["datasets"])

    def test_loads_a_manifest_given_the_repo_root(self):
        manifest = load_manifest(str(FIXTURES))
        self.assertEqual(manifest["schemaVersion"], 1)

    def test_rejects_json_that_is_not_a_manifest(self):
        with self.assertRaises(AltDatasetsError) as ctx:
            load_manifest(str(FIXTURES / "bad-shape.json"))
        self.assertIn("manifest", str(ctx.exception))


class LoadSnapshotDirectFileTests(unittest.TestCase):
    def test_reads_a_plain_json_file(self):
        rows = load_snapshot(str(FIXTURES / "congress" / "trades" / "latest.json"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ticker"], "NEWEST")

    def test_reads_a_gzipped_json_file(self):
        rows = load_snapshot(str(FIXTURES / "congress" / "trades" / "snapshot-2026.json.gz"))
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["ticker"] for r in rows}, {"ACME", "OTHR"})

    def test_rejects_a_json_file_that_is_not_an_array(self):
        with self.assertRaises(AltDatasetsError) as ctx:
            load_snapshot(str(FIXTURES / "bad-shape.json"))
        self.assertIn("expected a JSON array", str(ctx.exception))


class LoadSnapshotViaManifestTests(unittest.TestCase):
    def test_uses_the_combined_file_only_when_one_is_listed_not_both(self):
        # The manifest lists snapshot-2026.json.gz AND snapshot.json.gz for
        # congress-trades (mirroring the real exporter for a dataset small
        # enough to have a combined file) — both hold the *same* 2 rows, so
        # reading both would double the count. Only the combined file should
        # be read.
        rows = load_snapshot(str(FIXTURES), dataset="congress-trades")
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["id"] for r in rows}, {"senate:doc-1:0", "house:doc-2:0"})

    def test_concatenates_every_shard_when_there_is_no_combined_file(self):
        rows = load_snapshot(str(FIXTURES), dataset="big-dataset")
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["year"] for r in rows}, {2025, 2026})

    def test_unknown_dataset_raises_and_lists_known_ones(self):
        with self.assertRaises(AltDatasetsError) as ctx:
            load_snapshot(str(FIXTURES), dataset="not-a-real-dataset")
        message = str(ctx.exception)
        self.assertIn("not-a-real-dataset", message)
        self.assertIn("congress-trades", message)

    def test_a_dataset_with_no_snapshot_files_raises_with_a_latest_json_hint(self):
        with self.assertRaises(AltDatasetsError) as ctx:
            load_snapshot(str(FIXTURES), dataset="empty-dataset")
        message = str(ctx.exception)
        self.assertIn("empty-dataset", message)
        self.assertIn("latest.json", message)


class ToDataframeTests(unittest.TestCase):
    def test_converts_rows_or_explains_the_missing_dependency(self):
        rows = [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]
        try:
            import pandas  # noqa: F401
        except ImportError:
            with self.assertRaises(ImportError) as ctx:
                to_dataframe(rows)
            self.assertIn("pandas", str(ctx.exception))
            return
        df = to_dataframe(rows)
        self.assertEqual(len(df), 2)
        self.assertEqual(list(df.columns), ["a", "b"])


if __name__ == "__main__":
    unittest.main()
