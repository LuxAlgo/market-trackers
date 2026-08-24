import { z } from "zod";
import type { DocketStore } from "../store/store.js";
import type { Logger } from "../lib/logger.js";
import { hoursSince } from "../lib/dates.js";
import { COMPANY_TICKERS_URL, type EdgarClient } from "../sources/edgar/client.js";
import { padCik } from "../sources/edgar/full-submission.js";

/**
 * CIK↔ticker resolution from the SEC's official company_tickers.json —
 * free, keyless, and the ground truth for issuer↔symbol joins. Cached in the
 * store and refreshed at most once per `maxAgeDays`.
 */

const companyTickersSchema = z.record(
  z.string(),
  z.object({
    cik_str: z.number(),
    ticker: z.string(),
    title: z.string(),
  }),
);

export async function refreshCikTickersIfStale(
  store: DocketStore,
  client: EdgarClient,
  logger: Logger,
  maxAgeDays = 7,
): Promise<{ refreshed: boolean; entries: number }> {
  const refreshedAt = await store.cikTickersRefreshedAt();
  const count = await store.cikTickerCount();
  if (refreshedAt !== null && count > 0 && hoursSince(refreshedAt) < maxAgeDays * 24) {
    return { refreshed: false, entries: count };
  }

  logger.info("refreshing SEC company↔ticker map");
  const raw = await client.json<unknown>(COMPANY_TICKERS_URL);
  const parsed = companyTickersSchema.parse(raw);
  const entries = Object.values(parsed).map((entry) => ({
    cik: padCik(entry.cik_str),
    ticker: entry.ticker.toUpperCase(),
    name: entry.title,
  }));
  await store.replaceCikTickers(entries);
  logger.info(`company↔ticker map refreshed: ${entries.length} entries`);
  return { refreshed: true, entries: entries.length };
}
