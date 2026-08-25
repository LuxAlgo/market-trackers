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
import { resolveCommand } from "./commands/resolve.js";
import { importCommand } from "./commands/import.js";
import { backfillCommand } from "./commands/backfill.js";
import { analyzeCommand } from "./commands/analyze.js";

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
    .command("resolve <what>")
    .description(
      "Run an entity-resolution loop over stored rows (currently: cusips — CUSIP→ticker for 13F holdings via cached OpenFIGI mappings)",
    )
    .option("--retry-misses", "re-query CUSIPs whose cached resolution was a miss")
    .option("--limit <n>", "cap how many distinct CUSIPs to resolve this run"),
).action(async (what, flags) => {
  try {
    process.exit(await resolveCommand(what, flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("import <path>")
    .description(
      "Rebuild or top up the store from published dumps (a docket-data checkout, a dataset directory, or a single delta/snapshot file) — the mirror image of export",
    )
    .option("--dataset <id>", "dataset id when it can't be inferred from the path"),
).action(async (path, flags) => {
  try {
    process.exit(await importCommand(path, flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("backfill")
    .description(
      "Deep-history backfill: chunked, resumable, watermark-driven walks as far back as the free sources allow (see docs/backfill.md)",
    )
    .option("--source <ids>", "comma-separated sources to backfill")
    .option("--from <date>", "start of the backfill window (YYYY-MM-DD)")
    .option("--to <date>", "end of the backfill window (default: today)")
    .option("--chunk-days <n>", "days per resumable chunk")
    .option("--limit <n>", "soft cap on documents fetched this run"),
).action(async (flags) => {
  try {
    process.exit(await backfillCommand(flags));
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("analyze <what>")
    .description(
      "Bring-your-own-prices factual joins over stored rows (Docket ships no price data and computes no scores; see docs/analytics.md)",
    )
    .option("--prices <file>", "user-supplied price series (CSV: date,ticker,close)")
    .option("--dataset <id>", "dataset to join against")
    .option("--ticker <t>", "restrict to one ticker")
    .option("--member <name>", "restrict to one member (congress-trades)")
    .option("--since <date>", "earliest event date")
    .option("--window <days>", "days after the event to measure")
    .option("--out <file>", "write the result table to a file"),
).action(async (what, flags) => {
  try {
    process.exit(await analyzeCommand(what, flags));
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
