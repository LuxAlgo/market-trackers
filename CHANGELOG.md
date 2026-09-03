# Changelog

## Unreleased

### Fixed

- USAspending walks enumerate every award once. Windows are bounded on the signing date
  (`date_type: "new_awards_only"`), sorted on the same field (`Base Obligation Date`, now the
  row's `actionDate`, falling back to `Start Date`), and paged with search_after cursors past
  the server's result window. Previously each window matched every long-running award with any
  later activity and stopped at the result window, so a multi-year backfill re-fetched the same
  oldest ~20k awards per chunk; the live watermark had also drifted to 2027 on
  period-of-performance start dates and frozen the daily sync. A future watermark is now
  treated as today and rewritten, and the watermark never advances past the walked window.
- USAspending syncs report `stoppedEarly` / `completedThrough` on a deadline, `--limit`, or
  upstream stop, so the backfill engine resumes to the day instead of skipping the rest of the
  chunk.
- Backfill engine: an upstream stop inside a chunk banks the covered days and retries once
  from there after the cooldown (a retry that makes progress earns another), instead of
  ending the run at the first blip.

## 0.1.0 — Initial public release

- 18 datasets ingested from 16 primary sources: congress trades (Senate eFD + House Clerk),
  insider transactions and 13F holdings (SEC EDGAR), government contracts and grants
  (USAspending), lobbying (Senate LDA), short-sale volume (FINRA), committee assignments,
  patents (USPTO Open Data Portal / PatentsView), clinical trials, FDA approvals, CFTC COT,
  Wikipedia pageviews, federal bills (GovInfo), FEC candidates and contributions,
  congressional hearings (GovInfo CHRG), and Federal Reserve communications.
- Every row carries provenance: source id, retrieval time, parser id, and a working deep link
  to the primary document.
- MCP server (`@luxalgo/market-trackers-mcp`) with 24 read-only tools over stdio and streamable HTTP.
- CLI (`@luxalgo/market-trackers-cli`): sync, backfill, status, export, import, serve, canary,
  resolve, prices, report.
- Daily publishing pipeline: JSON year shards + combined snapshots, Parquet siblings, RSS
  feeds (dataset-, ticker-, and member-level), and a manifest — pushed to the public data
  repository under CC0.
- Source health canaries with fingerprint drift detection and an auto-refreshed README board.
- Dependency-light Python reader (`python/`) for the published dumps.
