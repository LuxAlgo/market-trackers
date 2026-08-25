# Source: ClinicalTrials.gov (`clinicaltrials`)

**Datasets:** `clinical-trials`
**Status:** implemented
**Auth:** none; free API v2.

## Endpoints

- `GET https://clinicaltrials.gov/api/v2/studies` — the only endpoint used. Filtered by a
  `LastUpdatePostDate` range, `fields`-scoped to the five modules the schema needs, paged via
  `pageToken`.
- Natural key: `protocolSection.identificationModule.nctId`.
- No study-detail endpoint is called — provenance links to the registry's own study page,
  `https://clinicaltrials.gov/study/{nctId}`, which needs no API round trip to construct.

## Access pattern

- Date filter: `query.term=AREA[LastUpdatePostDate]RANGE[start,end]` (both bounds inclusive,
  `YYYY-MM-DD`) — the v2 Essie idiom named in this source's design. `[verify-live]` the exact
  syntax; see below.
- `fields=protocolSection.identificationModule,protocolSection.sponsorCollaboratorsModule,protocolSection.statusModule,protocolSection.designModule,protocolSection.conditionsModule`
  — exactly the five modules `clinicalTrialSchema` maps from, nothing else. `[verify-live]` the
  exact path/separator syntax; see below.
- `pageSize=1000` (the documented ceiling) on every request; `pageToken` carries the previous
  response's `nextPageToken` forward. The final page omits `nextPageToken` entirely.
- Politeness: keyless, `RateLimiter({ limit: 2, windowMs: 1000 })` — conservative since the API
  publishes no documented per-client ceiling to size against.

## Ingestion

- Walks a single `[start, end]` window per sync, where `end = --until ?? today` and
  `start = --since ?? (watermark ? watermark - 7 days : today - backfillDays)`. Unlike the
  newest-first/early-stop sources (Senate LDA, USAspending), the range itself bounds the walk —
  every page from `pageToken` onward is fetched until the API reports no `nextPageToken`.
- `--since`, `--until`, `--full`, `--limit`, and `--datasets` are all honored: `--full` clears the
  stored watermark (falling back to `today - backfillDays`, same convention as USAspending);
  `--until` bounds `end` directly, which is also what lets the backfill engine run history in
  bounded chunks; `--limit` stops the walk after the page that reaches it, leaving the watermark
  untouched (a partial walk must not claim it saw everything up to `end`).
- Watermark: `clinicaltrials.lastUpdatePosted`, advanced only after a fully completed walk, only
  forward, and never past `end` — a bounded `--until` chunk cannot claim freshness beyond what it
  actually walked, even if some row's own date is later (defensively clamped, not just assumed).
- Upsert by `nctId`: a study's row is fully overwritten as its registration updates, so the
  dataset always reflects each study's latest registry state; daily dump deltas are what preserve
  the change history (a status flip is one changed row, not a new one).

## Field mapping

- `title` = `identificationModule.briefTitle`. `sponsor.name` =
  `sponsorCollaboratorsModule.leadSponsor.name`, resolved to tickers through the curated map
  (`resolve/recipients.ts`) — the same map and matching rules as USAspending/LDA. Unmatched
  sponsors are still stored, with `tickers: []`.
- `overallStatus` = `statusModule.overallStatus`, `studyType` = `designModule.studyType`, kept as
  the registry's raw enum strings — no relabeling.
- `phase` = `designModule.phases` joined with `/` when the registry lists more than one (e.g. a
  "Phase 2/Phase 3" trial becomes `"PHASE2/PHASE3"`), and `null` when the module or the field is
  absent (pure observational studies carry no phase at all — this is `null`, never `[]` or a
  guessed value).
- `conditions` = `conditionsModule.conditions`, defaulting to `[]` when the module is absent.
- `startDate` / `primaryCompletionDate` = the corresponding date struct's `date` field, verbatim
  at whatever precision the registry sent (year, year-month, or full date) — never padded to a
  fake day, and `null` whenever the struct, the module, or the field itself is missing, or the
  value doesn't match the year[-month[-day]] shape.
- `lastUpdated` = `statusModule.lastUpdatePostDateStruct.date`, required to be a full `YYYY-MM-DD`
  — a study whose posted date isn't full-precision fails to normalize (this field is
  administrative, not sponsor-declared, so the registry is expected to always post it complete).
- `provenance.sourceUrl` = `https://clinicaltrials.gov/study/{nctId}`.
  `parser: "clinicaltrials-v2@1"`, `confidence: 1`.
- **Non-goal guard:** `primaryCompletionDate` is the sponsor's declared plan, shipped verbatim.
  Nothing in this source (or anywhere else in Docket) turns it into a decision/catalyst calendar.

## Canary

Probe (`AREA[LastUpdatePostDate]RANGE[]` over the trailing 30 days, `pageSize=1`) succeeds (hard)
· study-row field fingerprint: sha256 of the sorted `module.field` paths present under
`protocolSection` for the probe's first study, so a live rename/addition/removal of a module or
field turns it red (hard, first-seen baseline) · parse success ≥ 99% on the probe rows (hard) ·
new studies within 96h (soft — the registry updates every business day, so this is generous
against a quiet weekend).

## Fixtures

- `fixtures/clinicaltrials/case-studies-2026/` — a synthetic, format-faithful `/studies` paged
  pair (page 1 with `nextPageToken`, page 2 final) covering five studies: a mapped industry
  sponsor (Pfizer → PFE), an unmapped academic sponsor (Fred Hutchinson Cancer Center), a
  month-precision `startDate` (a ModernaTX, Inc. → MRNA study), a no-phase observational study
  (Massachusetts General Hospital — `designModule.phases` is absent, not empty), and a study with
  `conditionsModule` and `primaryCompletionDateStruct` both entirely absent (Cleveland Clinic
  Foundation) — mapping to `[]` and `null` respectively rather than a guess.
- `fixtures/clinicaltrials/case-status-update/` — a single-page response representing the same
  NCT id as above (the Pfizer study) after the registry moved it from `RECRUITING` to
  `COMPLETED`, with `primaryCompletionDate` advancing from a month-precision estimate to a
  day-precision actual. Exercises the upsert-by-`nctId` contract: still one row, new status.

## `[verify-live]`

Built and tested fully offline against the fixtures above — this environment cannot reach
`clinicaltrials.gov` (CI runners can). Confirm the following against the live API before
depending on it in production; the fingerprint and parse-rate canaries above go red the moment
either drifts, rather than misparsing or under-mapping silently:

- **The date-range filter parameter and syntax.** Assumed
  `query.term=AREA[LastUpdatePostDate]RANGE[start,end]` with inclusive `YYYY-MM-DD` bounds on both
  sides — the documented v2 Essie idiom for a closed range on an indexed area, matching the
  AREA/RANGE grammar the classic (pre-v2, now retired) advanced-search API used. Unconfirmed:
  whether v2 still accepts `YYYY-MM-DD` there (vs. requiring `MM/DD/YYYY` as the classic UI did),
  and whether `filter.advanced` is the actual current parameter name instead of `query.term`.
- **The `fields` parameter's path syntax.** Assumed dotted paths
  (`protocolSection.identificationModule`, …) with `,` as the separator, selecting whole modules.
  Unconfirmed: whether the API expects bare PascalCase module/piece names instead (e.g.
  `IdentificationModule`) or requires `|` rather than `,`. Getting this wrong likely fails loud
  (a 400, caught by the probe canary) rather than silently returning the wrong shape, since it's
  a request param rather than a response field — but it's unverified either way.
- **Paging.** Assumed `nextPageToken` is omitted (not nulled) on the final page, and that passing
  the previous response's token back as `pageToken` is the whole contract — no separate
  page-token expiry or replay behavior assumed or handled.
- **Field paths.** `identificationModule.{nctId,briefTitle}`,
  `statusModule.{overallStatus,startDateStruct,primaryCompletionDateStruct,lastUpdatePostDateStruct}`
  (each a `{date, type}` struct), `sponsorCollaboratorsModule.leadSponsor.name`,
  `designModule.{studyType,phases}`, `conditionsModule.conditions`. The canary's fingerprint
  hashes exactly this module/field shape from a live probe row, so any rename, addition, or
  removal turns it red before it can under-map silently.
- **Rate ceiling.** No documented per-client limit was found; shipped at a conservative
  `2 req/s`. Confirm there's no lower published (or unpublished-but-enforced) ceiling before
  raising it.
