#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/docket-mcp` runs. Keyless and
  read-only over a local Docket store (DOCKET_DB or ./docket.db). Populate
  the store with `docket sync` from @luxalgo/docket-cli.
*/
import { serveStdio } from "./server.js";

await serveStdio();
