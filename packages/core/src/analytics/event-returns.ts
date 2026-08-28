import { addDays } from "../lib/dates.js";
import type { PriceSeries } from "./prices.js";

/**
 * Deterministic arithmetic between a public-record event and a
 * user-supplied price series — nothing more. LuxAlgo Market Trackers computes no scores,
 * signals, ratings, or predictions; this module reports a plain percentage
 * change between two closes the caller's own data already contains,
 * alongside every event it could *not* price (never dropped silently, always
 * with a reason) and the disclaimer below, which every result object
 * carries.
 */
export const ANALYTICS_DISCLAIMER =
  "Descriptive arithmetic over public records and user-supplied prices. Not investment advice; no predictive claim is made.";

export interface AnalyticsEvent {
  ticker: string;
  /**
   * YYYY-MM-DD — the disclosure date (when the record became public
   * information), not necessarily when the underlying transaction
   * happened. A price reaction can only be attributed to what the market
   * actually knew.
   */
  eventDate: string;
  label: string;
  /** `provenance.sourceUrl` of the record this event was built from. */
  citation: string;
}

export interface EventPriceChangeOk {
  status: "ok";
  event: AnalyticsEvent;
  base: { date: string; close: number };
  later: { date: string; close: number };
  changePct: number;
}

export interface EventPriceChangeSkipped {
  status: "skipped";
  event: AnalyticsEvent;
  reason: string;
}

export type EventPriceChangeRow = EventPriceChangeOk | EventPriceChangeSkipped;

export interface EventPriceChangeAggregate {
  eventsTotal: number;
  eventsOk: number;
  eventsSkipped: number;
  /** Plain arithmetic mean of changePct across priced ("ok") events; null when none priced. Descriptive only — not a forecast. */
  meanChangePct: number | null;
  /** Plain median of changePct across priced ("ok") events; null when none priced. Descriptive only — not a forecast. */
  medianChangePct: number | null;
}

export interface EventPriceChangeResult {
  windowDays: number;
  rows: EventPriceChangeRow[];
  aggregate: EventPriceChangeAggregate;
  disclaimer: string;
}

export interface EventPriceChangeOptions {
  /** Days after `eventDate` at which to measure the "later" price. */
  windowDays: number;
  /**
   * Forwarded to `PriceSeries.closeOn` for both the base and later lookup —
   * how many days forward of the requested date to accept a later trading
   * day's close as a stand-in (weekends/holidays in the caller's price
   * file). Default 7. A data-availability accommodation, not a model.
   */
  searchForwardDays?: number;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((total, x) => total + x, 0) / xs.length;
}

/** `sortedAscending` must be non-empty and sorted ascending; both call sites guarantee it. */
function median(sortedAscending: readonly number[]): number {
  const mid = Math.floor(sortedAscending.length / 2);
  if (sortedAscending.length % 2 === 1) return sortedAscending[mid] as number;
  const lower = sortedAscending[mid - 1] as number;
  const upper = sortedAscending[mid] as number;
  return (lower + upper) / 2;
}

/**
 * For each event, the plain percentage change between the close on/after
 * `eventDate` and the close on/after `eventDate + windowDays`, from a price
 * series the caller supplied. Events whose base or later price is missing
 * are reported with a reason under `status: "skipped"` — never dropped —
 * so a reader can see exactly what was, and wasn't, priced.
 */
export function eventPriceChange(
  events: readonly AnalyticsEvent[],
  series: PriceSeries,
  options: EventPriceChangeOptions,
): EventPriceChangeResult {
  const searchForwardDays = options.searchForwardDays ?? 7;

  const rows: EventPriceChangeRow[] = events.map((event) => {
    const base = series.closeOn(event.ticker, event.eventDate, { searchForwardDays });
    if (!base.found) {
      return { status: "skipped", event, reason: `base price unavailable — ${base.reason}` };
    }
    const laterDate = addDays(event.eventDate, options.windowDays);
    const later = series.closeOn(event.ticker, laterDate, { searchForwardDays });
    if (!later.found) {
      return { status: "skipped", event, reason: `later price unavailable — ${later.reason}` };
    }
    const changePct = (later.point.close - base.point.close) / base.point.close;
    return {
      status: "ok",
      event,
      base: { date: base.point.date, close: base.point.close },
      later: { date: later.point.date, close: later.point.close },
      changePct,
    };
  });

  const changePcts = rows
    .filter((row): row is EventPriceChangeOk => row.status === "ok")
    .map((row) => row.changePct)
    .sort((a, b) => a - b);

  return {
    windowDays: options.windowDays,
    rows,
    aggregate: {
      eventsTotal: events.length,
      eventsOk: changePcts.length,
      eventsSkipped: events.length - changePcts.length,
      meanChangePct: changePcts.length > 0 ? mean(changePcts) : null,
      medianChangePct: changePcts.length > 0 ? median(changePcts) : null,
    },
    disclaimer: ANALYTICS_DISCLAIMER,
  };
}
