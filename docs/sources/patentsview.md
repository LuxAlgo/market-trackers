# Source: PatentsView (`patentsview`)

**Datasets:** `patents`
**Status:** scaffolded — ingestor to build (`sources/patentsview/source.ts`)
**Auth:** free API key required by the provider (config `patentsviewApiKey` /
`DOCKET_PATENTSVIEW_KEY`), sent as the `X-Api-Key` header. Without a key the source's sync
must fail with a friendly explanation (like EDGAR's contact-email requirement), and its
canary reports the gap honestly instead of probing anonymously.

## Access pattern (verify live)

- `https://search.patentsview.org/api/v1/patent/` — the PatentSearch endpoint. Query with a
  grant-date range since the watermark (`patents.lastGrantDate`, minus a small re-walk),
  requesting only the fields the schema needs: patent id, title, date, kind, assignee
  organizations, and a CPC class field. `[verify-live]` the exact query/fields/options
  parameter encoding (GET with JSON-encoded `q`/`f`/`o` params vs POST body) and the
  documented cursor ("after"-style) pagination.
- Rate limits: documented ~45 requests/minute with a key — use a `RateLimiter({limit: 40,
windowMs: 60_000})` to stay under.
- Patents grant weekly (Tuesdays); the freshness window is 12 days.

## Normalization

- Natural key: `patent_id`. `assignee` = first-listed organization (assigneeCount keeps the
  total); individual/unassigned patents keep `name: null`.
- Assignee→ticker via the curated map (`resolve/recipients.ts`) — unmatched assignees keep
  `tickers: []`.
- `cpcClass` = the first CPC class id where present, else null.
- Provenance sourceUrl: `https://patents.google.com/patent/US{patent_id}` is a rendering, not
  the record — prefer PatentsView's own patent URL or USPTO's; pick one, document it, and be
  consistent. Parser id `patentsview-api@1`, confidence 1.

## Canary

Keyed probe succeeds (hard; skipped-with-note when no key configured) · result-row field-name
fingerprint (hard) · parse rate ≥ 99% (hard) · freshness within the window (soft).

## Fixtures to build

A captured response page (JSON, format-faithful synthetic) with expected rows: a mapped
assignee, an unmapped assignee, an unassigned patent, and a multi-assignee patent.
