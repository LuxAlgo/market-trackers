#!/usr/bin/env node
/*
  The LuxAlgo Alt Data CLI: sync the public record of US markets into a local
  database, inspect it, serve it over MCP, and export it as JSON dumps.
  Keyless by design — the only identity ever sent is the contact email the
  SEC requires in the EDGAR User-Agent. No telemetry.
*/
import { Command } from "commander";
import { ALT_DATA_VERSION } from "@luxalgo/alt-data-core";
import { syncCommand } from "./commands/sync.js";
import { statusCommand } from "./commands/status.js";
import { exportCommand } from "./commands/export.js";
import { canaryCommand } from "./commands/canary.js";
import { serveCommand } from "./commands/serve.js";
import { resolveCommand } from "./commands/resolve.js";
import { importCommand } from "./commands/import.js";
import { backfillCommand } from "./commands/backfill.js";
import { analyzeCommand } from "./commands/analyze.js";
import { backtestCommand } from "./commands/backtest.js";

const program = new Command();

// Success paths set process.exitCode and let the event loop drain instead of
// calling process.exit(): exit() tears the process down with stdout still
// buffered, and a piped consumer (`alt-data ... --json | tee`) then receives
// the JSON truncated at the pipe's capacity (observed at ~64KB once a
// backfill summary grew past it). Every command closes its store/handles, so
// draining is prompt. fail() keeps the hard exit — its one stderr line
// flushes synchronously, and an error must never be able to hang the CLI.
function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`alt-data: ${message}\n`);
  process.exit(1);
}

function globalOptions(cmd: Command): Command {
  return cmd
    .option("--db <url>", "SQLite path or postgres:// url (default: ALT_DATA_DB or ./alt-data.db)")
    .option("--contact <email>", "contact email for the SEC EDGAR User-Agent (or ALT_DATA_CONTACT)")
    .option("--log <level>", "log level: debug|info|warn|error|silent")
    .option("--json", "machine-readable JSON on stdout");
}

program
  .name("alt-data")
  .description(
    "The public record of US markets — congress trades, insider filings, 13F holdings, government contracts, lobbying, short-sale volume — synced from primary sources to a local database.",
  )
  .version(ALT_DATA_VERSION);

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
    .option("--limit <n>", "soft cap on documents fetched (for demos/smoke tests)")
    .option(
      "--allow-partial",
      "exit 0 when at least one source succeeds (per-source errors stay in the summary)",
    ),
).action(async (flags) => {
  try {
    process.exitCode = await syncCommand(flags);
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program.command("status").description("Show dataset freshness, source health, and watermarks"),
).action(async (flags) => {
  try {
    process.exitCode = await statusCommand(flags);
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("export")
    .description("Write daily JSON deltas, snapshots, and a manifest (the alt-datasets layout)")
    .option("--out <dir>", "output directory (default: ./dumps)")
    .option("--dataset <ids>", "comma-separated datasets to export")
    .option("--no-snapshot", "skip full snapshot files")
    .option(
      "--snapshots-only",
      "write only snapshot shards + manifest.json (skip deltas, latest.json, feed.xml, and entity feeds)",
    ),
).action(async (flags) => {
  try {
    process.exitCode = await exportCommand(flags);
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
    process.exitCode = await canaryCommand(flags);
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
    process.exitCode = await resolveCommand(what, flags);
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("import <path>")
    .description(
      "Rebuild or top up the store from published dumps (an alt-datasets checkout, a dataset directory, or a single delta/snapshot file) — the mirror image of export",
    )
    .option("--dataset <id>", "dataset id when it can't be inferred from the path"),
).action(async (path, flags) => {
  try {
    process.exitCode = await importCommand(path, flags);
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
    .option("--limit <n>", "soft cap on documents fetched this run")
    .option("--full", "ignore the backfill resume watermark and re-walk the whole window")
    .option(
      "--budget-minutes <n>",
      "stop starting new chunks after this many minutes and exit cleanly for resume",
    ),
).action(async (flags) => {
  try {
    process.exitCode = await backfillCommand(flags);
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("analyze <what>")
    .description(
      "Bring-your-own-prices factual joins over stored rows (LuxAlgo Alt Data ships no price data and computes no scores; see docs/analytics.md)",
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
    process.exitCode = await analyzeCommand(what, flags);
  } catch (error) {
    fail(error);
  }
});

globalOptions(
  program
    .command("backtest <what>")
    .description(
      "Bring-your-own-prices backtest: one fixed, equal-weight, entry-at-disclosure strategy over stored events (LuxAlgo Alt Data ships no price data and computes no scores; see docs/analytics.md)",
    )
    .option("--prices <file>", "user-supplied price series (CSV: date,ticker,close)")
    .option("--ticker <t>", "restrict to one ticker")
    .option("--member <name>", "restrict to one member (congress-trades)")
    .option("--since <date>", "earliest event date")
    .option("--window <days>", "days after disclosure at which to exit (default 30)")
    .option("--out <file>", "write the full result to a file"),
).action(async (what, flags) => {
  try {
    process.exitCode = await backtestCommand(what, flags);
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
    process.exitCode = await serveCommand(flags);
  } catch (error) {
    fail(error);
  }
});

program.parseAsync().catch(fail);
