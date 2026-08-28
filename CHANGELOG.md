# Changelog

## 0.1.0 — Initial public release

- 18 datasets ingested from 16 primary sources: congress trades (Senate eFD + House Clerk),
  insider transactions and 13F holdings (SEC EDGAR), government contracts and grants
  (USAspending), lobbying (Senate LDA), short-sale volume (FINRA), committee assignments,
  patents (USPTO Open Data Portal / PatentsView), clinical trials, FDA approvals, CFTC COT,
  Wikipedia pageviews, federal bills (GovInfo), FEC candidates and contributions,
  congressional hearings (GovInfo CHRG), and Federal Reserve communications.
- Every row carries provenance: source id, retrieval time, parser id, and a working deep link
  to the primary document.
- MCP server (`@luxalgo/alt-data-mcp`) with 24 read-only tools over stdio and streamable HTTP.
- CLI (`@luxalgo/alt-data-cli`): sync, backfill, status, export, import, serve, canary,
  resolve, prices, report.
- Daily publishing pipeline: JSON year shards + combined snapshots, Parquet siblings, RSS
  feeds (dataset-, ticker-, and member-level), and a manifest — pushed to the public data
  repository under CC0.
- Source health canaries with fingerprint drift detection and an auto-refreshed README board.
- Dependency-light Python reader (`python/`) for the published dumps.
