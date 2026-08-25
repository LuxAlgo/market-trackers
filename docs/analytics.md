# Analytics: bring-your-own-prices

This is the design doc for `packages/core/src/analytics/` and the `alt-data analyze` CLI
command — the one place in LuxAlgo Alt Data where a public-record row is combined with a number that
isn't a public record: a price series **you** supply.

## What this is, and isn't

- **LuxAlgo Alt Data ships no price data.** Nothing in this module fetches, stores, or bundles a price.
  Every price used anywhere here came from a CSV the caller passed in.
- **LuxAlgo Alt Data computes no scores, signals, ratings, or predictions — here or anywhere.** This
  module does exactly one kind of thing: a deterministic arithmetic join between a stored
  public-record row and a price the caller supplied. `changePct = (later - base) / base`. That
  is the entire model.
- **Disclosed amount ranges stay ranges.** Congressional trade amounts are printed as ranges
  ("$1,001 - $15,000"); LuxAlgo Alt Data never fabricates a midpoint. Because of that, this module never
  computes a dollar return or a position size — only a per-event **price** percentage change.
  If a computation would need a trade size, it isn't implemented.
- **Every output carries the disclaimer.** `ANALYTICS_DISCLAIMER` — "Descriptive arithmetic
  over public records and user-supplied prices. Not investment advice; no predictive claim is
  made." — is a field on every result object (`result.disclaimer`) and a line the CLI always
  prints, `--json` or not. There is no code path that produces a result without it.
- **Nothing is dropped silently.** An event whose price can't be found is reported with
  `status: "skipped"` and a reason, in the same `rows` array as the priced events — never
  removed from the output.

## The module (`packages/core/src/analytics/`)

### `prices.ts` — the user-supplied price series

```ts
parsePriceCsv(text: string): PriceSeries
```

Parses a CSV with the header `date,ticker,close` (required; case-insensitive). Each data row
needs an ISO date (`YYYY-MM-DD`), a ticker, and a positive close. A malformed row — wrong field
count, an invalid or non-calendar date, an empty ticker, a non-positive or non-numeric close —
is never guessed at: it's excluded from the series and recorded on `series.warnings` with the
1-based source line number and a reason. A missing or wrong header throws immediately, naming
the expected shape.

```ts
series.closeOn(ticker: string, date: string, options?: { searchForwardDays?: number }): PriceLookup
```

Returns `{ found: true, point, forwardFilled }` or `{ found: false, reason }`. With no
`searchForwardDays`, it's an exact-date lookup. With one, it returns the earliest close on or
after `date` within that many days — **a data-availability accommodation for weekends,
holidays, and other gaps in what the caller supplied, not a model**, which is why a forward-
filled hit is flagged (`forwardFilled: true`) rather than presented as if it were the exact
date's price.

### `event-returns.ts` — the join

```ts
eventPriceChange(
  events: AnalyticsEvent[],
  series: PriceSeries,
  options: { windowDays: number; searchForwardDays?: number },
): EventPriceChangeResult
```

For each event: `base` is the close on/after `event.eventDate`; `later` is the close on/after
`event.eventDate + windowDays`; `changePct = (later.close - base.close) / base.close`. An
event whose base or later price is unavailable becomes a `status: "skipped"` row with a
reason — never dropped. `searchForwardDays` defaults to 7 (forwarded to `closeOn` for both
lookups) and is, again, a data-availability accommodation, not a model.

The result carries `rows` (one entry per event, `"ok"` or `"skipped"`), an `aggregate`
(`eventsTotal`/`eventsOk`/`eventsSkipped`, plus a plain `meanChangePct`/`medianChangePct` —
descriptive statistics over whatever priced successfully, explicitly not a forecast), and
`disclaimer`.

### `adapters.ts` — building events from stored rows

```ts
congressTradeEvents(store: AltDataStore, filters?: CongressTradeFilters): Promise<AnalyticsEvent[]>
insiderTradeEvents(store: AltDataStore, filters?: InsiderTransactionFilters): Promise<AnalyticsEvent[]>
```

Thin wrappers over the existing query layer (`queryCongressTrades` / `queryInsiderTransactions`
in `store/queries.ts`) — no new SQL. Each `AnalyticsEvent.eventDate` is the record's `filedAt`,
**not** `transactedAt`: `filedAt` is the disclosure date, the moment the transaction became
public information. A price reaction can only be attributed to what the market actually knew,
and for both congressional and insider filings the transaction itself is typically earlier and,
until filed, non-public. `citation` is `provenance.sourceUrl`. Rows with no resolved ticker are
excluded — there's nothing to join a price series to — which is a coverage limit of the join,
distinct from a price-lookup miss (which `eventPriceChange` reports per row, with a reason).

## `alt-data analyze`

```
alt-data analyze congress|insider --prices prices.csv [--ticker <t>] [--member <name>]
  [--since <date>] [--window <days>] [--json] [--out <file>]
```

- `congress` (alias `congress-trades`) or `insider` (alias `insider-transactions`) selects the
  adapter.
- `--prices <file>` is required — a CSV shaped as above. Its absence, or an unreadable file,
  fails with a message naming the expected shape.
- `--ticker`, `--member` (congress only), `--since` filter the events, forwarded straight to
  the query layer.
- `--window <days>` sets `windowDays` (default 30); must be a positive number.
- Human output is a table (label, event date, base, later, changePct, status) via the shared
  `printTable` helper, followed by the aggregate counts and mean/median, and always ending
  with the disclaimer line.
- `--json` prints the full `EventPriceChangeResult` object (disclaimer included).
- `--out <file>` additionally writes that same JSON object to a file.

Example:

```
$ alt-data analyze congress --prices prices.csv --window 30 --ticker ACME
label                          eventDate   base           later          changePct  status
------------------------------ ----------- -------------- -------------- ---------- ------
Jane Example (senate) buy ACME 2026-08-18  40 (2026-08-18) 44 (2026-09-17) 10.00%    ok

events: 1  ok: 1  skipped: 0
mean changePct: 10.00%  median changePct: 10.00%

Descriptive arithmetic over public records and user-supplied prices. Not investment advice; no predictive claim is made.
```

## Reading further

- [`notebooks/congress-disclosure-returns.md`](../notebooks/congress-disclosure-returns.md) —
  the same join, worked in plain pandas against the published dumps, with a "what this does
  NOT tell you" section.
- [`notebooks/committee-oversight-join.md`](../notebooks/committee-oversight-join.md) — a
  facts-only join across committees, trades, and contracts (no prices involved).
- [`python/README.md`](../python/README.md) — the `alt-datasets` Python package used by both
  notebooks to read the published dumps.
