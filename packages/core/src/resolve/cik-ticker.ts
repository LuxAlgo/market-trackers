import { z } from "zod";
import type { DocketStore } from "../store/store.js";
import type { Logger } from "../lib/logger.js";
import { hoursSince } from "../lib/dates.js";
import { COMPANY_TICKERS_URL, type EdgarClient } from "../sources/edgar/client.js";
import { padCik } from "../sources/edgar/full-submission.js";

/**
 * CIK↔ticker resolution from the SEC's official company_tickers.json —
 * free, keyless, and the ground truth for issuer↔symbol joins. Cached in the
 * store and refreshed at most once per `maxAgeDays`, via conditional GET:
 * stored ETag/Last-Modified validators are replayed and a 304 just bumps the
 * cache's freshness instead of re-downloading ~1MB of JSON.
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

  // Conditional GET: validators are only sent while a usable local map
  // exists — a 304 with an empty table would otherwise strand us mapless.
  const cached = count > 0 ? await store.getFetchCache(COMPANY_TICKERS_URL) : null;
  logger.info("refreshing SEC company↔ticker map");
  const result = await client.jsonConditional<unknown>(COMPANY_TICKERS_URL, cached);
  if (result.notModified) {
    // Upstream confirmed the map is unchanged: bump freshness, skip the rewrite.
    await store.touchCikTickersRefreshedAt();
    logger.info(`company↔ticker map unchanged upstream (304): ${count} entries kept`);
    return { refreshed: false, entries: count };
  }

  const parsed = companyTickersSchema.parse(result.body);
  const entries = Object.values(parsed).map((entry) => ({
    cik: padCik(entry.cik_str),
    ticker: entry.ticker.toUpperCase(),
    name: entry.title,
  }));
  await store.replaceCikTickers(entries);
  await store.setFetchCache(COMPANY_TICKERS_URL, {
    etag: result.etag,
    lastModified: result.lastModified,
  });
  logger.info(`company↔ticker map refreshed: ${entries.length} entries`);
  return { refreshed: true, entries: entries.length };
}
