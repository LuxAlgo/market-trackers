# Committee oversight join: receipts-first storytelling

What this walkthrough does: joins three of Docket's datasets — **committee assignments**,
**congressional trades**, and **government contract awards** — to surface a specific, legal,
already-disclosed fact pattern: members of a committee, personally trading the same tickers
that receive contracts from agencies in that committee's general orbit. It presents the facts
side by side, with a citation on every row. It does not score, rank, or accuse anything.

This is not a price join (nothing here uses `packages/core/src/analytics/` or a user-supplied
price file) — it's a plain relational join across public records, in the same spirit as the
price-change walkthrough in
[`congress-disclosure-returns.md`](congress-disclosure-returns.md): facts joined, never
interpreted for you.

## 1. Get the data

```python
from docket_data import load_snapshot, to_dataframe

ROOT = "https://raw.githubusercontent.com/LuxAlgo/docket-data/main"

committees = to_dataframe(load_snapshot(ROOT, dataset="committee-assignments"))
trades = to_dataframe(load_snapshot(ROOT, dataset="congress-trades"))
contracts = to_dataframe(load_snapshot(ROOT, dataset="gov-contracts"))

print(len(committees), "committee/subcommittee assignments")
print(len(trades), "congressional trade disclosures")
print(len(contracts), "federal contract awards")
```

## 2. Pick a committee and its roster

```python
committee_query = "armed services"
roster = committees[committees["committee"].apply(lambda c: committee_query in c["name"].lower())]

print(roster["committee"].iloc[0]["name"], "—", roster["bioguideId"].nunique(), "members")
member_ids = set(roster["bioguideId"])
```

## 3. What tickers do this committee's members personally trade?

```python
member_trades = trades[trades["member"].apply(lambda m: m.get("bioguideId") in member_ids)].copy()
traded_tickers = set(member_trades["ticker"].dropna().str.upper())

print(len(member_trades), "disclosed trades by this committee's members,",
      "across", len(traded_tickers), "distinct tickers")
```

## 4. Which of those tickers also received contract awards?

```python
def recipient_ticker_set(recipient):
    return {t.upper() for t in (recipient.get("tickers") or [])}

contracts = contracts.copy()
contracts["recipient_tickers"] = contracts["recipient"].apply(recipient_ticker_set)
overlap = contracts[contracts["recipient_tickers"].apply(lambda ts: bool(ts & traded_tickers))]

print(len(overlap), "contract awards to companies this committee's members have personally traded")
```

## 5. Assemble the receipts, side by side

```python
import pandas as pd

rows = []
for _, contract in overlap.iterrows():
    for ticker in contract["recipient_tickers"] & traded_tickers:
        matching = member_trades[member_trades["ticker"].str.upper() == ticker]
        for _, trade in matching.iterrows():
            rows.append({
                "member": trade["member"]["name"],
                "ticker": ticker,
                "trade_side": trade["side"],
                "trade_filedAt": trade["filedAt"],
                "trade_amountRange": trade["amountRange"]["text"],
                "trade_citation": trade["provenance"]["sourceUrl"],
                "contract_agency": contract["agency"],
                "contract_actionDate": contract["actionDate"],
                "contract_amountUsd": contract["amountUsd"],
                "contract_citation": contract["provenance"]["sourceUrl"],
            })

receipts = pd.DataFrame(rows).sort_values(["ticker", "trade_filedAt"])
receipts
```

Every row in `receipts` carries two citations — `trade_citation` and `contract_citation` — so
anyone reading the output can go straight to both primary documents.

### Optional: a purely descriptive date delta

```python
receipts["days_trade_filed_before_contract"] = (
    pd.to_datetime(receipts["contract_actionDate"]) - pd.to_datetime(receipts["trade_filedAt"])
).dt.days
```

This is date subtraction, nothing more — see the caveat on timing below before reading
anything into it.

## Via MCP

If you're driving Docket through its MCP server (`docket serve`) instead of the published
dumps, the same join is a handful of tool calls, each returning the same citations used above:

1. **`docket_committees`** with `{ "q": "armed services" }` — the roster: every member, their
   leadership title, subcommittee seats, and disclosed-trade count.
2. **`docket_congress_trades`** with `{ "member": "<name>" }` for each roster member (or pull
   the full trade set once and filter client-side by the roster's names) — their disclosed
   trades, each with a `citation`.
3. **`docket_gov_contracts`** with `{ "ticker": "<ticker>" }` for each ticker that turned up in
   step 2 — contract awards to that ticker's recipient, each with a `citation`.

`docket_member_profile` with `{ "q": "<name>" }` is a shortcut for steps 1–2 for a single
member: it returns their committee seats and trades already joined. None of these tools score
or rank anything — they return rows, and every row cites its filing.

## What this does NOT tell you

- **Not evidence of anything improper.** A committee member holding a position in a company
  that also receives contracts from an agency in that committee's general area is, by itself,
  a disclosed, legal fact pattern — congressional financial disclosure exists precisely so
  this is visible. This walkthrough surfaces the fact pattern; it does not assess intent,
  timing advantage, or wrongdoing.
- **Committee jurisdiction is not looked up here.** This join is on ticker overlap, not on a
  verified mapping from a committee to the specific agencies it oversees — "Armed Services"
  and "Department of Defense" are related by common knowledge, not by a field either dataset
  provides. Confirm jurisdiction yourself before drawing any conclusion that depends on it.
- **No timing analysis is a signal.** The optional `days_trade_filed_before_contract` column
  above is date subtraction, nothing more. A trade filed before, during, or after a contract's
  action date is not evidence that sequence implies causation; contract awards frequently
  follow long, publicly disclosed procurement processes that predate the award date itself by
  months.
- **Coverage gaps are gaps, not absence.** `recipient.tickers` on a contract is empty when
  Docket's recipient→ticker map hasn't resolved that recipient to a public company — a mapping
  gap, not evidence the recipient has no public tickers. Likewise, a member's trade with
  `ticker: None` is an unresolved asset description, not a trade that didn't happen.
- **No score, rank, or "watch list" is computed** — here or anywhere in Docket. If you build
  one on top of this, that is your model, on your assumptions; keep it clearly separate from
  the primary-source facts above.
