#!/usr/bin/env node
/*
  The Docket CLI: sync the public record of US markets into a local
  database, inspect it, serve it over MCP, and export it as JSON dumps.
  Keyless by design — the only identity ever sent is the contact email the
  SEC requires in the EDGAR User-Agent. No telemetry.
*/
import { Command } from "commander";
import { DOCKET_VERSION } from "@luxalgo/docket-core";
import { syncCommand } from "./commands/sync.js";
import { statusCommand } from "./commands/status.js";
import { exportCommand } from "./commands/export.js";
import { canaryCommand } from "./commands/canary.js";
import { serveCommand } from "./commands/serve.js";

const program = new Command();

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`docket: ${message}\n`);
  process.exit(1);
}

function globalOptions(cmd: Command): Command {
  return cmd
    .option("--db <url>", "SQLite path or postgres:// url (default: DOCKET_DB or ./docket.db)")
    .option("--contact <email>", "contact email for the SEC EDGAR User-Agent (or DOCKET_CONTACT)")
    .option("--log <level>", "log level: debug|info|warn|error|silent")
    .option("--json", "machine-readable JSON on stdout");
}

program
  .name("docket")
  .description(
    "The public record of US markets — congress trades, insider filings, 13F holdings, government contracts, lobbying, short-sale volume — synced from primary sources to a local database.",
  )
  .version(DOCKET_VERSION);

globalOptions(
  program
    .command("sync")
    .description(
      "Incrementally ingest sources into the local store (idempotent; re-runs never duplicate)",
    )
    .option("--source <ids>", "comma-separated sources (default: all implemented)")
    .option("--dataset <ids>", "comma-separated datasets to restrict to")
    .option("--since <date>", "re-walk from this date (YYYY-MM-DD) instead of the watermark")
    .option("--full", "ignore watermarks and re-walk")
    .option("--limit <n>", "soft cap on documents fetched (for demos/smoke tests)"),
).action(async (flags) => {
  try {
    process.exit(await syncCommand(flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program.command("status").description("Show dataset freshness, source health, and watermarks"),
).action(async (flags) => {
  try {
    process.exit(await statusCommand(flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("export")
    .description("Write daily JSON deltas, snapshots, and a manifest (the docket-data layout)")
    .option("--out <dir>", "output directory (default: ./dumps)")
    .option("--dataset <ids>", "comma-separated datasets to export")
    .option("--no-snapshot", "skip full snapshot files"),
).action(async (flags) => {
  try {
    process.exit(await exportCommand(flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("canary")
    .description("Probe every source for drift/breakage and report health (exit 1 on red)")
    .option("--source <ids>", "comma-separated sources (default: all)")
    .option("--out <file>", "also write the JSON report to a file"),
).action(async (flags) => {
  try {
    process.exit(await canaryCommand(flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("serve")
    .description("Serve the local store over MCP (stdio by default; --http for streamable HTTP)")
    .option("--http", "serve streamable HTTP instead of stdio")
    .option("--port <n>", "HTTP port (default 3939)"),
).action(async (flags) => {
  try {
    process.exit(await serveCommand(flags));
  } catch (error) {
    fail(error);
  }
});

program.parseAsync().catch(fail);
