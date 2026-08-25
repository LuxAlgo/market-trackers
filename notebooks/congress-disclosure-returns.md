# Congressional disclosure returns: a receipts-first walkthrough

What this walkthrough does: joins Docket's congressional-trade disclosures to a price series
**you supply**, and computes the plain percentage price change from the disclosure date to
some number of days later. That's it.

> Descriptive arithmetic over public records and user-supplied prices. Not investment advice;
> no predictive claim is made.

Docket ships no price data and computes no scores, signals, or predictions — here or anywhere
else in the project. Everything below is arithmetic on two numbers you can trace back to a
primary-source filing and a price file you control.

There are two ways to run this: the copy-paste Python below (using the `docket-data` reader
package from `python/`), or the equivalent one-liner with the Docket CLI — see
[the CLI equivalent](#the-cli-equivalent) at the end. Both do exactly the same computation
(the CLI's `docket analyze` command is a thin wrapper over
`packages/core/src/analytics/event-returns.ts`, which this walkthrough reimplements in a few
lines of pandas so it's runnable without Node at all).

## 1. Get the data

Pull the congressional-trades dataset from the published dumps. No account, no API key:

```python
from docket_data import load_snapshot, to_dataframe

ROOT = "https://raw.githubusercontent.com/LuxAlgo/docket-data/main"
trades = to_dataframe(load_snapshot(ROOT, dataset="congress-trades"))
print(len(trades), "congressional trade disclosures")
trades.head()
```

Every row has a `provenance` column carrying `sourceUrl` — a deep link to the actual Senate
eFD or House Clerk filing the row was parsed from. Nothing here is derived from a secondary
source.

## 2. Restrict to what you care about, and to rows a price join can even use

```python
subset = trades[trades["ticker"].notna()].copy()          # only rows Docket resolved to a ticker
subset = subset[subset["chamber"] == "senate"]             # optional: senate only
subset = subset[subset["filedAt"] >= "2026-01-01"]          # optional: recent filings only
print(len(subset), "ticketed, filterable events")
```

Disclosed amounts are printed as ranges on the filing (`"$1,001 - $15,000"`) — Docket never
invents a midpoint, so there is no single dollar amount to size a trade by. This walkthrough
therefore computes **per-event price change only**; it does not, and cannot honestly, report a
dollar return.

Note **`filedAt`**, not `transactedAt`: `filedAt` is the disclosure date — the day the
transaction became public information. `transactedAt` is often weeks earlier, and by law
non-public until the report is filed. A price reaction can only be attributed to what the
market actually knew, so every price join below (and in `docket analyze`) keys off `filedAt`.

## 3. Bring your own prices

Docket ships no price data. Supply your own CSV — `date,ticker,close`, one row per
ticker-day — from whatever source you already have a license or subscription for:

```python
import pandas as pd

prices = pd.read_csv("your_prices.csv", parse_dates=["date"])
prices["date"] = prices["date"].dt.strftime("%Y-%m-%d")
prices["ticker"] = prices["ticker"].str.upper()
```

## 4. The join: price change from disclosure to N days later

```python
WINDOW_DAYS = 30
SEARCH_FORWARD_DAYS = 7  # accommodates weekends/holidays in your price file — not a model

def close_on_or_after(ticker, date, forward=SEARCH_FORWARD_DAYS):
    """The earliest close on `date`, or within `forward` days after — a
    data-availability accommodation for gaps in the price file, never an
    estimate of a price that wasn't supplied."""
    end = (pd.Timestamp(date) + pd.Timedelta(days=forward)).strftime("%Y-%m-%d")
    window = prices[(prices["ticker"] == ticker) & (prices["date"] >= date) & (prices["date"] <= end)]
    window = window.sort_values("date")
    return None if window.empty else window.iloc[0]

rows = []
for event in subset.itertuples():
    base = close_on_or_after(event.ticker, event.filedAt)
    if base is None:
        rows.append({"event": event.id, "status": "skipped",
                      "reason": f"no base price for {event.ticker} on/after {event.filedAt}"})
        continue

    later_date = (pd.Timestamp(event.filedAt) + pd.Timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")
    later = close_on_or_after(event.ticker, later_date)
    if later is None:
        rows.append({"event": event.id, "status": "skipped",
                      "reason": f"no later price for {event.ticker} on/after {later_date}"})
        continue

    rows.append({
        "event": event.id,
        "status": "ok",
        "member": event.member["name"],
        "ticker": event.ticker,
        "filedAt": event.filedAt,
        "basePrice": base["close"],
        "laterPrice": later["close"],
        "changePct": (later["close"] - base["close"]) / base["close"],
        "citation": event.provenance["sourceUrl"],
    })

results = pd.DataFrame(rows)
ok = results[results["status"] == "ok"]
print(f"{len(ok)} priced, {len(results) - len(ok)} skipped (see the 'reason' column)")
print("mean changePct:", ok["changePct"].mean())     # plain descriptive stats — not a forecast
print("median changePct:", ok["changePct"].median())
```

Every skipped row stays in `results`, with a `reason` — nothing is dropped silently. If you
want to see them: `results[results["status"] == "skipped"]`.

## What this does NOT tell you

- **Not a signal.** A price moved after a filing became public; that is a fact about two
  numbers, not a claim that the trade caused the move, that the member acted on non-public
  information, or that any pattern here repeats.
- **Not a dollar return.** Disclosed amounts are ranges (`"$1,001 - $15,000"`); there is no
  single dollar figure to compute a return on, so this only ever reports a price percentage —
  never a position size, P&L, or portfolio impact.
- **Not risk-adjusted, not benchmarked.** `changePct` is not compared to the ticker's sector,
  the broad market, or any baseline. A positive number here next to a positive market-wide
  rally that week is not, by itself, evidence of anything beyond "both went up." If you want a
  benchmark-relative figure, that is your analysis to add explicitly and deliberately, on data
  you can also show receipts for — this walkthrough does not sneak one in for you.
- **Coverage gaps are gaps, not absence.** Only rows with a resolved `ticker` are usable here;
  asset descriptions Docket couldn't resolve to a ticker are excluded from `subset` in step
  2 — a gap in _this join_, not a claim that the excluded trades didn't happen. Check
  `trades["ticker"].isna().sum()` to see how many.
- **No statistical significance testing.** `mean`/`median` are plain descriptive summaries of
  whatever rows happened to price successfully — no p-values, no confidence intervals, no
  claim of significance is computed here or anywhere in Docket.

## The CLI equivalent

The Docket CLI (TypeScript) does the same join, from a local synced store, with the same
`filedAt`-keyed logic, the same forward-search accommodation, and the same disclaimer on every
result:

```bash
docket analyze congress --prices your_prices.csv --window 30 --json
```

Add `--ticker`, `--member`, or `--since` to filter the events, same as the pandas filtering in
step 2. See [`docs/analytics.md`](../docs/analytics.md) for the full command and its flags.
