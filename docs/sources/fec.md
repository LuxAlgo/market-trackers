# Source: FEC campaign finance (`fec`)

**Datasets:** `fec-candidates`, `fec-contributions`
**Status:** implemented (`sources/fec/`)
**Auth:** none — keyless bulk-download ZIPs served as plain static files off `fec.gov`.

## Files used

Everything is per two-year election cycle (`{cycle}`, an even year; `{yy}` its last two
digits), under `https://www.fec.gov/files/bulk-downloads/{cycle}/`:

| ZIP              | Entry inside it  | Used for                                                     |
| ---------------- | ---------------- | ------------------------------------------------------------ |
| `weball{yy}.zip` | `weball{yy}.txt` | `fec-candidates` — the "all candidates" summary.             |
| `pas2{yy}.zip`   | `itpas2.txt`     | `fec-contributions` — committee→candidate contributions.     |
| `cn{yy}.zip`     | `cn.txt`         | Candidate master — **join-only**, never stored as a dataset. |
| `cm{yy}.zip`     | `cm.txt`         | Committee master — **join-only**, never stored as a dataset. |

All four are pipe-delimited, headerless text files, one entry per ZIP. `[verify-live]` the base
path and this naming convention (`client.ts`'s URL builders) — this ingestor was built and
tested fully offline (this environment can reach only GitHub); every column position and file
name below follows the FEC's published "file description" data dictionaries as best recalled at
write time, not a live fetch. The provenance URLs are the one part of this source proven against
real FEC.gov conventions: `https://www.fec.gov/data/candidate/{CAND_ID}/?cycle={cycle}` for
candidate rows, `https://www.fec.gov/data/committee/{CMTE_ID}/?cycle={cycle}` for contribution
rows (these are the site's own public detail-page URL pattern, independent of the bulk-download
question).

The ZIP bytes themselves are read by a **self-contained, dependency-free reader**
(`sources/fec/zip.ts`, `node:zlib.inflateRawSync` for deflate entries) rather than the `fflate`
library `house-clerk/client.ts` already uses — that one is tightly coupled to finding a single
expected filename, where this source needs to list arbitrary entries across four differently-
shaped files, and this sprint's brief called for a minimal reader with zero new dependencies.
Both "stored" and "deflate" ZIP entries are supported (everything a standard `zip`/`zipfile`
writer produces); ZIP64 is deliberately unsupported and throws a clear error rather than
misreading its sentinel fields.

## Column positions (`fields.ts`) — `[verify-live]`

Every position below is `[verify-live]`; see the caveat and links in `fields.ts`'s own doc
comment. The sync's per-file fingerprint (the pipe count of the first line) turns the canary red
the moment a live file's column _count_ stops matching what's assumed here — it cannot catch two
columns silently swapping order while the count stays the same.

- **`weball{yy}.txt`** (30 columns) — only the columns this ingestor reads are named:
  `CAND_ID`(0), `CAND_NAME`(1), `CAND_ICI`(2), `PTY_CD`(3, not read),
  `CAND_PTY_AFFILIATION`(4, mapped to `party` — the schema documents a 3-letter code like
  "DEM"/"REP", which is this column, not the numeric `PTY_CD`), `TTL_RECEIPTS`(5), `TTL_DISB`(7),
  `COH_COP`(10, cash-on-hand close-of-period), `CAND_OFFICE_ST`(18), `CAND_OFFICE_DISTRICT`(19),
  `CVG_END_DT`(27, `MM/DD/YYYY`).
- **`itpas2.txt`** (22 columns, all named): `CMTE_ID`(0), `AMNDT_IND`(1), `RPT_TP`(2),
  `TRANSACTION_PGI`(3), `IMAGE_NUM`(4), `TRANSACTION_TP`(5), `ENTITY_TP`(6), `NAME`(7), `CITY`(8),
  `STATE`(9), `ZIP_CODE`(10), `EMPLOYER`(11), `OCCUPATION`(12), `TRANSACTION_DT`(13, `MMDDYYYY`),
  `TRANSACTION_AMT`(14), `OTHER_ID`(15), `CAND_ID`(16), `TRAN_ID`(17), `FILE_NUM`(18),
  `MEMO_CD`(19), `MEMO_TEXT`(20), `SUB_ID`(21, the FEC's own unique record id — this source's
  natural key).
- **`cn.txt`** (15 columns; only `CAND_ID`(0)/`CAND_NAME`(1) read) and **`cm.txt`** (15 columns;
  only `CMTE_ID`(0)/`CMTE_NM`(1) read) — the rest of each master's columns exist in the real file
  but are never consulted.

The office letter (`H`/`S`/`P`) is read from `CAND_ID`'s first character, never from a separate
column — a candidate id whose first character isn't one of those three fails the whole row
(parse-failure accounting), rather than guessing an office.

## Cycle model

`fecCurrentCycle(now)` derives the current even-year cycle from the clock: an odd year belongs to
the cycle closing at its next even year (`2025 → 2026`); an even year is its own cycle
(`2026 → 2026`). **Only the current cycle is synced by default** — there is no date-range walk
within a cycle (these bulk files are whole-cycle point-in-time snapshots, not an incrementally
paged feed), and `sync()` fetches at most one copy of each of the four ZIPs per call.

**Depth note:** the FEC publishes these same four bulk-file shapes per cycle going back to 1980.
Ingesting that history is out of scope here — it would be a deliberate, separate per-cycle
configuration (which past cycles to sync, on what cadence, whether to store them as the same
`fec-candidates`/`fec-contributions` datasets or a historical variant) that does not exist yet
and is not scheduled by anything in this codebase. This is stated plainly as a known gap, not a
promise.

## The 20-hour freshness throttle

Because every sync is a full re-download of large point-in-time snapshot files, a watermark
`fec.{cycle}.lastFetchedAt` records when a cycle's walk last **completed** (every requested file
fetched, none stopped by `--limit`). A sync call within 20 hours of that watermark is skipped
entirely — zero network calls, `rowsUpserted: 0`, a note explaining why — unless the caller
passes `--full` or `--since`. Both of those are read only as "force it" here: unlike most other
sources, `--since`'s value carries no date-boundary meaning for a whole-cycle snapshot file, so
its mere presence (any value) bypasses the throttle exactly like `--full` does.

The watermark is **per-cycle, not per-dataset**: a run that only asked for `fec-candidates` still
sets the same watermark a full run would, so a subsequent `fec-contributions`-only run inside the
same 20-hour window is throttled too, even though that first run never touched `pas2`/masters.
This is a deliberate simplification — reach for `--full` (or `--since <anything>`) to force a
specific dataset through the window.

`--limit` caps parsed rows **per file**, independently (not a shared budget across `weball` and
`pas2`) — hitting it on either file marks the whole sync as incomplete and the watermark is not
advanced, so a later unbounded run re-fetches properly rather than believing the cycle is done.

## Join semantics (masters)

`cn.txt`/`cm.txt` are downloaded **only when `fec-contributions` is in scope**, parsed into
in-memory `Map<id, name>` lookups (`buildCandidateNameMap`/`buildCommitteeNameMap`), and used
**only** to fill `candidateName`/`committeeName` on contribution rows — they are never stored as
their own dataset, and a master row missing either its id or its name is silently skipped rather
than corrupting the join. A `CAND_ID`/`CMTE_ID` on a contribution row that isn't in that cycle's
master simply leaves the corresponding name `null`; it does not fail the row (the id itself is
still required and verbatim). Both master files are also fingerprinted
(`fec.cn.columns`/`fec.cm.columns`) so a live layout change on either is visible even though
neither is a canary-probed dataset.

## Memory discipline

`itpas2.txt` can be hundreds of thousands of lines. `walk.ts`'s `walkPipeFile` parses one line at
a time straight from the already-unzipped in-memory text (no line array is ever materialized)
and flushes successfully-parsed rows to `store.upsert` every 2,000 rows (`WALK_BATCH_SIZE`), so a
sync never holds more than one batch of parsed records at once regardless of the file's total
size. A line that fails to normalize is counted (attempted, not succeeded) and logged — never
thrown onward — so one bad line can never abort an otherwise-good multi-hundred-thousand-line
walk.

## Normalization rules

- Dates: `weball`'s `CVG_END_DT` is `MM/DD/YYYY`; `pas2`'s `TRANSACTION_DT` is `MMDDYYYY`. Both
  normalize to `YYYY-MM-DD`; blank or garbage (an unparseable string, an out-of-range month/day,
  the FEC's `00/00/0000`-style placeholder) becomes `null` — never a fabricated date.
- Numbers: the candidate summary totals (`totalReceipts`, `totalDisbursements`, `cashOnHand`) are
  nullable fields — blank **and** non-blank garbage (e.g. `"N/A"`) both degrade to `null`, never
  a fabricated `0`. `TRANSACTION_AMT` (`amountUsd`) is required and not nullable — blank or
  garbage there fails the whole contribution row instead. Its sign is kept exactly as filed: a
  refund's negative amount stays negative.
- `parser: "fec-bulk@1"`, `confidence: 1`, `needsReview: false` on every row from this source —
  the raw files are structured, keyless, and machine-readable; there is no OCR/LLM step here to
  ever mark for review.
- Natural keys: `fecCandidateId(candidateId, cycle)` = `"{CAND_ID}:{cycle}"` for candidates
  (a candidate re-appearing across cycles is a distinct row per cycle, by design — totals are
  cycle-scoped); the FEC's own `SUB_ID` for contributions (already globally unique per the
  agency's own numbering).

## Canary

- **Hard, `fetch-weball`**: a `HEAD` request against the current cycle's `weball` ZIP; if `HEAD`
  isn't supported (a non-2xx or a network error), a full `GET` is attempted instead and that
  GET's success is what the check reports (noted explicitly when the fallback fired). This GET
  is not wasted work — it's the same content needed for the fingerprint check right after it.
- **Hard, `fingerprint-weball`**: computed live from that same GET (pipe count of the first
  line), compared against the stored `fec.weball.columns` baseline (recorded on first contact).
- **Hard, `fingerprint-pas2`**: `pas2` is **never** re-fetched by the canary — in production it
  can be a multi-hundred-megabyte file, far too large for a routine health check. This check only
  confirms a `fec.pas2.columns` baseline exists from a real prior sync; true live drift detection
  for `pas2` happens the moment a sync recomputes that fingerprint and it no longer matches.
- **Hard, `parse-success-rate`**: the last recorded sync run's aggregate `succeeded/attempted`
  across both files, ≥ 99% (same bar and mechanism every other source in this project uses).
- **Soft, `freshness-fec-candidates`** / **`freshness-fec-contributions`**: each dataset's newest
  `retrievedAt` within its 45-day freshness window (`schema/datasets.ts`).

## Fixtures

- `fixtures/fec/case-cycle-2026/` — one synthetic 2026 cycle: `weball26.zip` (6 candidate rows,
  5 valid across House/Senate/President + 1 with an invalid office-letter `CAND_ID` that must be
  skipped), `pas226.zip` (10 contribution rows, 8 valid + 2 malformed — a blank required
  `CAND_ID` and garbage `TRANSACTION_AMT`), `cn26.zip`/`cm26.zip` (masters deliberately missing
  one referenced id each, to exercise the join-miss/`null` path alongside the join-hit path). The
  plain-text bodies are committed alongside the ZIPs so row-level unit tests
  (`records.test.ts`) don't need to unzip anything, while `source.test.ts` exercises the full
  fetch → unzip → parse → join → upsert path through a mocked network. `expected-candidates.json`
  / `expected-contributions.json` are the hand-verified goldens (each row's scenario documented
  in the case's own `README.md`). Every id and name in this fixture is invented.
- `fixtures/fec/case-zip-reader/` — a minimal two-entry ZIP (one stored, one deflated, one nested
  and differently-cased) built with Python's stdlib `zipfile` — a different implementation from
  this project's own reader — for `zip.ts`'s unit tests. See that case's `README.md` for the
  exact build script.

## `[verify-live]`

Built and tested fully offline; this environment cannot reach `fec.gov`. Confirm the following
before depending on a production sync — the per-file pipe-count fingerprint will flag a changed
column _count_ on its own, but not a same-count reorder, so these are still worth a human check:

- **Base path and naming convention.** `https://www.fec.gov/files/bulk-downloads/{cycle}/` plus
  `weball{yy}.zip` / `pas2{yy}.zip` / `cn{yy}.zip` / `cm{yy}.zip`, and that each ZIP's one entry
  is exactly `weball{yy}.txt` / `itpas2.txt` / `cn.txt` / `cm.txt`.
- **Every column position in `fields.ts`** — most importantly whether `party` should really read
  `CAND_PTY_AFFILIATION` (column 4, a 3-letter code) rather than `PTY_CD` (column 3, numeric);
  this ingestor picked the former to match the schema's own documented example format.
- **File encoding.** Bodies are decoded as `latin1` (every byte 0-255 round-trips, identical to
  UTF-8 for the pure-ASCII common case) — confirm the live files' actual encoding.
- **`HEAD`/ranged-GET support** on the static file host, for the canary's cheap reachability
  probe (a full GET is the documented, accepted fallback either way).
- **The "refund" scenario's transaction-type code.** The fixture's negative-amount row uses
  `24R` as an illustrative example of a refund; this is not verified against the live FEC
  transaction-type code table. The parser stores `TRANSACTION_TP` verbatim regardless of which
  code appears, so this affects only the fixture's flavor text, not correctness.
- **Depth beyond the current cycle.** Bulk files exist per cycle back to 1980; this ingestor
  intentionally walks only the current one (see "Cycle model" above).
