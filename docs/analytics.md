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

## `alt-data backtest`: one fixed strategy, applied mechanically

`packages/core/src/analytics/backtest.ts` and the `alt-data backtest` CLI command build on
the exact same primitives as `analyze` above (`prices.ts`'s `closeOn` and forward-fill, and
the `congressTradeEvents` / `insiderTradeEvents` adapters) to answer one narrower, more
opinionated question: "if every one of these disclosed events was entered at equal weight
and exited `windowDays` later, what would the aggregate look like?" It is `eventPriceChange`'s
arithmetic restated in backtest vocabulary — not a new model. LuxAlgo Alt Data still ships no
price data and computes no score or signal here.

### What it computes

```ts
runBacktest({
  events: AnalyticsEvent[],
  prices: PriceSeries,
  windowDays: number,
  entry?: "filed-close",       // the only supported value
  searchForwardDays?: number,  // default 7, forwarded to closeOn — see analyze above
}): BacktestResult
```

For each event: **entry** is the first close on/after `event.eventDate` (already the
disclosure date the adapters anchor to `filedAt`, never the transaction date — see
`adapters.ts` above); **exit** is the first close on/after `event.eventDate + windowDays`;
**`changePct = (exit.close - entry.close) / entry.close`**. Every event becomes exactly one
row in `result.rows` — `status: "priced"` with `entry` / `exit` (each
`{ date, close, forwardFilled }`) and `changePct`, or `status: "skipped"` with a reason —
never dropped.

The aggregate is `{ events, priced, skipped, meanChangePct, medianChangePct, winRate,
bestChangePct, worstChangePct }`: plain descriptive arithmetic over whatever priced.
`winRate` is the share of _priced_ events with `changePct > 0` (a flat or negative change is
not a win). Every aggregate field is `null` — never `0`, `NaN`, or omitted — when nothing
priced, so an empty aggregate can't be misread as a bad or a flat outcome.

### The fixed strategy (there is exactly one)

- **Equal weight, always.** Every event counts the same in the aggregate regardless of the
  size of the disclosed transaction. In fact `AnalyticsEvent` carries no amount field at
  all — there is nothing to size a position with even if a caller wanted to.
- **Entry at disclosure, never at the trade.** `event.eventDate` is already the filing
  date (see `adapters.ts`): a price reaction can only be attributed to information the
  market actually had.
- **One knob: `windowDays`.** It only moves the exit date forward. `entry` accepts exactly
  one value, `"filed-close"` — named explicitly (rather than assumed) so a future rule would
  be an addition a caller opts into, never a silent change to what today's callers get.

### Every honesty guard, and where it lives

| Guard                                                       | Where                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The disclaimer is on every result and every output path     | `result.disclaimer` (`ANALYTICS_DISCLAIMER`); the CLI prints it in both human and `--json` mode, unconditionally     |
| Disclosed amounts are never sized into a position or return | `AnalyticsEvent` has no amount field — there is nothing to size with, structurally                                   |
| Nothing is dropped silently                                 | every event becomes a `rows` entry, `"priced"` or `"skipped"` with a reason                                          |
| Forward-filled closes are flagged, not hidden               | `entry.forwardFilled` / `exit.forwardFilled` on every priced row                                                     |
| No costs, slippage, dividends, or taxes                     | `changePct` is the one arithmetic line in `runBacktest`; nothing else touches it                                     |
| Methodology is stated, not just implied                     | `result.dataNotes` — five fixed strings, present on every result, printed in human output right after the disclaimer |

### Worked example

Three disclosed trades — ACME (+10% over the window), BETA (-10%), and GAMMA (no price data
supplied at all):

```
$ alt-data backtest congress --prices prices.csv --window 30
events: 3  priced: 2  skipped: 1
mean changePct: 0.00%  median changePct: 0.00%
winRate: 50.00%  best: 10.00%  worst: -10.00%

Descriptive arithmetic over public records and user-supplied prices. Not investment advice; no predictive claim is made.
- Equal weight per event: every event contributes the same weight to the aggregate, regardless of the size of the underlying disclosed transaction.
- Disclosed transaction amount ranges are never converted into a position size or a dollar return — only a per-event price percentage change is computed.
- Entry is the first available close on or after the event's disclosure date (never the underlying transaction date, and never before the information was public); exit is the first available close on or after disclosure date + windowDays.
- No transaction costs, slippage, dividends, borrow costs, or taxes are modeled — changePct is a plain (exit - entry) / entry.
- A forward-filled entry or exit close (the nearest later trading day found in the supplied prices, not an exact match on the requested date) is flagged per event via entry.forwardFilled / exit.forwardFilled — never presented as if it were the exact date's price.

label                           eventDate   entry            exit             changePct  status
-------------------------------  ----------  ---------------  ---------------  ---------  -------------------------------------------------------------
Jane Example (senate) buy ACME  2026-08-18  40 (2026-08-18)  44 (2026-09-17)  10.00%      priced
Jane Example (senate) buy BETA  2026-08-18  50 (2026-08-18)  45 (2026-09-17)  -10.00%     priced
Jane Example (senate) buy GAMMA 2026-08-18  -                -                -           skipped: entry price unavailable — no prices supplied for ticker 'GAMMA'
```

`--json` prints the full `BacktestResult` (disclaimer and `dataNotes` included); `--out
<file>` additionally writes that same JSON to a file. Flags mirror `analyze`:
`--ticker`, `--member` (congress only), `--since` filter the events; `--window <days>`
(default 30) sets the exit offset.

### What this will never do

- **No optimization.** There is no parameter sweep, no "best window" search, and no fitting
  `windowDays` — or anything else — to the data it's run against.
- **No parameter fitting.** The strategy's rules (`filed-close` entry, equal weight, exit at
  `windowDays`) are fixed in code, not learned or tuned from the events or prices supplied.
- **No recommendations.** A `BacktestResult` describes what already happened to a price the
  caller supplied, for events already on the public record — never a suggestion of what
  ticker, event, or window to act on next.

## Reading further

- [`notebooks/congress-disclosure-returns.md`](../notebooks/congress-disclosure-returns.md) —
  the same join, worked in plain pandas against the published dumps, with a "what this does
  NOT tell you" section.
- [`notebooks/committee-oversight-join.md`](../notebooks/committee-oversight-join.md) — a
  facts-only join across committees, trades, and contracts (no prices involved).
- [`python/README.md`](../python/README.md) — the `alt-datasets` Python package used by both
  notebooks to read the published dumps.
