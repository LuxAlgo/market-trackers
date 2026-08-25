<div align="center">

# LuxAlgo Alt Data

**The public record, as infrastructure.**

Congress trades, insider filings, 13F holdings, government contracts and grants, lobbying,
short-sale volume, committee assignments, patents, clinical trials, FDA drug approvals, futures
positioning, federal legislation, campaign finance, Wikipedia attention — the data the paid
platforms sell is free. Now it's also open.

[![CI](https://github.com/LuxAlgo/alt-data/actions/workflows/ci.yml/badge.svg)](https://github.com/LuxAlgo/alt-data/actions/workflows/ci.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Data: CC0](https://img.shields.io/badge/data-CC0-blue.svg)](data-licenses/DATA-LICENSE)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)](#why-free)

</div>

---

LuxAlgo Alt Data ingests the public record of US markets from **primary sources only**, normalizes it into
one schema, stores it in a local database, serves it to AI agents over **MCP**, and republishes it
as **free daily data dumps**. Every row carries provenance — a working deep link to the primary
document it was parsed from. No accounts, no telemetry, no paywall, and every source is keyless
except one (PatentsView issues free API keys). Commercial platforms charge $30–75/month for API
access to this data; the sources are free, and so is this.

## Datasets

| Dataset                             | Primary source                                 | What you get                                                                 | Status in this build    |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------- |
| **Congress trades**                 | Senate eFD + House Clerk financial disclosures | Every reported transaction, amounts as disclosed ranges, member identities   | ✅ ingesting            |
| **Insider transactions**            | SEC EDGAR Forms 3/4/5 (primary XML)            | Every insider transaction and holding row, raw SEC codes + legend            | ✅ ingesting            |
| **13F holdings**                    | SEC EDGAR 13F-HR information tables            | Quarterly institutional holdings, CUSIP-keyed, values normalized to dollars  | ✅ ingesting            |
| **Government contracts**            | USAspending API                                | Federal contract awards with best-effort recipient→ticker mapping            | ✅ ingesting            |
| **Government grants**               | USAspending API                                | Federal grant awards, through the same conservative recipient→ticker mapping | ✅ ingesting            |
| **Lobbying**                        | Senate LDA API                                 | Lobbying filings with client→ticker mapping                                  | ✅ ingesting            |
| **Short-sale volume**               | FINRA Reg SHO daily files                      | Symbol-day short volume + short ratio, both pre- and post-2026 file formats  | ✅ ingesting            |
| **Committee assignments**           | unitedstates/congress-legislators              | Which member sits on which committee — the "oversees what they trade" join   | ✅ ingesting            |
| **Patents**                         | PatentsView (USPTO) API                        | Granted patents by assignee, joined to tickers                               | ✅ ingesting (free key) |
| **Clinical trials**                 | ClinicalTrials.gov API v2                      | Study registrations and status by sponsor, joined to tickers                 | ✅ ingesting            |
| **FDA drug approvals**              | openFDA (Drugs@FDA)                            | Approval actions as the FDA recorded them — history, never a prediction      | ✅ ingesting            |
| **Futures positioning (COT)**       | CFTC Commitments of Traders                    | Weekly legacy-report positioning per market                                  | ✅ ingesting            |
| **Federal legislation**             | GPO GovInfo bulk BILLSTATUS                    | Bill titles, sponsors, latest actions — joined to who lobbies on each bill   | ✅ ingesting            |
| **Campaign finance: totals**        | FEC bulk downloads                             | Candidate-cycle receipts/disbursements/cash, verbatim FEC numbers            | ✅ ingesting            |
| **Campaign finance: PAC→candidate** | FEC bulk downloads                             | Committee→candidate contributions as filed (refunds stay negative)           | ✅ ingesting            |
| **Wikipedia pageviews**             | Wikimedia REST pageviews API                   | Daily article views for a curated public-company map — attention, measured   | ✅ ingesting            |

`alt-data status` always tells you exactly what your build ingests — sources that aren't implemented
yet say so out loud instead of pretending.

## Quickstart

Zero keys, zero infrastructure. The only identity LuxAlgo Alt Data ever sends is a contact email inside the
User-Agent that the SEC's fair-access policy requires for EDGAR.

```bash
# 1. Pull data — short-sale volume needs nothing at all:
npx @luxalgo/alt-data-cli sync --source finra

# 2. Insider filings need the SEC-required contact email:
npx @luxalgo/alt-data-cli sync --source edgar --contact you@example.com --limit 500

# 3. See what you have:
npx @luxalgo/alt-data-cli status

# 4. Serve it to your AI agent over MCP:
npx @luxalgo/alt-data-cli serve
```

Or skip ingestion entirely — the published dumps are a rebuildable archive, and `alt-data import`
is the exact mirror image of `alt-data export`:

```bash
git clone https://github.com/LuxAlgo/alt-datasets
npx @luxalgo/alt-data-cli import ./alt-datasets
```

From a checkout instead:

```bash
pnpm install && pnpm build
node packages/cli/dist/index.js sync --source finra
```

Everything is incremental and idempotent: `alt-data sync` picks up where it left off (per-source
watermarks) and re-running never duplicates a row (natural-key upserts). SQLite by default;
`--db postgres://…` is the same store behind one flag.

## Ask your agent, get receipts

`alt-data-mcp` serves the whole store to any MCP client — locally over stdio, or hosted over
stateless streamable HTTP. Every answer carries primary-source citations: when an agent tells you
what Congress bought this week, it can show you the actual filings.

```jsonc
// Claude Desktop / Claude Code / any MCP client
{
  "mcpServers": {
    "alt-data": {
      "command": "npx",
      "args": ["-y", "@luxalgo/alt-data-mcp"],
      "env": { "ALT_DATA_DB": "/path/to/alt-data.db" },
    },
  },
}
```

| Tool                           | What it answers                                                            |
| ------------------------------ | -------------------------------------------------------------------------- |
| `alt_data_congress_trades`     | "What did Congress buy this week?" — with per-filing citations             |
| `alt_data_congress_members`    | Resolve member names; who trades most                                      |
| `alt_data_member_profile`      | One member's whole public footprint: trades, committees, top tickers       |
| `alt_data_committees`          | Committee rosters — who sits where, joined to what they trade              |
| `alt_data_insider_trades`      | Form 3/4/5 rows by ticker/insider/code/value, with the SEC code legend     |
| `alt_data_insider_summary`     | Buys vs sells, net shares, notable insiders for a ticker — arithmetic only |
| `alt_data_13f_holders`         | Who holds a security, with share changes vs the prior quarter              |
| `alt_data_13f_manager`         | One manager's holdings ("what does Berkshire hold?")                       |
| `alt_data_gov_contracts`       | Federal contract awards by ticker/recipient/agency                         |
| `alt_data_gov_grants`          | Federal grant awards by ticker/recipient/agency                            |
| `alt_data_gov_contract_totals` | Government revenue over time: award counts + sums per year/quarter         |
| `alt_data_lobbying`            | Lobbying filings by ticker/client/registrant                               |
| `alt_data_short_volume`        | Daily short-sale volume series for a ticker                                |
| `alt_data_patents`             | Granted patents by ticker/assignee                                         |
| `alt_data_clinical_trials`     | Studies by ticker/sponsor/status/phase                                     |
| `alt_data_fda_approvals`       | Drugs@FDA approval actions by ticker/company/drug                          |
| `alt_data_cot`                 | Weekly futures positioning series for a market                             |
| `alt_data_bills`               | Bill status by title/sponsor/policy area — plus who lobbies on that bill   |
| `alt_data_campaign_finance`    | Candidate money: FEC totals + itemized committee→candidate contributions   |
| `alt_data_wiki_pageviews`      | Wikipedia attention series for a company, by ticker or article             |
| `alt_data_search`              | One query across tickers, members, managers, insiders                      |
| `alt_data_freshness`           | How old every dataset is — agents check before they answer                 |

`alt_data_freshness` is first-class on purpose: an agent quoting stale congress data without knowing
it is the failure mode that kills trust. And the committee tools exist because the most-asked
question about congressional trading — "do they trade what they oversee?" — is a **join**, not a
score: LuxAlgo Alt Data gives you both sides of it with receipts and leaves the conclusion to you.

## The dumps

`alt-data export` writes the full store as versioned JSON — daily deltas per dataset, full snapshots
sharded by event year, an RSS feed per dataset, and a manifest with row counts, watermarks, and
per-source health. A scheduled CI workflow publishes them to a public data repository
([`LuxAlgo/alt-datasets`](https://github.com/LuxAlgo/alt-datasets)) so analysts and journalists who
will never run code still get the data — one URL, no signup:

```
congress/trades/2026/2026-08-24.json      # daily delta: what was ingested that day
congress/trades/latest.json               # newest delta, stable URL
congress/trades/feed.xml                  # RSS 2.0 over the newest rows
congress/trades/feeds/by-member/P000197.xml   # per-member feed — follow ONE member
congress/trades/feeds/by-ticker/NVDA.xml      # per-ticker feed — follow ONE stock
congress/trades/snapshot-2026.json.gz     # full history, sharded by event year
congress/trades/snapshot-2026.parquet     # …with a Parquet sibling for columnar tooling
manifest.json                             # row counts, freshness, source health
explorer/index.html                       # zero-build data browser (works on GitHub Pages)
```

The two most time-sensitive datasets (congress trades, insider transactions) also get an intraday
fast lane that tops up their deltas between daily publishes, and a weekly workflow mirrors the
whole data repo to a Hugging Face dataset for `datasets.load_dataset(...)` consumers. The full
contract is in [`docs/alt-datasets.md`](docs/alt-datasets.md).

Code is MIT; **the dumps are CC0** — public-domain-derived government data stays public domain.
See [`data-licenses/`](data-licenses/).

## Alerts without a server

Every dataset directory carries a `feed.xml`: plain RSS 2.0 over the newest ingested rows, each
item a strictly factual one-line restatement of a row whose link goes straight to the
primary-source document. Point a feed reader, a chat integration, or a five-line script at one
URL and you have congress-trade alerts with receipts — no server, no webhooks, no account,
nothing to deploy.

It's also per-entity: `feeds/by-ticker/{TICKER}.xml` under every ticker-bearing dataset, and
`feeds/by-member/{bioguideId}.xml` under congress trades — one URL to follow one stock's insider
filings, or one member's disclosures, and nothing else. Feeds exist for entities active in the
last 30 days (capped at the 200 most active per dataset; the manifest carries the exact counts,
so the cap is never silent).

## Deep history

`alt-data backfill --source edgar --from 2004-01-01` walks a source as far back as its free history
goes — chunked, resumable, watermark-driven, so an interrupted run picks up exactly where it
stopped instead of re-walking covered ground. The `backfill.yml` workflow runs the same engine on
CI and publishes the resulting year-sharded snapshots as release assets on the data repo, so
nobody has to re-crawl a decade of filings that CI already crawled. And because `alt-data import`
rebuilds a store from published dumps, the archive is not a pile of downloads — it's a restorable
database. Per-source depth notes: [`docs/backfill.md`](docs/backfill.md).

## Bring your own prices

`alt-data analyze congress --prices your-prices.csv` joins disclosed trades against a price series
**you supply** (`date,ticker,close`) and reports the price change over a window after each
disclosure — the classic "what happened after they filed?" table. LuxAlgo Alt Data ships no market data and
computes no scores; the output is arithmetic between public records and your own inputs, every
result carries a disclaimer saying exactly that, disclosed amounts stay ranges, and the timeline
anchors on the **filing** date, because that's when the public actually learned.

`alt-data backtest congress --prices your-prices.csv --member <name> --window 30` goes one step
further: one fixed, fully disclosed strategy (enter at the first close after the disclosure,
exit after the window, equal weight per event) with win rate, mean/median change, and every
skipped event kept in the output with its reason. No parameter fitting, no optimization, no
costs modeled, and disclosed amount ranges are never used as position sizes — the point is an
honest baseline you can reproduce, not a pitch. Details: [`docs/analytics.md`](docs/analytics.md).

## Python

The dumps are plain JSON with Parquet siblings, so nothing about LuxAlgo Alt Data requires JavaScript. The
dependency-light reader in [`python/`](python/) (pandas optional) loads them from a URL or a
checkout:

```python
from alt_datasets import load_snapshot, to_dataframe

rows = load_snapshot("https://raw.githubusercontent.com/LuxAlgo/alt-datasets/main", "congress-trades")
df = to_dataframe(rows)  # plain list[dict] if pandas isn't installed
```

Worked, reproducible examples live in [`notebooks/`](notebooks/) — price change after disclosure
(bring-your-own-prices) and the committee-oversight join.

## Data health

Honesty is the point: pipelines rot, formats drift, and a data project that can't show you its
health isn't one you should trust. Daily canaries fetch each source, assert parse success rates,
and fingerprint page/file formats so drift turns the board red _before_ a parser silently
misparses. This board is generated from the latest canary run:

<!-- HEALTH-BOARD:START -->

| Source                           | Status                       | Last checked |
| -------------------------------- | ---------------------------- | ------------ |
| SEC EDGAR (Forms 3/4/5, 13F-HR)  | ⏳ awaiting first canary run | —            |
| Senate eFD (PTRs)                | ⏳ awaiting first canary run | —            |
| House Clerk (PTRs)               | ⏳ awaiting first canary run | —            |
| USAspending (contracts + grants) | ⏳ awaiting first canary run | —            |
| Senate LDA                       | ⏳ awaiting first canary run | —            |
| FINRA Reg SHO                    | ⏳ awaiting first canary run | —            |
| Committee assignments            | ⏳ awaiting first canary run | —            |
| PatentsView (patents)            | ⏳ awaiting first canary run | —            |
| ClinicalTrials.gov               | ⏳ awaiting first canary run | —            |
| openFDA (Drugs@FDA)              | ⏳ awaiting first canary run | —            |
| CFTC COT                         | ⏳ awaiting first canary run | —            |
| Wikimedia pageviews              | ⏳ awaiting first canary run | —            |
| GovInfo (bill status)            | ⏳ awaiting first canary run | —            |
| FEC campaign finance             | ⏳ awaiting first canary run | —            |

<!-- HEALTH-BOARD:END -->

## Why free

- **MIT code, CC0 data.** The public record belongs to the public — including in machine-readable
  form.
- **Primary sources only.** SEC EDGAR, Senate eFD, the House Clerk, USAspending, the Senate LDA
  API, FINRA, the unitedstates/congress-legislators project, PatentsView, ClinicalTrials.gov,
  openFDA, the CFTC, GPO GovInfo, the FEC, and the Wikimedia pageviews API. Never scraped from
  commercial products.
- **Receipts everywhere.** Every row carries `provenance`: the primary-source URL, retrieval time,
  parser identity, and a confidence tier. Rows extracted from scanned documents are flagged
  `needsReview` instead of silently trusted.
- **No telemetry.** LuxAlgo Alt Data never phones home. The only outbound identity is the SEC-required
  contact email in the EDGAR User-Agent — and it goes to the SEC, nobody else.
- **Fair access, enforced in code.** The EDGAR client is hard-capped at 10 requests/second by a
  rate limiter with a unit test, not by a sentence in a README.

## Non-goals

Things LuxAlgo Alt Data deliberately does not do:

- **No predictions, signals, scores, or "conviction" ratings.** LuxAlgo Alt Data is data with receipts, not
  advice. `shortRatio`, buy/sell counts, and `alt-data analyze`'s price changes are arithmetic, not
  recommendations.
- **No fabricated precision.** Congressional amounts are disclosed as ranges; LuxAlgo Alt Data stores the
  range bounds and never invents midpoints — not even in analytics output.
- **No social/Reddit sentiment.** Redistribution restrictions make it unshippable in dumps; it
  doesn't belong here.
- **No scraping of commercial data products.** If it isn't a primary source, it isn't in LuxAlgo Alt Data.
- **No editorially curated calendars presented as public record.** LuxAlgo Alt Data ships the FDA's own
  record of approval actions (Drugs@FDA); it does not ship hand-maintained future-decision-date
  calendars or any other dataset that needs human curation to exist.
- **No data whose license forbids open redistribution.** Free-to-view is not free-to-republish:
  FINRA's OTC/ATS transparency product, for example, stays out of the CC0 dumps because its
  terms don't permit it — the investigation and decision are documented in
  [`docs/decisions/0004-ats-otc-data-licensing.md`](docs/decisions/0004-ats-otc-data-licensing.md).

## Architecture

```
packages/
  core/   @luxalgo/alt-data-core  — ingestors, parsers, zod schemas (source of truth),
                                  storage (SQLite default / Postgres via one flag),
                                  entity resolution, backfill, dump export/import,
                                  BYO-prices analytics, canaries
  mcp/    @luxalgo/alt-data-mcp   — MCP server: stdio + stateless streamable HTTP
  cli/    @luxalgo/alt-data-cli   — alt-data sync | status | export | import | backfill |
                                  resolve | analyze | backtest | canary | serve
python/   alt-datasets           — dependency-light reader for the published dumps
notebooks/                      — worked examples over the dumps (no keys, reproducible)
templates/alt-datasets/          — the data repo's README, LICENSE, and static explorer
```

Design decisions are documented in [`docs/decisions/`](docs/decisions/), per-source
implementation notes in [`docs/sources/`](docs/sources/), operations in
[`docs/operations.md`](docs/operations.md), and the golden-file testing policy in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Code: [MIT](LICENSE) © LuxAlgo. Published data dumps: [CC0](data-licenses/DATA-LICENSE).
