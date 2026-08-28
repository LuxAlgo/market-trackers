# Fixture: case-cycle-2026

One synthetic 2026 election cycle, small enough to hand-verify row by row, covering
every code path `fec-bulk@1` needs to prove: both files' happy paths, both files'
parse-failure paths, the master-file joins (both hit and miss), and the
date/amount edge cases the parser must handle (blank date → null, a garbage
non-blank number on a nullable field → null, a negative "refund" amount kept
negative, a blank party, and a district-less Senate/President row).

## How the ZIPs were assembled

1. The four plain-text bodies (`weball26.txt`, `itpas2.txt`, `cn.txt`, `cm.txt`)
   were built as literal pipe-joined rows (one Python list of field values per
   row, `"|".join(...)`, no header line) matching the column layouts documented
   in `packages/core/src/sources/fec/fields.ts` ([verify-live] there).
2. Each body was then zipped alone into its own archive with Python's standard
   `zipfile` module (`ZipFile.writestr` with `compress_type=ZIP_DEFLATED`), one
   entry per archive, matching the real bulk-download convention of one data
   file per cycle-file ZIP:
   `weball26.zip→weball26.txt`, `pas226.zip→itpas2.txt`, `cn26.zip→cn.txt`,
   `cm26.zip→cm.txt`.
3. `zipfile` is a different implementation from this project's own
   `packages/core/src/sources/fec/zip.ts` reader, so these fixtures double as a
   cross-implementation check on the reader, not just a round-trip of its own
   output.

## weball26.txt: 6 rows, 5 valid candidates + 1 malformed

| # | CAND_ID     | office | notes                                                                 |
|---|-------------|--------|------------------------------------------------------------------------|
| 1 | H6VT01234   | H      | Matches `makeFecCandidate()` in test-helpers.ts exactly.              |
| 2 | S6CA00123   | S      | Senate: blank CAND_OFFICE_DISTRICT → `district: null`.                |
| 3 | P60003456   | P      | President: `CAND_OFFICE_ST = "US"`, blank district.                   |
| 4 | H2NY00111   | H      | Blank PTY_CD/CAND_PTY_AFFILIATION → `party: null`; blank TTL_RECEIPTS → `totalReceipts: null`; blank CVG_END_DT → `coverageEndDate: null`. |
| 5 | S4TX00222   | S      | TTL_DISB = `"N/A"` (garbage, non-blank) → `totalDisbursements: null`, not a thrown row; the field is nullable. |
| 6 | Z6AZ00333   | (none) | **Malformed**: first character of CAND_ID is `Z`, not H/S/P → the whole row is a parse failure and is skipped. |

## itpas2.txt: 10 rows, 8 valid contributions + 2 malformed

| # | SUB_ID (id)           | CMTE_ID   | CAND_ID   | amount   | notes |
|---|------------------------|-----------|-----------|----------|-------|
| A | 4082220261234567890   | C00123456 | H6VT01234 | 5000     | Matches `makeFecContribution()` exactly. |
| B | 4082220261234567891   | C00987654 | S6CA00123 | 2500.75  | Decimal amount. |
| C | 4082220261234567892   | C00123456 | H6VT01234 | -500.00  | **Refund**: negative amount kept negative, as filed. Transaction type `24R` here is illustrative synthetic data for this scenario; it is not verified against the live FEC transaction-type code table ([verify-live]). |
| D | 4082220261234567893   | C00987654 | P60003456 | 10000    | Blank TRANSACTION_DT → `date: null`. |
| E | 4082220261234567894   | C00555555 | H2NY00111 | 750      | `C00555555` is **not** in `cm.txt` → `committeeName: null` (candidate still resolves). |
| F | 4082220261234567895   | C00123456 | S4TX00222 | 1200.50  | Ordinary row for volume/variety. |
| G | 4082220261234567896   | C00987654 | H6VT01234 | 300      | Same committee/candidate pair as A, a second transaction. |
| H | 4082220261234567897   | C00123456 | H9WA00777 | 400      | `H9WA00777` is **not** in `cn.txt` → `candidateName: null` (committee still resolves). |
| I | 4082220261234567898   | C00123456 | *(blank)* | 100      | **Malformed**: CAND_ID is blank (required) → the whole row fails. |
| J | 4082220261234567899   | C00123456 | H6VT01234 | `"abc"`  | **Malformed**: TRANSACTION_AMT is non-numeric garbage on a *required* field → the whole row fails (contrast with weball row 5, where the same kind of garbage sits on a *nullable* field and degrades to `null` instead). |

## cn.txt / cm.txt: masters, deliberately incomplete

`cn.txt` carries names for `H6VT01234`, `S6CA00123`, `P60003456`, `H2NY00111`,
`S4TX00222` (every valid weball candidate) but **not** `H9WA00777`, so
contribution row H's join misses on purpose.

`cm.txt` carries names for `C00123456` ("EXAMPLE INDUSTRY PAC") and `C00987654`
("EXAMPLE LEADERSHIP PAC") but **not** `C00555555`, so contribution row E's join
misses on purpose.

Both masters, and the weball file, are unrelated to any real FEC filer; every
id and name here is invented for this fixture.
