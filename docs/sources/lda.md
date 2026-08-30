# Source: Senate LDA (`lda`)

**Datasets:** `lobbying-filings`
**Status:** implemented
**Auth:** none required; a free registered key (config `ldaApiKey` / `MARKET_TRACKERS_LDA_KEY`) raises
rate limits — see `[verify-live]` below for the exact header scheme.

## Endpoints

- `GET https://lda.senate.gov/api/v1/filings/` — paginated filings list, filtered by
  `filing_year`, ordered newest-first by posted date (`ordering=-dt_posted`), `page_size=25`.
  Pages are walked by incrementing `page` and stopping once the API's `next` is `null`, rather
  than following the literal `next` URL — equivalent here since `next` just encodes the same
  page-number scheme.
- Natural key: `filing_uuid`.
- Filing detail (provenance fallback for a filing with no document URL):
  `https://lda.senate.gov/api/v1/filings/{filing_uuid}/`.

## Ingestion

Two walk shapes share one normalizer; `opts.until` (always set by the backfill engine)
selects between them.

**Daily top-up** (no `until`):

- Walks the filing year(s) newest-first, page by page. With no watermark (or `--full`) it walks
  a filing year from page 1 to its end. With a watermark it starts from
  `lda.lastPostedDate - 7 days` — filings get amended and re-posted, so the trailing week is
  always re-walked — and stops paging once a whole page's oldest row is older than that
  boundary; newest-first ordering makes that early stop safe.
- January also walks the previous filing year, since Q4 filings post after year end.
- Watermark: `lda.lastPostedDate`, advanced only after a completed walk, and only forward.
- `--limit`, `--since`, `--full`, and `--datasets` are honored the same way as the other
  incremental sources (USAspending, FINRA).

**Backfill** (`until` set):

- The API's only usable date filter is `filing_year` (no posted-date range filter is verified
  live), so the walk unit is the whole filing year, ascending from the window's start year.
  The backfill engine runs lda as a single `[from, to]` chunk (`SINGLE_PASS_SOURCES`) — date
  chunks would re-walk entire years.
- Progress is banked two ways: completed years through `completedThrough` (year-granular,
  capped at today for the still-posting current year), and the position inside a year through
  the `lda.backfill.cursor` watermark (`{year, page}` — the next unfetched page, persisted
  after every page, so even a hard-killed run re-ingests at most one page). A cursor inside
  the window takes precedence over the window's start year; a true from-scratch re-walk
  therefore needs a fresh store, not just `--full`.
- Stops are structured: the engine's `deadlineMs` → `stoppedEarly: "deadline"`; `--limit` →
  `"limit"`; exhausted retries against the API (rate-limit contention, outages — keyless
  contention is real: GitHub runners share egress IPs, and LDA throttles per IP) →
  `"upstream"`, with the cursor still naming the failed page so the next dispatch retries it.
- A page that exhausts retries with a 5xx/429 is salvaged before stopping: the same 25-row
  offset window is re-fetched as size-5 pages, then size-1 (live-proven — the canary probes
  with `page_size=1`), with short retries on a shared rate-limit budget. Observed live:
  `filing_year=2000&page=343` answered 503 through every backoff, twice, hours apart — a
  window the API cannot serialize at 25 rows usually serves the same rows in smaller pages.
  Only when even size 1 fails does the walk take the `"upstream"` stop.
- A run that fetches ≥ 100 rows with zero successful parses throws (format-drift tripwire)
  before the cursor advances — an unparseable era stays loudly red instead of being skipped.
- The daily posted-date watermark and the canary fingerprint are never touched on this path
  (a decades-old row's field set must not become the drift baseline).
- Throughput note: keyless is 15 req/min at 25 rows/page ≈ 2–3 h per ~50k-filing year; a free
  registered key (`MARKET_TRACKERS_LDA_KEY`) raises that ~6×, which matters for the 1999→
  present deep walk.

## Field mapping

- `amountUsd` = `income ?? expenses ?? null`, parsed from the API's decimal strings
  (`parseLdaAmount`). An explicit `"0.00"` survives as `0`; an absent or empty value stays
  `null` — amounts are never zeroed.
- `filingYear`, `filingPeriod` (the API's raw period code, e.g. `second_quarter`), and
  `filingType` are kept verbatim.
- `issues` = the unique `lobbying_activities[].general_issue_code` values, in first-seen order,
  with duplicates within a filing collapsed.
- `client.tickers` resolves through the curated map (`resolve/recipients.ts`), the same map and
  matching rules as USAspending recipients (see `docs/sources/usaspending.md`). Unmatched
  clients are still stored, with `tickers: []`.
- `provenance.sourceUrl` = the filing's `filing_document_url` when present, else the filing
  detail URL above. `parser: "lda-filings@1"`, `confidence: 1`.
- Registrant and client names are stored as the API sends them (trimmed only).

## Canary

Filings probe succeeds, with the registered key attached when configured (hard) ·
response-shape fingerprint: hash of a result row's sorted field names (hard — this is what
catches the field-name drift called out below) · parse success ≥ 99% on the probe rows (hard) ·
new filings within the quarterly-cadence window (soft — lobbying discloses quarterly, so the
freshness window is long: 120 days).

## Fixtures

`fixtures/lda/case-filings-2026/` — a synthetic, format-faithful paged pair (page 1 with `next`,
page 2 final) covering: an income filing with a client mapped by exact name (Lockheed Martin →
LMT), an expenses-only filing with an unmapped client, a filing with no reported amount (stays
null), a multi-issue filing with a duplicate issue code (deduped) and a client mapped by prefix
(Oracle America, Inc. → ORCL), and a registration filing with no `filing_document_url` (its
provenance falls back to the detail URL).

## `[verify-live]`

Built and tested fully offline against the fixtures above — this environment cannot reach
`lda.senate.gov`. Confirm the following against the live API before depending on it in
production; the fingerprint canary above goes red the moment any of it drifts, rather than
misparsing silently:

- **Auth header scheme.** Assumed `Authorization: Token <key>` — Django REST Framework's usual
  `TokenAuthentication` header, which the API's other conventions (paging shape, snake_case
  fields) suggest it's built on. Confirm the registered-key header name and scheme against the
  current docs at `lda.senate.gov/api/redoc/`.
- **Ordering param.** Assumed `ordering=-dt_posted` both sorts newest-first and is an accepted
  filter on `/filings/`. The incremental walk's early stop depends on this being a real sort,
  not merely an accepted-but-ignored query param.
- **Field names.** `filing_uuid`, `filing_year`, `filing_period`, `filing_type`, `income`,
  `expenses` (decimal strings), `registrant.name`, `client.name`,
  `lobbying_activities[].general_issue_code`, `filing_document_url`, `dt_posted`. The canary's
  row fingerprint hashes this result row's sorted top-level field names, so any live rename,
  addition, or removal turns it red.
- **Anonymous vs. keyed rate limits.** Shipped conservatively under the documented ceilings
  (keyless 15/min, keyed 100/min) — confirm the currently published limits still match.

## Bill references

- `billReferences` — normalized bill tokens (`billReferenceToken()` from `schema/bill.ts`, e.g.
  `"hr1234"`, `"sconres7"`) extracted from a filing's own specific-issues narrative:
  `lobbying_activities[].description`, the same array `issues` reads `general_issue_code` from.
  Every activity's `description` in the row is trimmed, filtered for blanks, joined with a space,
  and passed through `extractBillReferences()` (`bill-refs.ts`) once per filing. A filing whose
  narrative names no bill explicitly gets `billReferences: []`; nothing is ever inferred from
  `general_issue_code` alone, and nothing about the bill's status is looked up here — this is
  citation extraction only, not a join against the `bills` dataset.
- Extraction is deliberately conservative (see `bill-refs.ts` for the full policy and its unit
  tests). It recognizes only the 8 GovInfo BILLSTATUS bill/resolution types (`hr`, `s`, `hjres`,
  `sjres`, `hconres`, `sconres`, `hres`, `sres`), each written either in the standard dotted
  abbreviation ("H.R. 1234", "S.Con.Res. 7" — 0 or 1 space allowed before the number, so
  "H.R.1234" also matches) or fully dotless ("HR 1234", "SConRes 7" — exactly 1 space required; a
  bare "HR1234" with no separator at all is deliberately not recognized). Every type token is
  anchored by a word boundary on both sides, and the single/double-letter dotless tokens ("HR",
  "S") are matched case-sensitively, uppercase only. Together these are what keep "HRS 200" (no
  boundary after "HR"), "US 101" (no boundary before "S"), "SB 5" (a state-bill style prefix, no
  boundary after "S"), and "s 100 million" (lowercase) from ever matching. Bill numbers are 1–5
  digits — a longer digit run never matches at all, rather than truncating.
- `billReferences` is congress-agnostic on purpose — the token is just type + number (e.g.
  `"hr1234"`), because free-text lobbying narratives essentially never say which congress a bill
  belongs to. A consumer who wants to resolve a reference to an actual `bills` row scopes the
  match by year/congress themselves (a filing's `filingYear` is a reasonable proxy for which
  congress was sitting).
- `[verify-live]` **the narrative field's name.** Assumed each `lobbying_activities[]` entry
  carries a `description` field holding the free-text "specific lobbying issues" narrative (the
  fixture models this; this offline environment cannot confirm the live API's exact field name
  for it — see the field-name bullet above for the rest of the row shape, which does not
  currently list this field). If the live field is actually named something else, the
  fingerprint canary catches that rename the same way it catches any other field drift, but
  unlike a _required_ field going missing, `billReferences` would just silently stay `[]` from
  then on — a wrong field name here isn't something the existing `parse-success-rate` check would
  ever flag, since the row still parses successfully either way. Confirm the field name against
  the current LDA API docs before relying on non-empty `billReferences` in production.
