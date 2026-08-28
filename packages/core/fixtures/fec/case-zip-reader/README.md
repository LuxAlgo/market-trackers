# Fixture: case-zip-reader

`mixed-methods.zip` is a hand-built, minimal ZIP for unit-testing
`packages/core/src/sources/fec/zip.ts` directly, independent of any real FEC
file shape.

## How it was assembled

Built with Python's standard-library `zipfile` module — a different
implementation from `zip.ts`, so a successful read here is a genuine
cross-implementation check:

```python
import zipfile

with zipfile.ZipFile("mixed-methods.zip", "w") as zf:
    stored = zipfile.ZipInfo("stored.txt")
    stored.compress_type = zipfile.ZIP_STORED
    zf.writestr(stored, b"stored entry content, byte-for-byte, no compression\n")

    deflated = zipfile.ZipInfo("nested/deflated.TXT")
    deflated.compress_type = zipfile.ZIP_DEFLATED
    zf.writestr(deflated, (b"deflate me please. " * 40) + b"\n")
```

Two entries, two compression methods:

- `stored.txt` — compression method 0 (stored/uncompressed), at the archive
  root.
- `nested/deflated.TXT` — compression method 8 (deflate), inside a
  subdirectory and upper-cased extension, to also exercise
  `findZipEntry`'s case-insensitive, path-tolerant basename lookup (the same
  lookup convention `house-clerk/client.ts`'s `extractYearIndexXml` uses).

`expected.json` holds the exact decoded text of each entry, keyed by its full
in-archive name.
