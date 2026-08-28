import type { TrackerStore } from "../store/store.js";
import {
  queryCongressTrades,
  queryInsiderTransactions,
  type CongressTradeFilters,
  type InsiderTransactionFilters,
} from "../store/queries.js";
import type { AnalyticsEvent } from "./event-returns.js";

/**
 * Builds `AnalyticsEvent` lists from the existing query layer — never new
 * SQL. Events use `filedAt` (the disclosure date, when the record became
 * public) as `eventDate`, not the underlying transaction date: a price
 * reaction can only be attributed to information the market actually had,
 * and for both congressional and insider filings that's the filing date —
 * the transaction itself is typically earlier and, until filed, non-public.
 *
 * Rows with no resolved ticker are excluded: they cannot be joined to a
 * price series at all. That is a coverage limit of *this join*, not a
 * price-lookup miss — those are reported per-row, with a reason, once
 * `eventPriceChange` runs over the events this module returns.
 */

// The query layer's own interactive default is 50 rows (see DEFAULT_LIMIT
// in store/queries.ts); analytics wants full coverage for a meaningful
// aggregate by default, so this mirrors its MAX_LIMIT instead. Callers can
// still override via filters.limit.
const DEFAULT_EVENT_LIMIT = 500;

export async function congressTradeEvents(
  store: TrackerStore,
  filters: CongressTradeFilters = {},
): Promise<AnalyticsEvent[]> {
  const trades = await queryCongressTrades(store, {
    ...filters,
    limit: filters.limit ?? DEFAULT_EVENT_LIMIT,
  });
  const events: AnalyticsEvent[] = [];
  for (const trade of trades) {
    if (!trade.ticker) continue;
    events.push({
      ticker: trade.ticker,
      eventDate: trade.filedAt,
      label: `${trade.member.name} (${trade.chamber}) ${trade.side} ${trade.ticker}`,
      citation: trade.provenance.sourceUrl,
    });
  }
  return events;
}

export async function insiderTradeEvents(
  store: TrackerStore,
  filters: InsiderTransactionFilters = {},
): Promise<AnalyticsEvent[]> {
  const transactions = await queryInsiderTransactions(store, {
    ...filters,
    limit: filters.limit ?? DEFAULT_EVENT_LIMIT,
  });
  const events: AnalyticsEvent[] = [];
  for (const tx of transactions) {
    if (!tx.ticker) continue;
    events.push({
      ticker: tx.ticker,
      eventDate: tx.filedAt,
      label: `${tx.insider.name} (${tx.ticker}) ${tx.code ?? "holding"}`,
      citation: tx.provenance.sourceUrl,
    });
  }
  return events;
}
