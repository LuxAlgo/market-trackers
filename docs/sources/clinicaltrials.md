# Source: ClinicalTrials.gov (`clinicaltrials`)

**Datasets:** `clinical-trials`
**Status:** scaffolded — ingestor to build (`sources/clinicaltrials/source.ts`)
**Auth:** none; free API v2.

## Access pattern (verify live)

- `GET https://clinicaltrials.gov/api/v2/studies` filtered by last-update-posted date since
  the watermark (`clinicaltrials.lastUpdatePosted`, minus a re-walk), paged via `pageToken`,
  `pageSize` ≤ 1000, requesting only the needed modules via the `fields` parameter:
  identification (nctId, briefTitle), sponsor/collaborators (lead sponsor), status (overall
  status, start date, primary completion date, last update posted), design (phases, study
  type), conditions. `[verify-live]` the exact filter parameter
  (`filter.advanced`/`query.term` with an AREA expression on LastUpdatePostDate) and field
  paths.
- Politeness: modest limiter (~2 req/s); no key.

## Normalization

- Natural key: `nctId` — a study's row is overwritten as its registration updates (upsert),
  so the dataset reflects each study's latest registry state; daily dump deltas preserve the
  change history.
- Dates keep the registry's precision (year / month / day) verbatim — never padded to fake a
  day. `phase`/`overallStatus`/`studyType` stay raw registry enums.
- Sponsor→ticker via the curated map; unmatched sponsors keep `tickers: []`.
- Provenance sourceUrl: `https://clinicaltrials.gov/study/{nctId}`. Parser id
  `clinicaltrials-v2@1`, confidence 1.
- **Non-goal guard:** `primaryCompletionDate` is the sponsor's declared plan from the
  registry. Docket ships it verbatim and never synthesizes a decision/catalyst calendar
  from it.

## Canary

Probe succeeds (hard) · study-row field fingerprint (hard) · parse rate ≥ 99% (hard) ·
freshness within 96h (soft — the registry updates every business day).

## Fixtures to build

A paged pair of responses with expected rows: a mapped public sponsor, an unmapped academic
sponsor, a month-precision date, and a no-phase observational study.
