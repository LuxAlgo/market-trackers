# Source: House Clerk financial disclosures (`house-clerk`)

**Datasets:** `congress-trades`
**Status:** implemented (`sources/house-clerk/`)
**Auth:** none.

## Access pattern

1. Yearly index ZIP: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YYYY}FD.zip`
   containing `{YYYY}FD.xml` (plus a `.txt` variant, ignored) — one `<Member>` row per filing:
   Prefix/Last/First/Suffix, FilingType, StateDst, Year, FilingDate (`M/D/YYYY`), DocID.
2. Filing type **`P`** rows are Periodic Transaction Reports; per-filing PDFs live under
   `…/public_disc/ptr-pdfs/{YYYY}/{DocID}.pdf` (the `{YYYY}` is the index year the row came from).
3. Electronic House PTRs are **text-layer PDFs with a consistent table layout**. The pipeline is:
   - `pdf-text.ts` — a deliberately thin bytes → `PositionedTextItem[]` layer over unpdf
     (`getDocumentProxy` + `page.getTextContent()`, x/y from each item's transform);
   - `parse-ptr-items.ts` — the layout-aware parser (`house-ptr-pdf@1`, confidence **0.9**):
     lines are grouped by page + y tolerance, the transactions table is located by its header
     row (ID / Owner / Asset / Transaction Type / Date / Notification Date / Amount), and the
     header items' x positions slice every following line into columns.
4. PDFs with **no text layer** (scanned paper filings, DocIDs that 404 under `ptr-pdfs/`) are
   recorded as pending with a sync note — never invented rows. They belong to the future
   scan-extractor path (confidence 0.7 + `needsReview`), which does not exist yet.

## Normalization rules

- Row natural key `house:{docId}:{rowIndex}`; `rowIndex` is the 0-based ordinal of **detected**
  table row blocks, so a row that fails validation does not shift the ids of the rows after it.
- Owner codes: `SP` → spouse, `JT` → joint, `DC` → dependent, blank → self; anything else →
  `owner: null` + `needsReview: true`.
- Transaction types: `P` → buy, `S` / `S (partial)` → sell, `E` → exchange. An unrecognized
  type is a parse **failure** for that row (counted against the parse rate), never a guess.
  The "(partial)" qualifier and the cap-gains-over-$200 tick are not stored (no schema field).
- Amounts via `lib/amount-ranges.ts` — bounds only, verbatim text kept. Unparseable amount
  text ⇒ `amountRange: {min: 0, max: null, text: <verbatim>}` **and** `needsReview: true`
  (the same unknown-bounds convention the Senate source documents).
- Ticker heuristic: the **last** parenthesized all-caps `[A-Z0-9.]{1,6}` group containing at
  least one letter ("(MSFT)", "(BRK.B)"); otherwise null. Asset description stays verbatim
  (wrapped lines merged with single spaces).
- Asset type: the trailing bracketed fd.house.gov tag first (`[ST]` stock, `[OP]` option,
  `[GS]`/`[CS]`/`[AB]` bond, `[CT]` crypto, `[MF]`/`[EF]` fund, …), then keyword heuristics,
  then ticker-presence → stock, else other.
- Wrapped asset descriptions and wrapped amount ranges merge into the row above — including
  across a page boundary below a repeated table header. Per-row annotation lines
  (`FILING STATUS:`, `SUBHOLDING OF:`, `DESCRIPTION:`, …) are skipped, not merged.
- `transactedAt` = the row's Date column; `filedAt` = the FilingDate from the index row.
  The Notification Date column is parsed but not stored (no schema field).
- Member identity: `matchMember(members, "{Last}, {First}", "house")` against the cached
  unitedstates/congress-legislators map; `member.name` is the index row's printed
  Prefix + First + Last + Suffix. Unmatched ⇒ `bioguideId: null`, never a guess.

## Watermark & idempotency

Watermark `clerk.lastFiledDate` = the max filing date fully processed; every sync re-walks a
trailing 7 days behind it (the index gains late entries). First sync backfills
`config.backfillDays`. In January the previous year's index is walked too; `--since` extends
the walk back to its year; `--full` ignores the watermark and the conditional cache. The ZIP
re-download is conditional (`fetch_cache` etag/last-modified → 304 skips the year); validators
are persisted **only after a complete walk**, so a `--limit`-stopped run is never 304-skipped
later. Upserts are by natural key — re-walks never duplicate.

## Canary

Current year's ZIP fetches and its XML parses, with a previous-year fallback for early January
(hard) · index XML field-name-set fingerprint, first-seen baseline (hard) · PTR
table-header-signature fingerprint probed from the newest fetchable PTR PDF, first-seen
baseline (hard) · parse success ≥ 99% over the last sync run (hard) · a PTR filed within 72h
(soft — quiet days and recesses happen).

## Fixtures

- `case-index-2026` — synthetic `{YYYY}FD.xml` (electronic PTR, paper-style PTR, annual report,
  extension, one malformed row). Tests zip it in-test with `fflate.zipSync`, so the unzip path
  is exercised.
- `case-ptr-clean-single-page` / `case-ptr-multipage-multiline` /
  `case-ptr-odd-unparseable-amount` — PTR layout goldens whose input is `PositionedTextItem[]`
  JSON with hand-verified `expected.json`.
- The bytes → items step itself is covered by a minimal hand-assembled PDF built in-test.

## Known gaps & [verify-live] assumptions

The build machine for this source could not reach disclosures-clerk.house.gov; everything below
is format-faithful to the documented/public shape of the data but must be confirmed against the
live site (CI runners can):

- `[verify-live]` The index ZIP path `…/financial-pdfs/{YYYY}FD.zip` and that the ZIP contains
  `{YYYY}FD.xml` at the root with the `FinancialDisclosure/Member` structure and the field set
  `DocID|FilingDate|FilingType|First|Last|Prefix|StateDst|Suffix|Year` (the canary fingerprints
  this on first contact).
- `[verify-live]` That the server answers conditional GETs on the ZIP with 304 + etag or
  last-modified (if it never does, syncs still work — they just re-download).
- `[verify-live]` The PTR PDF path `…/public_disc/ptr-pdfs/{YYYY}/{DocID}.pdf` for electronic
  filings, and that paper filings 404 there (currently skipped with a note; their scans are
  expected under `financial-pdfs/{YYYY}/{DocID}.pdf`).
- `[verify-live]` The exact header wording/wrapping of the transactions table ("Transaction
  Type", "Notification Date", "Cap. Gains > $200?" wrap points) and the column x geometry the
  fixtures encode; the parser derives columns from whatever header it finds, but the
  first-seen fingerprint baseline should be taken from a real PDF.
- `[verify-live]` Whether a single transaction's block can split across a page boundary (the
  parser supports it below a repeated header) and whether amendments ("P/A"-style types or new
  DocIDs) appear as distinct index rows.
- **Real-PDF goldens pending:** the pdf-bytes → items step is thin and currently proven only
  against a minimal synthetic PDF. When a networked machine can fetch real PTR PDFs, add them
  as fixtures (input.pdf + hand-verified expected.json) and extend `pdf-text` coverage — the
  layout parser's fixtures then get re-derived from real extractions.
- Scanned paper PTRs are recorded as pending; a scan-extractor interface (0.7 confidence,
  `needsReview`) is future work shared with senate-efd.
