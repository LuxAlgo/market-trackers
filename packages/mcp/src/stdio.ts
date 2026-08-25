#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/alt-data-mcp` runs. Keyless and
  read-only over a local LuxAlgo Alt Data store (ALT_DATA_DB or ./alt-data.db). Populate
  the store with `alt-data sync` from @luxalgo/alt-data-cli.
*/
import { serveStdio } from "./server.js";

await serveStdio();
