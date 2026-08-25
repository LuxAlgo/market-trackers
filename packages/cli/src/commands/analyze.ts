import { readFileSync, writeFileSync } from "node:fs";
import {
  ANALYTICS_DISCLAIMER,
  congressTradeEvents,
  eventPriceChange,
  insiderTradeEvents,
  parsePriceCsv,
  type EventPriceChangeResult,
} from "@luxalgo/alt-data-core";
import { openContext, printJson, printTable, type GlobalFlags } from "../context.js";

export interface AnalyzeFlags extends GlobalFlags {
  prices?: string;
  dataset?: string;
  ticker?: string;
  member?: string;
  since?: string;
  window?: string;
  out?: string;
}

const PRICES_CSV_HINT =
  "expected a CSV with the header 'date,ticker,close', e.g.:\n" +
  "  date,ticker,close\n" +
  "  2026-08-18,ACME,41.90\n" +
  "  2026-08-25,ACME,43.10";

const WHAT_ALIASES: Record<string, "congress" | "insider"> = {
  congress: "congress",
  "congress-trades": "congress",
  insider: "insider",
  "insider-transactions": "insider",
};

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Bring-your-own-prices factual joins (e.g. price change since a disclosed
 * trade's filing date, computed from a user-supplied prices file). LuxAlgo Alt Data
 * ships no price data and computes no scores — this command only does
 * arithmetic between public-record rows and the caller's own price series,
 * and the disclaimer is always part of the output, human or --json.
 */
export async function analyzeCommand(what: string, flags: AnalyzeFlags): Promise<number> {
  const target = WHAT_ALIASES[what.toLowerCase()];
  if (!target) {
    throw new Error(`Unknown analyze target '${what}' — expected 'congress' or 'insider'`);
  }
  if (!flags.prices) {
    throw new Error(`alt-data analyze requires --prices <file> — ${PRICES_CSV_HINT}`);
  }

  let priceCsvText: string;
  try {
    priceCsvText = readFileSync(flags.prices, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not read prices file '${flags.prices}' (${reason}) — ${PRICES_CSV_HINT}`,
    );
  }
  const series = parsePriceCsv(priceCsvText);

  const windowDays = flags.window ? Number(flags.window) : DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`--window must be a positive number of days (got '${flags.window}')`);
  }

  const ctx = await openContext(flags);
  try {
    const events =
      target === "congress"
        ? await congressTradeEvents(ctx.store, {
            ticker: flags.ticker,
            member: flags.member,
            since: flags.since,
          })
        : await insiderTradeEvents(ctx.store, {
            ticker: flags.ticker,
            since: flags.since,
          });

    const result = eventPriceChange(events, series, { windowDays });

    if (flags.out) {
      writeFileSync(flags.out, JSON.stringify(result, null, 2) + "\n");
    }

    if (flags.json) {
      printJson(result);
    } else {
      printHuman(result, series.warnings.length, flags.out);
    }
    return 0;
  } finally {
    await ctx.close();
  }
}

function printHuman(result: EventPriceChangeResult, priceWarnings: number, outFile?: string): void {
  const headers = ["label", "eventDate", "base", "later", "changePct", "status"];
  const rows = result.rows.map((row) =>
    row.status === "ok"
      ? [
          row.event.label,
          row.event.eventDate,
          `${row.base.close} (${row.base.date})`,
          `${row.later.close} (${row.later.date})`,
          `${(row.changePct * 100).toFixed(2)}%`,
          "ok",
        ]
      : [row.event.label, row.event.eventDate, "-", "-", "-", `skipped: ${row.reason}`],
  );
  printTable(headers, rows);

  process.stdout.write(
    `\nevents: ${result.aggregate.eventsTotal}  ok: ${result.aggregate.eventsOk}  skipped: ${result.aggregate.eventsSkipped}\n`,
  );
  process.stdout.write(
    `mean changePct: ${fmtPct(result.aggregate.meanChangePct)}  median changePct: ${fmtPct(result.aggregate.medianChangePct)}\n`,
  );
  if (priceWarnings > 0) {
    process.stdout.write(
      `note: ${priceWarnings} malformed row(s) in the prices CSV were skipped\n`,
    );
  }
  if (outFile) process.stdout.write(`wrote full result to ${outFile}\n`);
  process.stdout.write(`\n${ANALYTICS_DISCLAIMER}\n`);
}

function fmtPct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
}
