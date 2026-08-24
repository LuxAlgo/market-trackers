# Source: Senate LDA (`lda`)

**Datasets:** `lobbying-filings`
**Status:** implemented
**Auth:** none required; a free registered key (config `ldaApiKey` / `DOCKET_LDA_KEY`) raises
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

- Walks the filing year(s) newest-first, page by page. With no watermark (or `--full`) it walks
  a filing year from page 1 to its end. With a watermark it starts from
  `lda.lastPostedDate - 7 days` — filings get amended and re-posted, so the trailing week is
  always re-walked — and stops paging once a whole page's oldest row is older than that
  boundary; newest-first ordering makes that early stop safe.
- January also walks the previous filing year, since Q4 filings post after year end.
- Watermark: `lda.lastPostedDate`, advanced only after a completed walk, and only forward.
- `--limit`, `--since`, `--full`, and `--datasets` are honored the same way as the other
  incremental sources (USAspending, FINRA).

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
