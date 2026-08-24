<div align="center">

# Docket

**The public record, as infrastructure.**

Congress trades, insider filings, 13F holdings, government contracts, lobbying, short-sale volume —
the data the alt-data platforms sell is free. Now it's also open.

[![CI](https://github.com/LuxAlgo/docket/actions/workflows/ci.yml/badge.svg)](https://github.com/LuxAlgo/docket/actions/workflows/ci.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Data: CC0](https://img.shields.io/badge/data-CC0-blue.svg)](data-licenses/DATA-LICENSE)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)](#why-free)

</div>

---

Docket ingests the public record of US markets from **primary sources only**, normalizes it into
one schema, stores it in a local database, serves it to AI agents over **MCP**, and republishes it
as **free daily data dumps**. Every row carries provenance — a working deep link to the primary
document it was parsed from. No API keys, no accounts, no telemetry, no paywall. Commercial
platforms charge $30–75/month for API access to this data; the sources are free, and so is this.

## Datasets

| Dataset                  | Primary source                                 | What you get                                                                | Status in this build |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| **Congress trades**      | Senate eFD + House Clerk financial disclosures | Every reported transaction, amounts as disclosed ranges, member identities  | ✅ ingesting         |
| **Insider transactions** | SEC EDGAR Forms 3/4/5 (primary XML)            | Every insider transaction and holding row, raw SEC codes + legend           | ✅ ingesting         |
| **13F holdings**         | SEC EDGAR 13F-HR information tables            | Quarterly institutional holdings, CUSIP-keyed, values normalized to dollars | ✅ ingesting         |
| **Government contracts** | USAspending API                                | Federal awards with best-effort recipient→ticker mapping                    | ✅ ingesting         |
| **Lobbying**             | Senate LDA API                                 | Lobbying filings with client→ticker mapping                                 | ✅ ingesting         |
| **Short-sale volume**    | FINRA Reg SHO daily files                      | Symbol-day short volume + short ratio, both pre- and post-2026 file formats | ✅ ingesting         |

`docket status` always tells you exactly what your build ingests — sources that aren't implemented
yet say so out loud instead of pretending.

## Quickstart

Zero keys, zero infrastructure. The only identity Docket ever sends is a contact email inside the
User-Agent that the SEC's fair-access policy requires for EDGAR.

```bash
# 1. Pull data — short-sale volume needs nothing at all:
npx @luxalgo/docket-cli sync --source finra

# 2. Insider filings need the SEC-required contact email:
npx @luxalgo/docket-cli sync --source edgar --contact you@example.com --limit 500

# 3. See what you have:
npx @luxalgo/docket-cli status

# 4. Serve it to your AI agent over MCP:
npx @luxalgo/docket-cli serve
```

From a checkout instead:

```bash
pnpm install && pnpm build
node packages/cli/dist/index.js sync --source finra
```

Everything is incremental and idempotent: `docket sync` picks up where it left off (per-source
watermarks) and re-running never duplicates a row (natural-key upserts). SQLite by default;
`--db postgres://…` is the same store behind one flag.

## Ask your agent, get receipts

`docket-mcp` serves the whole store to any MCP client — locally over stdio, or hosted over
stateless streamable HTTP. Every answer carries primary-source citations: when an agent tells you
what Congress bought this week, it can show you the actual filings.

```jsonc
// Claude Desktop / Claude Code / any MCP client
{
  "mcpServers": {
    "docket": {
      "command": "npx",
      "args": ["-y", "@luxalgo/docket-mcp"],
      "env": { "DOCKET_DB": "/path/to/docket.db" },
    },
  },
}
```

| Tool                      | What it answers                                                            |
| ------------------------- | -------------------------------------------------------------------------- |
| `docket_congress_trades`  | "What did Congress buy this week?" — with per-filing citations             |
| `docket_congress_members` | Resolve member names; who trades most                                      |
| `docket_insider_trades`   | Form 3/4/5 rows by ticker/insider/code/value, with the SEC code legend     |
| `docket_insider_summary`  | Buys vs sells, net shares, notable insiders for a ticker — arithmetic only |
| `docket_13f_holders`      | Who holds a security, with share changes vs the prior quarter              |
| `docket_13f_manager`      | One manager's holdings ("what does Berkshire hold?")                       |
| `docket_gov_contracts`    | Federal awards by ticker/recipient/agency                                  |
| `docket_lobbying`         | Lobbying filings by ticker/client/registrant                               |
| `docket_short_volume`     | Daily short-sale volume series for a ticker                                |
| `docket_search`           | One query across tickers, members, managers, insiders                      |
| `docket_freshness`        | How old every dataset is — agents check before they answer                 |

`docket_freshness` is first-class on purpose: an agent quoting stale congress data without knowing
it is the failure mode that kills trust.

## The dumps

`docket export` writes the full store as versioned JSON — daily deltas per dataset, full gzipped
snapshots, and a manifest with row counts, watermarks, and per-source health. A scheduled CI
workflow publishes them to a public data repository (`LuxAlgo/docket-data`) so analysts and
journalists who will never run code still get the data — one URL, no signup:

```
congress/trades/2026/2026-08-24.json      # what was ingested that day
congress/trades/latest.json               # newest delta, stable URL
congress/trades/snapshot.json.gz          # the whole dataset
manifest.json                             # row counts, freshness, source health
```

Code is MIT; **the dumps are CC0** — public-domain-derived government data stays public domain.
See [`data-licenses/`](data-licenses/).

## Data health

Honesty is the point: pipelines rot, formats drift, and a data project that can't show you its
health isn't one you should trust. Daily canaries fetch each source, assert parse success rates,
and fingerprint page/file formats so drift turns the board red _before_ a parser silently
misparses. This board is generated from the latest canary run:

<!-- HEALTH-BOARD:START -->

| Source                          | Status                       | Last checked |
| ------------------------------- | ---------------------------- | ------------ |
| SEC EDGAR (Forms 3/4/5, 13F-HR) | ⏳ awaiting first canary run | —            |
| Senate eFD (PTRs)               | ⏳ awaiting first canary run | —            |
| House Clerk (PTRs)              | ⏳ awaiting first canary run | —            |
| USAspending                     | ⏳ awaiting first canary run | —            |
| Senate LDA                      | ⏳ awaiting first canary run | —            |
| FINRA Reg SHO                   | ⏳ awaiting first canary run | —            |

<!-- HEALTH-BOARD:END -->

## Why free

- **MIT code, CC0 data.** The public record belongs to the public — including in machine-readable
  form.
- **Primary sources only.** SEC EDGAR, Senate eFD, the House Clerk, USAspending, the Senate LDA
  API, FINRA. Never scraped from commercial products.
- **Receipts everywhere.** Every row carries `provenance`: the primary-source URL, retrieval time,
  parser identity, and a confidence tier. Rows extracted from scanned documents are flagged
  `needsReview` instead of silently trusted.
- **No telemetry.** Docket never phones home. The only outbound identity is the SEC-required
  contact email in the EDGAR User-Agent — and it goes to the SEC, nobody else.
- **Fair access, enforced in code.** The EDGAR client is hard-capped at 10 requests/second by a
  rate limiter with a unit test, not by a sentence in a README.

## Non-goals

Things Docket deliberately does not do:

- **No predictions, signals, scores, or "conviction" ratings.** Docket is data with receipts, not
  advice. `shortRatio` and buy/sell counts are arithmetic, not recommendations.
- **No fabricated precision.** Congressional amounts are disclosed as ranges; Docket stores the
  range bounds and never invents midpoints.
- **No social/Reddit sentiment.** Redistribution restrictions make it unshippable in dumps; it
  doesn't belong here.
- **No scraping of commercial data products.** If it isn't a primary source, it isn't in Docket.
- **No editorially curated calendars** (e.g. FDA decision dates) presented as if they were public
  record. Datasets that require human curation are out of scope until they can ship honestly.

## Architecture

```
packages/
  core/   @luxalgo/docket-core  — ingestors, parsers, zod schemas (source of truth),
                                  storage (SQLite default / Postgres via one flag),
                                  entity resolution, dump export, canaries
  mcp/    @luxalgo/docket-mcp   — MCP server: stdio + stateless streamable HTTP
  cli/    @luxalgo/docket-cli   — docket sync | status | export | canary | serve
```

Design decisions are documented in [`docs/decisions/`](docs/decisions/), per-source
implementation notes in [`docs/sources/`](docs/sources/), and the golden-file testing policy in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Code: [MIT](LICENSE) © LuxAlgo. Published data dumps: [CC0](data-licenses/DATA-LICENSE).
