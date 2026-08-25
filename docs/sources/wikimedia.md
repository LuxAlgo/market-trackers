# Source: Wikimedia pageviews (`wikimedia`)

**Datasets:** `wiki-pageviews`
**Status:** implemented (`sources/wikimedia/source.ts`)
**Auth:** none; free, keyless REST API. The underlying counts are released under CC0.

## Endpoint

- `GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/{article}/daily/{start}00/{end}00`
  — one **ranged** request per article per run. `{start}`/`{end}` are `YYYYMMDD` (inclusive
  bounds), so a single request returns every day's count in that window in one response —
  unlike a day-by-day file walk (FINRA) or an offset-paged window (CFTC).
- Fixed path segments, never configurable per call:
  - **`all-access`** — sums desktop, mobile-web, and mobile-app views, so a platform shift in
    how readers reach Wikipedia never reads as an attention change.
  - **`user`** (agent-type) — excludes automated bot/spider traffic; pageviews here are a proxy
    for human reader attention, not crawler noise.
  - **`daily`** granularity.
- Response shape: `{"items": [{"project", "article", "granularity", "timestamp": "YYYYMMDD00",
"access", "agent", "views"}, ...]}`. `[verify-live]` the envelope and exact field names.
- The article path segment is percent-encoded (`encodeURIComponent`) — punctuation in a real
  title (`AT&T`, `S&P_Global`, `Nike,_Inc.`) survives correctly. `[verify-live]` that the live
  API accepts percent-encoded punctuation identically to the literal character.
- Counts are CC0-licensed (Wikimedia's own dedication for the pageviews dataset) — free to
  redistribute. This is separate from the article _text_, which is CC BY-SA and does not apply
  to a bare view count.

## Semantics

- **Lag.** Daily counts finalize with roughly a one-day lag. Sync never requests through today:
  `end = min(--until ?? yesterday, yesterday)`, using `ctx.now?.() ?? new Date()` for "today"
  (pinned in tests).
- **Depth.** The Wikimedia pageviews API has data back to **2015-07-01** — nothing before that
  exists for any article, project, or access/agent combination.
- **A 404 over the whole requested range is a real, expected answer** ("no data for this
  article in this window" — e.g. before the article existed, or before the API's depth), not a
  transport failure. Sync notes it and still advances that article's watermark: the walk
  _completed_, it just found nothing. Any other non-2xx status is a genuine failure and does
  **not** advance the watermark.
- **Sparse responses are expected and never fabricated.** A day with zero or unreported views
  may simply be absent from `items` — the parser stores only the days the response actually
  names; it never invents a zero-view row for a missing day.

## Ingestion

- Per-article watermark key: `pageviews.{project}.{article}.lastDay`.
- Per run, for each entry in the curated map (in file order):
  - `start = --since ?? (watermark ? watermark + 1 day : today - backfillDays)`; `--full`
    clears the watermark (forcing the `backfillDays` branch even if a watermark exists).
  - `end` is the single, run-wide bound described above (identical for every article).
  - If `start > end` (this article is already caught up through `end`), it is skipped without
    a request.
  - Otherwise, exactly **one** ranged request is issued for that article.
- `--limit` caps **articles fetched this run** — i.e. requests actually issued, not rows,
  since one request can return many days of data. A note is pushed when the walk stops early
  because of it, naming how many articles were left unwalked this run.
- `--datasets` not including `wiki-pageviews` short-circuits the whole sync with no network
  access at all (this source only ever produces that one dataset).
- **One article's HTTP failure never aborts the run.** After `politeFetch`'s own retries are
  exhausted, that one article's error is logged and noted, its walk is skipped, and its
  watermark is left untouched (retried next run) — while every other independent per-article
  request in the same run still proceeds.
- Natural-key row id: `wikiPageviewId(project, article, day)` = `"{project}:{article}:{day}"`.
- `provenance.sourceUrl` is the exact ranged request URL that produced the row — shared by
  every day-row that one response yields, since one request covers the whole range.
  `parser: "wikimedia-pageviews@1"`, `confidence: 1`, `needsReview: false`.
- Every response item's echoed `project`/`article` is cross-checked against the map entry being
  walked, not just trusted — a mismatch fails that one item rather than risk a misattributed
  row landing under the wrong article.

## Rate limits

A shared `RateLimiter` capped at ≤5 req/s (`sources/wikimedia/client.ts`'s
`createWikimediaFetch`), via the common `createPoliteFetch` (declared User-Agent, backoff on
403/429/5xx). The API documents no hard limit; 5 req/s is a deliberately conservative, polite
default given the curated map can be walked in full on every run.

## The curated article↔ticker map

- Shipped as data: `packages/core/data/wiki-articles.json` —
  `{version, entries: [{project, article, tickers[]}]}` — validated by a zod schema in
  `sources/wikimedia/article-map.ts` at load time. A malformed map refuses to load rather than
  silently walking nonsense.
- **Hand-curated, never fuzzy-matched.** Every entry names the exact canonical URL-form article
  title (spaces as underscores, e.g. `Berkshire_Hathaway`) for a large-cap US-listed company
  whose article unambiguously identifies that one company — there is no name-resolution logic
  at sync time, only a direct lookup.
- **Never a bare, disambiguation-prone title.** A short, common name that collides with another
  Wikipedia topic is never shipped bare — the disambiguated title is used instead:
  `Apple_Inc.` (not `Apple`), `Amazon_(company)` (not `Amazon`), `Ford_Motor_Company` (not
  `Ford`), and the same logic for `Caterpillar_Inc.` (vs. the insect/larva) and
  `Chevron_Corporation` (vs. the V-shaped symbol). A regression test asserts the bare forms are
  absent from the shipped map and their disambiguated replacements are present.
- **Validated invariants**, enforced both by the zod schema and re-asserted by a dedicated unit
  test against the shipped file: every `(project, article)` pair is unique, every ticker is
  uppercase, no article title contains whitespace, every entry names at least one ticker, and
  the map's size stays inside the curated 60–100 range.
- Dual-class companies list every actively-traded class rather than picking one arbitrarily
  (`Alphabet_Inc.` → `GOOGL`, `GOOG`; `Berkshire_Hathaway` → `BRK.A`, `BRK.B`).
- **Scope.** Companies whose primary (and in practice only) equity listing is a US exchange
  (NYSE/Nasdaq). This sidesteps the "which market is the real one" ambiguity a foreign-primary-
  listed issuer with a US ADR or secondary listing would raise (e.g. ASML, TSMC, Shopify) — this
  map does not attempt to cover those. Companies recently involved in a merger, acquisition, or
  spin-off close to this map's curation date were left out where the resulting entity's name or
  ticker was not yet certain, rather than guessed.
- **Proposing a new article.** Confirm the candidate title by resolving it directly on
  `en.wikipedia.org`: it must not be a disambiguation page, and it should not be a redirect to a
  differently-titled article (a redirect's own title can log a much smaller pageview count than
  the page it points to, which would look like an unmapped or under-counted company without
  being a bug). Confirm the ticker is the company's actual primary listing. Add one
  `{project, article, tickers}` entry to `data/wiki-articles.json` in the same shape as its
  neighbors. Run the test suite — `article-map.test.ts` enforces every structural invariant
  above automatically, so a malformed addition fails loudly before it ever reaches a sync run.

## Canary

- `map-validates` (hard) — the shipped map parses and is non-empty.
- `probe-fetch` (hard) — one ranged fetch for the curated map's first article, over a 7-day
  window ending 2 days ago (extra lag tolerance beyond sync's own 1-day cutoff, so one
  slow-to-finalize day never reads as an outage).
- `fingerprint` (hard) — sha256 of the sorted field names of the probe's first response item,
  stored via `ctx.store.setFingerprint`/`getFingerprint`: "baseline recorded" the first time,
  compared thereafter. Skipped entirely when the probe found no data (nothing to fingerprint).
- `parse-success-rate` (hard) — read from the **last recorded sync run**
  (`ctx.store.latestSyncRun("wikimedia")`), not recomputed from the probe; simply absent from
  the check list when no sync run has been recorded yet, since there is nothing yet to judge
  (mirrors `senate-efd`'s canary convention).
- `freshness-wiki-pageviews` (soft) — `maxRetrievedAt("wiki-pageviews")` within the dataset's
  96-hour freshness window.

## Fixtures

`packages/core/fixtures/wikimedia/` — synthetic, format-faithful REST responses with
hand-verified expected output:

- `case-daily-window/` — a 3-day response for one article (Nvidia), no gaps or malformed
  items: the happy path.
- `case-malformed-item/` — a 4-item response for one article (Ford Motor Company) mixing two
  valid days with a non-numeric `views` value (fails as a whole item, never zeroed) and an item
  whose echoed `article` field names a different company (`General_Motors`) — the integrity
  guard against a misattributed item.

## `[verify-live]`

Built and tested fully offline against the fixtures above — this environment cannot reach
`wikimedia.org`. Confirm the following against the live API before depending on it in
production; the fingerprint canary above goes red the moment the result-item shape drifts,
rather than misparsing silently:

- **Response envelope and field names.** Assumed exactly
  `{"items": [{project, article, granularity, timestamp, access, agent, views}]}`. The canary's
  item fingerprint hashes the probe's first item's sorted field names, so any live rename,
  addition, or removal turns it red.
- **Timestamp form.** Assumed every daily-granularity item carries a 10-digit `YYYYMMDD00`
  timestamp — i.e. the trailing hour is always literally `"00"`; `parseDailyTimestamp` rejects
  anything else.
- **404-on-no-data semantics.** Assumed the endpoint returns HTTP 404 when the entire requested
  range has no data (rather than, say, 200 with an empty `items` array). Also confirm that a
  _partially_ sparse range (some days present, some not) returns 200 with only the present days
  in `items` — never a placeholder row for a missing day.
- **Article percent-encoding.** Assumed the article path segment accepts standard
  `encodeURIComponent` escaping for punctuation (`&` → `%26`, `,` → `%2C`, etc.) identically to
  the literal character.
- **Pageviews depth.** Documented as available back to 2015-07-01; not exercised by any fixture
  (every fixture uses dates well inside this project's active window).
- **Rate-limit headroom.** No documented hard limit was found for this endpoint; ≤5 req/s is
  this client's own conservative choice, not a confirmed API ceiling.
- **Canonical vs. redirect titles.** Each curated title is assumed to be the article's actual
  (non-redirect) title, not a redirect to a differently-titled page — see "Proposing a new
  article" above for why this matters for count accuracy, not just correctness.
