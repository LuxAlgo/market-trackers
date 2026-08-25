import { createHash } from "node:crypto";
import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { createPoliteFetch, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import {
  addDays,
  compactDate,
  eachDayInclusive,
  hoursSince,
  isoNow,
  isWeekend,
  toDateString,
} from "../../lib/dates.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { parseShortVolumeFile } from "./parser.js";

/**
 * FINRA Reg SHO daily short-sale volume. Free, keyless, one small file per
 * market per trading day — the friendliest source in the project and the
 * zero-config quickstart dataset.
 */

const FINGERPRINT_KEY = "shortvol.header";

export function shortVolumeFileUrl(market: string, day: string): string {
  return `https://cdn.finra.org/equity/regsho/daily/${market}shvol${compactDate(day)}.txt`;
}

function watermarkKey(market: string): string {
  return `shortvol.${market}.lastDay`;
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createPoliteFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    limiter: new RateLimiter({ limit: 5, windowMs: 1_000 }),
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("finra"),
  });
}

export const finraSource: AltDataSource = {
  id: "finra",
  title: "FINRA Reg SHO daily short-sale volume",
  datasets: ["short-volume"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("finra");
    const result = emptySyncResult("finra", true);
    if (opts.datasets && !opts.datasets.includes("short-volume")) return result;

    const politeFetch = buildFetch(ctx);
    const today = toDateString(ctx.now?.() ?? new Date());
    let fetched = 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;

    for (const market of ctx.config.finraMarkets) {
      const watermark = opts.full
        ? null
        : await ctx.store.getWatermark("finra", watermarkKey(market));
      const start =
        opts.since ??
        (watermark ? addDays(watermark, 1) : addDays(today, -ctx.config.backfillDays));
      // A bounded (--until) run — e.g. one backfill chunk — never walks past
      // its requested end date, even though "today" is always in its future.
      const end = opts.until && opts.until < today ? opts.until : today;
      const days = eachDayInclusive(start, end).filter((d) => !isWeekend(d));
      // Tracks the highest day actually advanced so far, so a chunk walking
      // OLD ground (a historical backfill run after the live watermark has
      // already moved past it) can never regress it.
      let advanced = watermark;

      for (const day of days) {
        if (fetched >= limit) {
          result.notes.push(`stopped at --limit ${opts.limit}`);
          return result;
        }
        fetched += 1;
        const url = shortVolumeFileUrl(market, day);
        const response = await politeFetch(url);
        if (response.status === 404) {
          await response.arrayBuffer().catch(() => undefined);
          // Market holiday — or today's file not published yet: only advance
          // the watermark past days that are conclusively over, and only forward.
          if (day < today && (advanced === null || day > advanced)) {
            advanced = day;
            await ctx.store.setWatermark("finra", watermarkKey(market), day);
          }
          continue;
        }
        if (!response.ok) {
          result.notes.push(`HTTP ${response.status} for ${url}`);
          break;
        }
        const text = await response.text();
        const parsed = parseShortVolumeFile({
          text,
          market,
          sourceUrl: url,
          retrievedAt: isoNow(),
        });
        result.parse.attempted += parsed.stats.attempted;
        result.parse.succeeded += parsed.stats.succeeded;
        if (parsed.headerLine) {
          await ctx.store.setFingerprint(
            "finra",
            FINGERPRINT_KEY,
            createHash("sha256").update(parsed.headerLine).digest("hex").slice(0, 16),
          );
        }
        const { rows } = await ctx.store.upsert(DATASETS["short-volume"], parsed.rows);
        result.rowsUpserted += rows;
        result.perDataset["short-volume"] = (result.perDataset["short-volume"] ?? 0) + rows;
        logger.info(`${market} ${day}: ${rows} rows`);
        if (advanced === null || day > advanced) {
          advanced = day;
          await ctx.store.setWatermark("finra", watermarkKey(market), day);
        }
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const politeFetch = buildFetch(ctx);
    const market = ctx.config.finraMarkets[0] ?? "CNMS";

    let day = toDateString(now);
    let found = false;
    for (let back = 0; back < 6 && !found; back++) {
      if (!isWeekend(day)) {
        const url = shortVolumeFileUrl(market, day);
        try {
          const response = await politeFetch(url);
          if (response.ok) {
            found = true;
            const text = await response.text();
            const parsed = parseShortVolumeFile({
              text,
              market,
              sourceUrl: url,
              retrievedAt: isoNow(),
            });
            checks.push({
              name: "fetch-daily-file",
              ok: parsed.rows.length > 0,
              severity: "hard",
              note: `${day}: ${parsed.rows.length} rows`,
            });
            const rate =
              parsed.stats.attempted > 0 ? parsed.stats.succeeded / parsed.stats.attempted : 1;
            checks.push({
              name: "parse-success-rate",
              ok: rate >= 0.99,
              severity: "hard",
              note: `${(rate * 100).toFixed(2)}% of ${parsed.stats.attempted} lines`,
            });
            if (parsed.headerLine) {
              const hash = createHash("sha256")
                .update(parsed.headerLine)
                .digest("hex")
                .slice(0, 16);
              const stored = await ctx.store.getFingerprint("finra", FINGERPRINT_KEY);
              if (stored === null) {
                await ctx.store.setFingerprint("finra", FINGERPRINT_KEY, hash);
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
                  note: stored === hash ? undefined : "file header format changed",
                });
              }
            }
          } else {
            await response.arrayBuffer().catch(() => undefined);
          }
        } catch (error) {
          found = true;
          checks.push({
            name: "fetch-daily-file",
            ok: false,
            severity: "hard",
            note: error instanceof Error ? error.message : String(error),
          });
        }
      }
      day = addDays(day, -1);
    }
    if (!found) {
      checks.push({
        name: "fetch-daily-file",
        ok: false,
        severity: "hard",
        note: "no daily file found in the last 6 days",
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("short-volume");
    checks.push({
      name: "freshness-short-volume",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["short-volume"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
