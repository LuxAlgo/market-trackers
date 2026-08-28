# Fixture: case-odp-quarterly-2026

One synthetic USPTO Open Data Portal quarterly release of the PatentsView
granted-patent product (`PVGPATDIS`), small enough to hand-verify row by row:
the product metadata response, the three per-table zips the ingestor
downloads, and the exact rows the sync must emit (`expected.json`).

## How the ZIPs were assembled

The three plain-text TSV bodies (`g_patent.tsv`, `g_assignee_disambiguated.tsv`,
`g_cpc_current.tsv`) were written with PatentsView's published column names
(one header row, tab-separated, quoted-field dialect for values carrying tabs,
quotes, or newlines) and each was zipped alone into its own single-entry
archive with Python's standard `zipfile` module:

```python
import zipfile

with zipfile.ZipFile("g_patent.tsv.zip", "w") as zf:
    info = zipfile.ZipInfo("g_patent.tsv", date_time=(2026, 7, 15, 9, 37, 53))
    info.compress_type = zipfile.ZIP_DEFLATED  # ZIP_STORED for g_cpc_current
    zf.writestr(info, body.encode("utf-8"))
```

`zipfile` is a different implementation from this source's fflate-based
streaming reader (`packages/core/src/sources/patentsview/tsv-zip.ts`), so a
successful parse is a cross-implementation check, not a round-trip of the
reader's own output. `g_cpc_current.tsv.zip` is deliberately STORED
(method 0) while the other two are DEFLATED (method 8); the reader must
handle both.

## product-metadata.json

The live response envelope (`{count, bulkDataProductBag: [{...,
productFileBag: {count, fileDataBag: [...]}}]}`, shape captured live via the
verify-live workflow) with `lastModifiedDateTime: "2026-07-15 09:37:53"`,
the release stamp the watermark records. The file bag leads with two decoy
entries (`PV_grant_data_dictionary.pdf`, `clustering_resources.zip`, the
latter with a fake multi-GB size) so tests prove selection is by `fileName`,
never by bag position, and that non-table files are never downloaded. Table
`fileSize` values are the real byte sizes of the checked-in zips.

`product-metadata-drift.json` is the drift case: a 200 whose file rows
renamed the extracted fields (`documentName`/`documentDownloadURI`), so zero
entries survive extraction; the sync must raise `OdpProductDriftError`, not
report an empty product. `error-401.json` / `error-404.json` are the live
error bodies for an unauthorized request and a nonexistent product id.

## g_patent.tsv: 7 data rows, 5 emitted + 1 withdrawn + 1 malformed

| #   | patent_id | notes                                                                                                                                        |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 11900001  | Mapped assignee by exact name (Microsoft Corporation → MSFT); CPC sequence 0 wins over a sequence-1 row that appears FIRST in g_cpc_current. |
| 2   | 11900002  | Quoted title with escaped quotes plus an embedded newline and tab; unmapped assignee → `tickers: []`; lowercase `h05` uppercased.            |
| 3   | 11900003  | No assignee rows, no CPC rows, empty `wipo_kind` → `name: null`, `assigneeCount: 0`, `kind: null`, `cpcClass: null`.                         |
| 4   | D1023456  | Design patent, 2 assignees: sequence 0 is an individual, sequence 1 the organization; org wins by sequence (Northrop Grumman → NOC).        |
| 5   | 11900004  | **Withdrawn** (`withdrawn = 1`): parses fine, never emitted; the sync notes it instead.                                                     |
| 6   | RE50123   | Reissue id shape; suffix-stripped map hit (International Business Machines Corporation → IBM); sequence-0 CPC row has an empty `cpc_class`.  |
| 7   | 11900006  | **Malformed**: `patent_date` is `not-a-date` → the whole row is a parse failure and is skipped.                                              |

## g_assignee_disambiguated.tsv / g_cpc_current.tsv

The assignee file lists D1023456's sequence-1 organization row BEFORE its
sequence-0 individual row (sequence, not file order, decides "first-listed"),
carries an assignee for the withdrawn patent (never consulted), and ends with
a row missing `patent_id`, the one "unusable row" the sync must count in its
notes. The CPC file likewise lists 11900001's sequence-1 row first, and gives
RE50123 an empty `cpc_class` at sequence 0 so the mapping must take the first
*present* class.
