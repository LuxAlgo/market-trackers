import { readFileSync, writeFileSync } from "node:fs";
import {
  ANALYTICS_DISCLAIMER,
  congressTradeEvents,
  insiderTradeEvents,
  parsePriceCsv,
  runBacktest,
  type BacktestResult,
} from "@luxalgo/alt-data-core";
import { openContext, printJson, printTable, type GlobalFlags } from "../context.js";

export interface BacktestFlags extends GlobalFlags {
  prices?: string;
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
 * The bring-your-own-prices backtester (see docs/analytics.md's Backtest
 * section): one fixed, equal-weight, entry-at-disclosure strategy applied to
 * stored events and a user-supplied prices file. LuxAlgo Alt Data ships no
 * price data and computes no scores — the disclaimer and the strategy's data
 * notes are always part of the output, human or --json, and there is no flag
 * that changes the strategy itself.
 */
export async function backtestCommand(what: string, flags: BacktestFlags): Promise<number> {
  const target = WHAT_ALIASES[what.toLowerCase()];
  if (!target) {
    throw new Error(`Unknown backtest target '${what}' — expected 'congress' or 'insider'`);
  }
  if (!flags.prices) {
    throw new Error(`alt-data backtest requires --prices <file> — ${PRICES_CSV_HINT}`);
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
  if (series.size === 0) {
    const malformedNote =
      series.warnings.length > 0 ? ` (${series.warnings.length} malformed row(s) skipped)` : "";
    throw new Error(
      `no usable price rows in '${flags.prices}'${malformedNote} — ${PRICES_CSV_HINT}`,
    );
  }

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

    if (events.length === 0) {
      const kind = target === "congress" ? "congress trade" : "insider transaction";
      throw new Error(
        `no ${kind} events matched — check --ticker/--member/--since, or that the store has been synced or imported`,
      );
    }

    const result = runBacktest({ events, prices: series, windowDays });

    if (flags.out) {
      writeFileSync(flags.out, JSON.stringify(result, null, 2) + "\n");
    }

    if (flags.json) {
      printJson(result);
    } else {
      printHuman(result, series.warnings.length, flags.out);
    }
    // All-skipped is a data answer ("no event in this set had priceable
    // data"), not a failure — the CLI still exits 0 for it.
    return 0;
  } finally {
    await ctx.close();
  }
}

function printHuman(result: BacktestResult, priceWarnings: number, outFile?: string): void {
  process.stdout.write(
    `events: ${result.aggregate.events}  priced: ${result.aggregate.priced}  skipped: ${result.aggregate.skipped}\n`,
  );
  process.stdout.write(
    `mean changePct: ${fmtPct(result.aggregate.meanChangePct)}  median changePct: ${fmtPct(result.aggregate.medianChangePct)}\n`,
  );
  process.stdout.write(
    `winRate: ${fmtPct(result.aggregate.winRate)}  best: ${fmtPct(result.aggregate.bestChangePct)}  worst: ${fmtPct(result.aggregate.worstChangePct)}\n`,
  );
  if (priceWarnings > 0) {
    process.stdout.write(
      `note: ${priceWarnings} malformed row(s) in the prices CSV were skipped\n`,
    );
  }
  process.stdout.write(`\n${ANALYTICS_DISCLAIMER}\n`);
  for (const note of result.dataNotes) process.stdout.write(`- ${note}\n`);
  process.stdout.write("\n");

  const headers = ["label", "eventDate", "entry", "exit", "changePct", "status"];
  const rows = result.rows.map((row) =>
    row.status === "priced"
      ? [
          row.event.label,
          row.event.eventDate,
          `${row.entry.close}${row.entry.forwardFilled ? "*" : ""} (${row.entry.date})`,
          `${row.exit.close}${row.exit.forwardFilled ? "*" : ""} (${row.exit.date})`,
          `${(row.changePct * 100).toFixed(2)}%`,
          "priced",
        ]
      : [row.event.label, row.event.eventDate, "-", "-", "-", `skipped: ${row.reason}`],
  );
  printTable(headers, rows);
  process.stdout.write(
    "\n* forward-filled: nearest later close in the supplied prices, not an exact-date match\n",
  );
  if (outFile) process.stdout.write(`wrote full result to ${outFile}\n`);
}

function fmtPct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
}
