import { addDays } from "../lib/dates.js";
import type { PriceSeries } from "./prices.js";
import { ANALYTICS_DISCLAIMER, type AnalyticsEvent } from "./event-returns.js";

/**
 * The bring-your-own-prices backtester: one fixed, transparent strategy —
 * equal weight per event, entry at the first close on/after disclosure,
 * exit at the first close `windowDays` later — applied mechanically to
 * whatever events and prices the caller supplies. LuxAlgo Market Trackers ships no
 * price data, computes no scores or signals, and this module does not
 * change that: it is `eventPriceChange`'s arithmetic (`prices.ts` /
 * `event-returns.ts`) restated as "a backtest" because that is the
 * vocabulary readers bring to it, not because anything new is modeled.
 *
 * There is exactly one strategy and it cannot be tuned: no parameter
 * sweep, no optimizer, no "best window" search, no position sizing from a
 * disclosed amount range. A result is a set of numbers describing what
 * already happened to a price the caller supplied — never a suggestion of
 * what to do next.
 */

/** The only implemented entry rule — named so a future rule would be an addition, never a silent change. */
export const BACKTEST_ENTRY_RULE = "filed-close" as const;
export type BacktestEntryRule = typeof BACKTEST_ENTRY_RULE;

/**
 * Fixed methodology disclosures, printed alongside `disclaimer` on every
 * result and every output path (human and `--json`) — structural, not
 * commentary added after the fact.
 */
export const BACKTEST_DATA_NOTES: readonly string[] = [
  "Equal weight per event: every event contributes the same weight to the aggregate, regardless of the size of the underlying disclosed transaction.",
  "Disclosed transaction amount ranges are never converted into a position size or a dollar return — only a per-event price percentage change is computed.",
  "Entry is the first available close on or after the event's disclosure date (never the underlying transaction date, and never before the information was public); exit is the first available close on or after disclosure date + windowDays.",
  "No transaction costs, slippage, dividends, borrow costs, or taxes are modeled — changePct is a plain (exit - entry) / entry.",
  "A forward-filled entry or exit close (the nearest later trading day found in the supplied prices, not an exact match on the requested date) is flagged per event via entry.forwardFilled / exit.forwardFilled — never presented as if it were the exact date's price.",
];

export interface BacktestEventRowPriced {
  status: "priced";
  event: AnalyticsEvent;
  entry: { date: string; close: number; forwardFilled: boolean };
  exit: { date: string; close: number; forwardFilled: boolean };
  changePct: number;
}

export interface BacktestEventRowSkipped {
  status: "skipped";
  event: AnalyticsEvent;
  reason: string;
}

export type BacktestEventRow = BacktestEventRowPriced | BacktestEventRowSkipped;

export interface BacktestAggregate {
  events: number;
  priced: number;
  skipped: number;
  /** Plain arithmetic mean of changePct across priced events; null when none priced. Descriptive only — not a forecast. */
  meanChangePct: number | null;
  /** Plain median of changePct across priced events; null when none priced. Descriptive only — not a forecast. */
  medianChangePct: number | null;
  /** Share (0-1) of priced events with changePct > 0; null when none priced. */
  winRate: number | null;
  bestChangePct: number | null;
  worstChangePct: number | null;
}

export interface BacktestResult {
  windowDays: number;
  entry: BacktestEntryRule;
  rows: BacktestEventRow[];
  aggregate: BacktestAggregate;
  disclaimer: string;
  dataNotes: readonly string[];
}

export interface RunBacktestOptions {
  events: readonly AnalyticsEvent[];
  prices: PriceSeries;
  /** Days after `event.eventDate` at which to exit. */
  windowDays: number;
  /** The only supported value. Named explicitly rather than assumed, so a future rule is an addition, not a silent behavior change. */
  entry?: BacktestEntryRule;
  /**
   * Forwarded to `PriceSeries.closeOn` for both the entry and exit lookup —
   * see prices.ts. Default 7. A data-availability accommodation
   * (weekends/holidays in the caller's price file), never a model.
   */
  searchForwardDays?: number;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((total, x) => total + x, 0) / xs.length;
}

/** `sortedAscending` must be non-empty and sorted ascending; the one call site guarantees it. */
function median(sortedAscending: readonly number[]): number {
  const mid = Math.floor(sortedAscending.length / 2);
  if (sortedAscending.length % 2 === 1) return sortedAscending[mid] as number;
  const lower = sortedAscending[mid - 1] as number;
  const upper = sortedAscending[mid] as number;
  return (lower + upper) / 2;
}

/**
 * Runs the one fixed backtest strategy over `events` against the
 * caller-supplied `prices`: for each event, entry is the first close on/after
 * `event.eventDate` (already the disclosure date — see `AnalyticsEvent` and
 * the adapters that build these events from stored rows, which anchor to
 * `filedAt`, never the transaction date) and exit is the first close on/after
 * `event.eventDate + windowDays`; `changePct = (exit - entry) / entry`.
 * Every event contributes exactly one row, priced or skipped-with-reason —
 * never dropped — and the disclaimer and data notes are always present,
 * whether or not any event actually priced.
 */
export function runBacktest(options: RunBacktestOptions): BacktestResult {
  if (options.entry !== undefined && options.entry !== BACKTEST_ENTRY_RULE) {
    throw new Error(
      `Unsupported backtest entry rule '${options.entry}' — only '${BACKTEST_ENTRY_RULE}' is implemented.`,
    );
  }
  const { events, prices, windowDays } = options;
  const searchForwardDays = options.searchForwardDays ?? 7;

  const rows: BacktestEventRow[] = events.map((event) => {
    const entryLookup = prices.closeOn(event.ticker, event.eventDate, { searchForwardDays });
    if (!entryLookup.found) {
      return {
        status: "skipped",
        event,
        reason: `entry price unavailable — ${entryLookup.reason}`,
      };
    }
    const exitDate = addDays(event.eventDate, windowDays);
    const exitLookup = prices.closeOn(event.ticker, exitDate, { searchForwardDays });
    if (!exitLookup.found) {
      return { status: "skipped", event, reason: `exit price unavailable — ${exitLookup.reason}` };
    }
    const changePct = (exitLookup.point.close - entryLookup.point.close) / entryLookup.point.close;
    return {
      status: "priced",
      event,
      entry: {
        date: entryLookup.point.date,
        close: entryLookup.point.close,
        forwardFilled: entryLookup.forwardFilled,
      },
      exit: {
        date: exitLookup.point.date,
        close: exitLookup.point.close,
        forwardFilled: exitLookup.forwardFilled,
      },
      changePct,
    };
  });

  const priced = rows.filter((row): row is BacktestEventRowPriced => row.status === "priced");
  const changePcts = priced.map((row) => row.changePct);
  const sortedChangePcts = [...changePcts].sort((a, b) => a - b);
  const wins = priced.filter((row) => row.changePct > 0).length;

  return {
    windowDays,
    entry: BACKTEST_ENTRY_RULE,
    rows,
    aggregate: {
      events: events.length,
      priced: priced.length,
      skipped: events.length - priced.length,
      meanChangePct: changePcts.length > 0 ? mean(changePcts) : null,
      medianChangePct: sortedChangePcts.length > 0 ? median(sortedChangePcts) : null,
      winRate: priced.length > 0 ? wins / priced.length : null,
      bestChangePct: changePcts.length > 0 ? Math.max(...changePcts) : null,
      worstChangePct: changePcts.length > 0 ? Math.min(...changePcts) : null,
    },
    disclaimer: ANALYTICS_DISCLAIMER,
    dataNotes: BACKTEST_DATA_NOTES,
  };
}
