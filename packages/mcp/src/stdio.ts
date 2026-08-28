#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/market-trackers-mcp` runs. Keyless and
  read-only over a local LuxAlgo Market Trackers store (MARKET_TRACKERS_DB or ./market-trackers.db). Populate
  the store with `market-trackers sync` from @luxalgo/market-trackers-cli.
*/
import { serveStdio } from "./server.js";

await serveStdio();
