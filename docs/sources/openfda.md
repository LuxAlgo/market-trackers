# Source: openFDA Drugs@FDA (`openfda`)

**Datasets:** `fda-approvals`
**Status:** implemented
**Auth:** none required; an optional free key (config `openfdaApiKey` / `ALT_DATA_OPENFDA_KEY`)
raises rate limits, sent as the `api_key` query parameter. `[verify-live]` current
anonymous vs keyed limits (documented historically as 240/min/IP keyless, higher keyed).

## Endpoints

- `GET https://api.fda.gov/drug/drugsfda.json` with a `search` on
  `submissions.submission_status_date:[YYYYMMDD TO YYYYMMDD]`, paged via `limit` (≤ 100) +
  `skip`. `api_key` is appended as a query parameter when configured.
- Results are applications: `application_number`, `sponsor_name`, optional
  `openfda.brand_name[]`, and `submissions[]` each carrying `submission_type`,
  `submission_number`, `submission_status`, `submission_status_date`.
- **The search matches at the application level.** openFDA's Elasticsearch backing matches a
  whole application document as soon as _any_ of its submissions has a status date in the
  queried range — the response then carries _every_ submission that application has, including
  ones dated outside the window (or with no date at all). The client never trusts a returned
  submission's window membership; it re-checks each submission's own `submission_status_date`
  against `[start, end]` before treating it as belonging to this run.

## Ingestion

- Walks a single `[start, end]` date window ascending: `start` is `--since`, or
  `openfda.lastStatusDate - 7 days` (submission status updates can post with a short lag), or
  `backfillDays` back from today with no watermark; `end` is `--until`, defaulting to today.
  `--full` ignores the watermark and re-walks from `backfillDays` back.
- Pages the window with `skip` in increments of `limit` (≤ 100) until a short page is returned or
  `skip` has consumed `meta.results.total`.
- **Skip-ceiling narrowing.** `[verify-live]` openFDA's `skip` paging refuses once
  `skip + limit` exceeds `OPENFDA_SKIP_CEILING` (25,000, kept as a conservative assumption). The
  first page of every window reads `meta.results.total`; when it exceeds the ceiling, the window
  is bisected at its date midpoint (`splitDateWindow`) into two windows that each restart paging
  at `skip=0`, oldest half first, recursing further if a half is still too large. A window that
  is already a single day and still over the ceiling cannot be narrowed further — it pages up to
  the ceiling anyway and the run is flagged incomplete (watermark held back) rather than
  guessing at the remainder.
- `--limit` counts _applications fetched_ (documents paged from the API), not output rows — an
  application can produce zero, one, or several rows depending on how many of its submissions
  fall in the window.
- Watermark `openfda.lastStatusDate` advances to the max `statusDate` among succeeded rows, only
  on a completed walk, and only forward. A `--until`-bounded run (used by the backfill engine to
  run bounded chunks) advances the watermark only up to what that bound actually covers, so the
  next chunk picks up exactly where it left off.

## Field mapping

- Natural key `${applicationNumber}:${submissionType}:${submissionNumber}` (`fdaApprovalId`) —
  one row per application-submission event whose own status date falls in the queried window.
- `submissionStatus` stays the raw code (`AP`, `TA`, …) verbatim, `null` when absent.
  `submission_status_date` (`YYYYMMDD`) normalizes to `statusDate` (`YYYY-MM-DD`) via
  `expandCompactDate`; **missing or unparseable is always a parse failure**, never skipped
  quietly and never guessed — there is no way to tell which run's window a dateless submission
  belongs to, so it is flagged every time its application is seen.
- `brandName` = first `openfda.brand_name` entry when the application has one, else `null`
  (covers both an absent `openfda` object and one present without a `brand_name` array).
- `sponsor.tickers` resolves through the curated map (`resolve/recipients.ts`); unmatched
  sponsors are still stored, with `tickers: []`.
- `provenance.sourceUrl` = the Drugs@FDA application overview page,
  `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=<digits>`
  (the application number's letter prefix stripped) — chosen over the openFDA query URL because
  it is the FDA's own canonical, human-readable primary document for the application and does not
  depend on any particular search window. `parser: "openfda-drugsfda@1"`, `confidence: 1`.
- **Non-goal guard:** rows are recorded regulatory events only (submissions that already carry a
  status) — no pending-decision calendar is synthesized from them.

## Canary

Probe succeeds, with the key attached when configured (hard) · response-shape fingerprint: hash
of an application result row's sorted top-level field names (hard) · parse success ≥ 99% across
the probe application's submissions (hard) · freshness within 12 days (soft — Drugs@FDA refreshes
on a lag measured in days-to-weeks).

## Fixtures

`fixtures/openfda/case-drugsfda-page/` — a synthetic, format-faithful single response page
(`meta.results.total` matches its 4 rows, so skip-ceiling narrowing isn't triggered by this
fixture; that path has its own inline-mock test) covering: an original approval (single brand),
a supplement on an application whose other submission predates the sync window (silently
excluded, not a failure), a multi-brand application (`brandName` takes the first), and an
application with three submissions — one in-window original approval, one supplement with no
`submission_status_date` at all (a parse failure), and one later supplement used to prove a
`--until` bound both excludes the row and caps the watermark.

## `[verify-live]`

Built and tested fully offline against the fixtures above — this environment cannot reach
`api.fda.gov`. Confirm the following against the live API before depending on it in production;
the fingerprint canary above goes red the moment the result-row shape drifts, rather than
misparsing silently:

- **Anonymous vs. keyed rate limits.** Shipped conservatively as `{limit: 60, windowMs: 60_000}`
  keyless and `{limit: 240, windowMs: 60_000}` keyed — confirm the currently published ceilings
  (historically documented as 240/min/IP keyless) still match, and adjust the constants in
  `sources/openfda/client.ts` accordingly.
- **The `skip` ceiling.** Assumed `OPENFDA_SKIP_CEILING = 25_000` (`skip + limit` past this is
  expected to error). If the real ceiling differs, only the constant needs to change — the
  narrowing strategy above is unaffected.
- **Application overview URL.** Assumed
  `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=<digits>`
  resolves for any `application_number` with its letter prefix stripped, and stays stable
  long-term. If it doesn't, the fallback documented as an alternative is the openFDA query URL
  for the application number.
- **Field names.** `application_number`, `sponsor_name`, `openfda.brand_name[]`,
  `submissions[].submission_type`, `.submission_number`, `.submission_status`,
  `.submission_status_date`. The canary's row fingerprint hashes the probe application's sorted
  top-level field names, so any live rename, addition, or removal turns it red.
- **`meta.results.total` semantics.** Assumed stable across pages of the same query (used to
  decide when a window is fully paged and whether it needs bisecting) and to genuinely reflect
  the _application_-level match count for the nested `submissions.submission_status_date` query.
