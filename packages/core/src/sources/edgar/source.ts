import { createHash } from "node:crypto";
import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { InsiderTransaction } from "../../schema/insider-transaction.js";
import type { ThirteenfHolding } from "../../schema/thirteenf-holding.js";
import { buildUserAgent } from "../../config.js";
import {
  addDays,
  eachDayInclusive,
  hoursSince,
  isoNow,
  isWeekend,
  toDateString,
} from "../../lib/dates.js";
import {
  accessionFromPath,
  COMPANY_TICKERS_URL,
  EdgarClient,
  filingIndexUrl,
  filingTxtUrl,
} from "./client.js";
import { isOwnershipForm, isThirteenfForm, parseMasterIndex } from "./daily-index.js";
import { parseOwnershipForm } from "./form-ownership.js";
import { parseThirteenf } from "./thirteenf.js";
import { refreshCikTickersIfStale } from "../../resolve/cik-ticker.js";

/**
 * EDGAR ingestion: walks the daily master index since the last watermark and
 * pulls each ownership (3/4/5) and 13F-HR full submission — one fetch per
 * filing, all through the shared ≤10 req/s client.
 *
 * Today's index is ingested too (it grows during the day); the watermark
 * only ever advances through yesterday, so the current day is re-walked
 * until complete. Upserts by natural key make that re-walk free of dupes.
 */

const WATERMARK_KEY = "daily-index.lastCompletedDay";
const FINGERPRINT_KEY = "daily-index.header";

/**
 * 13F filings carry the informationTable XML that `thirteenf-xml@1` reads
 * only from EDGAR's structured-13F rollout in mid-2013; everything before is
 * a typed text table the parser cannot read. Filings older than this cutoff
 * are skipped without a fetch — a deep backfill would otherwise spend its
 * budget downloading multi-MB submissions only to fail every parse. The
 * cutoff sits a few weeks BEFORE the mandate so no XML-era filing is ever
 * skipped; the sliver of text-era filings after it still parse-fails loudly.
 */
export const THIRTEENF_XML_SINCE = "2013-05-01";

function hashLines(lines: string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

export const edgarSource: TrackerSource = {
  id: "edgar",
  title: "SEC EDGAR (Forms 3/4/5, 13F-HR)",
  datasets: ["insider-transactions", "thirteenf-holdings"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("edgar");
    const result = emptySyncResult("edgar", true);
    const userAgent = buildUserAgent(ctx.config);
    const client = new EdgarClient({
      userAgent,
      maxRequestsPerSecond: ctx.config.edgarMaxRps,
      fetchImpl: ctx.fetchImpl,
      logger,
    });

    await refreshCikTickersIfStale(ctx.store, client, logger);

    const wantInsider = !opts.datasets || opts.datasets.includes("insider-transactions");
    const wantThirteenf = !opts.datasets || opts.datasets.includes("thirteenf-holdings");
    if (!wantInsider && !wantThirteenf) return result;

    const today = toDateString(ctx.now?.() ?? new Date());
    const watermark = opts.full ? null : await ctx.store.getWatermark("edgar", WATERMARK_KEY);
    const start =
      opts.since ?? (watermark ? addDays(watermark, 1) : addDays(today, -ctx.config.backfillDays));
    // A bounded (--until) run — e.g. one backfill chunk — never walks past
    // its requested end date, even though "today" is always in its future.
    const end = opts.until && opts.until < today ? opts.until : today;
    const days = eachDayInclusive(start, end).filter((d) => !isWeekend(d));
    if (days.length === 0) {
      result.notes.push("nothing to do: watermark is current");
      return result;
    }

    let fetched = 0;
    let preXmlThirteenf = 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    // Tracks the highest day actually advanced so far, so a chunk walking
    // OLD ground (a historical backfill run after the live watermark has
    // already moved past it) can never regress it.
    let advanced = watermark;

    for (const day of days) {
      if (fetched >= limit) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced past ${day}`);
        break;
      }
      const indexText = await client.dailyIndexText(day);
      if (indexText === null) {
        // Holiday (or today's index not yet published); only advance forward.
        if (day < today && (advanced === null || day > advanced)) {
          advanced = day;
          await ctx.store.setWatermark("edgar", WATERMARK_KEY, day);
        }
        continue;
      }
      const { entries, headerLines } = parseMasterIndex(indexText);
      await ctx.store.setFingerprint("edgar", FINGERPRINT_KEY, hashLines(headerLines.slice(0, 2)));

      const wanted = entries.filter((e) => {
        if (wantInsider && isOwnershipForm(e.formType)) return true;
        if (wantThirteenf && isThirteenfForm(e.formType)) {
          if (e.dateFiled < THIRTEENF_XML_SINCE) {
            preXmlThirteenf += 1;
            return false;
          }
          return true;
        }
        return false;
      });
      logger.info(`${day}: ${wanted.length} filings to ingest (${entries.length} total in index)`);

      const insiderRows: InsiderTransaction[] = [];
      const thirteenfRows: ThirteenfHolding[] = [];
      let dayIncomplete = false;

      for (const entry of wanted) {
        if (fetched >= limit) {
          dayIncomplete = true;
          break;
        }
        fetched += 1;
        const accession = accessionFromPath(entry.path);
        if (!accession) continue;
        result.parse.attempted += 1;
        try {
          const txt = await client.text(filingTxtUrl(entry.path));
          if (txt === null) throw new Error("filing fetch returned 404");
          const common = {
            text: txt,
            accessionNumber: accession,
            filedAt: entry.dateFiled,
            sourceUrl: filingIndexUrl(entry.path),
            retrievedAt: isoNow(),
          };
          if (isOwnershipForm(entry.formType)) {
            const parsed = parseOwnershipForm(common);
            // Filings sometimes blank the trading symbol; recover it from the
            // issuer's CIK via the cached SEC company→ticker map.
            if (parsed.ticker === null) {
              const tickers = await ctx.store.tickersForCik(parsed.issuerCik);
              const resolved = tickers[0] ?? null;
              if (resolved) for (const row of parsed.rows) row.ticker = resolved;
            }
            insiderRows.push(...parsed.rows);
          } else {
            const parsed = parseThirteenf(common);
            // Ticker resolution for CUSIPs is cache-only here; `market-trackers resolve`
            // fills the cache via OpenFIGI (see resolve/cusip.ts).
            for (const row of parsed.rows) {
              const cached = await ctx.store.getCusip(row.cusip);
              if (cached?.ticker) row.ticker = cached.ticker;
            }
            thirteenfRows.push(...parsed.rows);
          }
          result.parse.succeeded += 1;
        } catch (error) {
          logger.warn(`parse failed for ${entry.path}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (fetched % 100 === 0) logger.info(`progress: ${fetched} filings fetched`);
      }

      if (insiderRows.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["insider-transactions"], insiderRows);
        result.rowsUpserted += rows;
        result.perDataset["insider-transactions"] =
          (result.perDataset["insider-transactions"] ?? 0) + rows;
      }
      if (thirteenfRows.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["thirteenf-holdings"], thirteenfRows);
        result.rowsUpserted += rows;
        result.perDataset["thirteenf-holdings"] =
          (result.perDataset["thirteenf-holdings"] ?? 0) + rows;
      }
      if (dayIncomplete) break;
      if (day < today && (advanced === null || day > advanced)) {
        advanced = day;
        await ctx.store.setWatermark("edgar", WATERMARK_KEY, day);
      }
    }

    if (preXmlThirteenf > 0) {
      result.notes.push(
        `skipped ${preXmlThirteenf} pre-${THIRTEENF_XML_SINCE} 13F filings ` +
          "(typed text tables — no informationTable XML before EDGAR's structured-13F rollout)",
      );
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();

    let client: EdgarClient | null = null;
    try {
      client = new EdgarClient({
        userAgent: buildUserAgent(ctx.config),
        maxRequestsPerSecond: ctx.config.edgarMaxRps,
        fetchImpl: ctx.fetchImpl,
        logger: ctx.logger,
      });
    } catch {
      checks.push({
        name: "fetch-daily-index",
        ok: false,
        severity: "soft",
        note: "skipped: no contact email configured for the SEC User-Agent",
      });
    }

    if (client) {
      // Walk back past weekends/holidays to the most recent published index.
      let day = toDateString(now);
      let found = false;
      for (let back = 0; back < 6 && !found; back++) {
        if (!isWeekend(day)) {
          try {
            const text = await client.dailyIndexText(day);
            if (text !== null) {
              const { entries, headerLines } = parseMasterIndex(text);
              found = true;
              checks.push({
                name: "fetch-daily-index",
                ok: entries.length > 0,
                severity: "hard",
                note: `${day}: ${entries.length} entries`,
              });
              const hash = hashLines(headerLines.slice(0, 2));
              const stored = await ctx.store.getFingerprint("edgar", FINGERPRINT_KEY);
              if (stored === null) {
                await ctx.store.setFingerprint("edgar", FINGERPRINT_KEY, hash);
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
                  note: stored === hash ? undefined : "daily-index header format changed",
                });
              }
            }
          } catch (error) {
            found = true;
            checks.push({
              name: "fetch-daily-index",
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
          name: "fetch-daily-index",
          ok: false,
          severity: "hard",
          note: "no daily index found in the last 6 days",
        });
      }

      // The company↔ticker map is load-bearing for ticker recovery on
      // ownership filings — probe it directly (hard: resolution breaks
      // silently without it).
      try {
        const response = await client.politeFetch(COMPANY_TICKERS_URL, { method: "HEAD" });
        await response.arrayBuffer().catch(() => undefined);
        checks.push({
          name: "fetch-company-tickers",
          ok: response.ok,
          severity: "hard",
          note: response.ok ? undefined : `HTTP ${response.status}`,
        });
      } catch (error) {
        checks.push({
          name: "fetch-company-tickers",
          ok: false,
          severity: "hard",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const lastSync = await ctx.store.latestSyncRun("edgar");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} documents`,
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("insider-transactions");
    const windowHours = DATASETS["insider-transactions"].freshnessWindowHours;
    checks.push({
      name: "freshness-insider-transactions",
      ok: lastIngested !== null && hoursSince(lastIngested, now) <= windowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
