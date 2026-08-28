import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { WikiPageview } from "../../schema/wiki-pageview.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import type { PoliteFetch } from "../../lib/http.js";
import { wikiArticleMap } from "./article-map.js";
import {
  createWikimediaFetch,
  fetchArticleRange,
  pageviewItemFingerprint,
  pageviewsUrl,
} from "./client.js";
import { normalizePageviewItem } from "./parser.js";

export { WIKIMEDIA_API_BASE, pageviewsUrl } from "./client.js";
export { WIKIMEDIA_PARSER } from "./parser.js";

/**
 * Wikimedia REST pageviews (keyless; counts are CC0). Walks the curated
 * article↔ticker map in `data/wiki-articles.json`, issuing exactly one
 * ranged request per article per run and storing one row per article-day
 * the response actually contains.
 *
 * The per-article watermark discipline mirrors `finra-shortvol/source.ts`
 * (per-key watermark, forward-only advance, a definitive "nothing here"
 * answer still completes the walk) — but the unit of work is "one
 * article's day range" rather than "one day's file", since this endpoint
 * is natively ranged rather than paged.
 */

const FINGERPRINT_KEY = "pageviews.item-fields";
/** Canary probe window: 7 days, ending 2 days ago — extra lag tolerance beyond sync's own 1-day cutoff. */
const CANARY_WINDOW_DAYS = 7;
const CANARY_LAG_DAYS = 2;

function watermarkKey(project: string, article: string): string {
  return `pageviews.${project}.${article}.lastDay`;
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createWikimediaFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("wikimedia"),
  });
}

/** Only a completed walk may advance a watermark, and only forward. */
async function advanceWatermark(ctx: SourceContext, key: string, day: string): Promise<void> {
  const existing = await ctx.store.getWatermark("wikimedia", key);
  if (existing === null || day > existing) {
    await ctx.store.setWatermark("wikimedia", key, day);
  }
}

export const wikimediaSource: AltDataSource = {
  id: "wikimedia",
  title: "Wikimedia pageviews",
  datasets: ["wiki-pageviews"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("wikimedia");
    const result = emptySyncResult("wikimedia", true);
    if (opts.datasets && !opts.datasets.includes("wiki-pageviews")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const yesterday = addDays(today, -1);
    // Daily counts finalize with roughly a one-day lag: never request through today.
    const untilBound = opts.until ?? yesterday;
    const rangeEnd = untilBound > yesterday ? yesterday : untilBound;
    const retrievedAt = now.toISOString();

    const articles = wikiArticleMap().entries;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let articlesFetched = 0;
    let fingerprinted = false;

    for (const [i, entry] of articles.entries()) {
      if (articlesFetched >= limit) {
        result.notes.push(
          `stopped at --limit ${opts.limit} article(s); ${articles.length - i} article(s) not walked this run`,
        );
        break;
      }

      const key = watermarkKey(entry.project, entry.article);
      const watermark = opts.full ? null : await ctx.store.getWatermark("wikimedia", key);
      const rangeStart =
        opts.since ??
        (watermark ? addDays(watermark, 1) : addDays(today, -ctx.config.backfillDays));
      // Already caught up through rangeEnd for this article — nothing to walk this run.
      if (rangeStart > rangeEnd) continue;

      articlesFetched += 1;
      const url = pageviewsUrl(entry.project, entry.article, rangeStart, rangeEnd);

      let outcome;
      try {
        outcome = await fetchArticleRange(politeFetch, {
          project: entry.project,
          article: entry.article,
          start: rangeStart,
          end: rangeEnd,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.notes.push(`${entry.project}/${entry.article}: ${message}`);
        logger.warn("article range fetch failed", {
          project: entry.project,
          article: entry.article,
          error: message,
        });
        continue; // Leave the watermark put; this article is retried next run.
      }

      if (!outcome.found) {
        // A 404 over the whole requested range is a definitive "no data" answer
        // (e.g. before this article existed, or before the project's pageviews
        // depth) — the walk still completed, so the watermark still advances.
        result.notes.push(
          `${entry.project}/${entry.article}: no data for ${rangeStart}..${rangeEnd} (404)`,
        );
        await advanceWatermark(ctx, key, rangeEnd);
        continue;
      }

      const firstItem = outcome.items[0];
      if (!fingerprinted && firstItem) {
        await ctx.store.setFingerprint(
          "wikimedia",
          FINGERPRINT_KEY,
          pageviewItemFingerprint(firstItem),
        );
        fingerprinted = true;
      }

      const rows: WikiPageview[] = [];
      for (const raw of outcome.items) {
        result.parse.attempted += 1;
        try {
          rows.push(
            normalizePageviewItem(raw, {
              expectedProject: entry.project,
              expectedArticle: entry.article,
              tickers: entry.tickers,
              sourceUrl: url,
              retrievedAt,
            }),
          );
          result.parse.succeeded += 1;
        } catch (error) {
          logger.warn("pageview item failed to normalize", {
            project: entry.project,
            article: entry.article,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (rows.length > 0) {
        const { rows: upserted } = await ctx.store.upsert(DATASETS["wiki-pageviews"], rows);
        result.rowsUpserted += upserted;
        result.perDataset["wiki-pageviews"] = (result.perDataset["wiki-pageviews"] ?? 0) + upserted;
      }
      logger.info(
        `${entry.project}/${entry.article}: ${rows.length} day(s) (${rangeStart}..${rangeEnd})`,
      );
      await advanceWatermark(ctx, key, rangeEnd);
    }

    return result;
  },

  async canary(ctx: SourceContext): Promise<{ checks: SourceCanaryCheck[] }> {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();

    let mapEntryCount: number | null = null;
    let probeEntry: { project: string; article: string } | undefined;
    try {
      const map = wikiArticleMap();
      mapEntryCount = map.entries.length;
      probeEntry = map.entries[0];
      checks.push({
        name: "map-validates",
        ok: mapEntryCount > 0,
        severity: "hard",
        note: `${mapEntryCount} curated article(s)`,
      });
    } catch (error) {
      checks.push({
        name: "map-validates",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    if (probeEntry) {
      const politeFetch = buildFetch(ctx);
      const today = toDateString(now);
      const end = addDays(today, -CANARY_LAG_DAYS);
      const start = addDays(end, -(CANARY_WINDOW_DAYS - 1));
      try {
        const outcome = await fetchArticleRange(politeFetch, {
          project: probeEntry.project,
          article: probeEntry.article,
          start,
          end,
        });
        checks.push({
          name: "probe-fetch",
          ok: true,
          severity: "hard",
          note: outcome.found
            ? `${outcome.items.length} day(s) for ${probeEntry.project}/${probeEntry.article} (${start}..${end})`
            : `no data for ${probeEntry.project}/${probeEntry.article} (${start}..${end})`,
        });

        const first = outcome.found ? outcome.items[0] : undefined;
        if (first) {
          const hash = pageviewItemFingerprint(first);
          const stored = await ctx.store.getFingerprint("wikimedia", FINGERPRINT_KEY);
          if (stored === null) {
            await ctx.store.setFingerprint("wikimedia", FINGERPRINT_KEY, hash);
            checks.push({
              name: "fingerprint",
              ok: true,
              severity: "hard",
              note: "baseline recorded",
            });
          } else {
            checks.push({
              name: "fingerprint",
              ok: stored === hash,
              severity: "hard",
              note: stored === hash ? undefined : "result-item field names changed",
            });
          }
        }
      } catch (error) {
        checks.push({
          name: "probe-fetch",
          ok: false,
          severity: "hard",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      checks.push({
        name: "probe-fetch",
        ok: false,
        severity: "hard",
        note: "no curated article available to probe",
      });
    }

    const lastSync = await ctx.store.latestSyncRun("wikimedia");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} item(s) in the last sync run`,
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("wiki-pageviews");
    checks.push({
      name: "freshness-wiki-pageviews",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["wiki-pageviews"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
