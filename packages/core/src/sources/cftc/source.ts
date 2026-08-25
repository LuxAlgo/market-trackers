import type { DocketSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { cotReportId, type CotReport } from "../../schema/cot-report.js";
import { DOCKET_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import {
  COT_PAGE_LIMIT,
  cotRawRowSchema,
  cotReportDateQueryUrl,
  cotRowFingerprint,
  createCftcFetch,
  fetchCotPage,
  parseCotCount,
} from "./client.js";

export {
  CFTC_API_BASE,
  CFTC_COT_LEGACY_FUTURES_URL,
  COT_REPORT_DATE_FIELD,
  COT_PAGE_LIMIT,
  cotReportDateQueryUrl,
  cotRowFingerprint,
  parseCotCount,
} from "./client.js";

/**
 * CFTC Commitments of Traders (legacy futures-only), walked ascending by
 * report date since the watermark. Natural key is `${reportDate}:${contractCode}`
 * (`cotReportId`), so the trailing re-walk upserts without duplicating.
 * Position counts are published numbers, verbatim — net positioning is left
 * to the reader, never computed here.
 */

export const CFTC_PARSER = "cftc-cot-legacy@1";

const WATERMARK_KEY = "cot.lastReportDate";
const FINGERPRINT_KEY = "cot.row-fields";
/** Reports occasionally revise after first posting; re-walk one trailing report-week. */
const REWALK_DAYS = 7;
/** Canary probe window — wide enough that a between-Tuesdays gap never looks like an outage. */
const CANARY_PROBE_DAYS = 30;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createCftcFetch({
    userAgent: ctx.config.userAgent ?? `docket/${DOCKET_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("cftc"),
  });
}

function reportDateIso(raw: string | null | undefined, context: string): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    throw new Error(`${context}: unusable report_date_as_yyyy_mm_dd '${String(raw)}'`);
  }
  return raw.slice(0, 10);
}

/**
 * Normalizes one raw Socrata row into a `CotReport`. Every field is
 * validated on its own terms and the whole row throws together on the first
 * problem found — a malformed row is a parse failure, never a row with a
 * zeroed-out field.
 */
export function normalizeCotRow(raw: Record<string, unknown>, retrievedAt: string): CotReport {
  const row = cotRawRowSchema.parse(raw);
  const reportDate = reportDateIso(row.report_date_as_yyyy_mm_dd, "row");

  const contractCode = row.cftc_contract_market_code?.trim();
  if (!contractCode) throw new Error(`${reportDate}: missing cftc_contract_market_code`);
  const marketName = row.market_and_exchange_names?.trim();
  if (!marketName)
    throw new Error(`${reportDate}:${contractCode}: missing market_and_exchange_names`);

  const openInterest = parseCotCount(row.open_interest_all, "open_interest_all");
  const commercialLong = parseCotCount(row.comm_positions_long_all, "comm_positions_long_all");
  const commercialShort = parseCotCount(row.comm_positions_short_all, "comm_positions_short_all");
  const nonCommercialLong = parseCotCount(
    row.noncomm_positions_long_all,
    "noncomm_positions_long_all",
  );
  const nonCommercialShort = parseCotCount(
    row.noncomm_positions_short_all,
    "noncomm_positions_short_all",
  );
  const nonReportableLong = parseCotCount(
    row.nonrept_positions_long_all,
    "nonrept_positions_long_all",
  );
  const nonReportableShort = parseCotCount(
    row.nonrept_positions_short_all,
    "nonrept_positions_short_all",
  );

  return {
    id: cotReportId(reportDate, contractCode),
    reportDate,
    contractCode,
    marketName,
    openInterest,
    commercialLong,
    commercialShort,
    nonCommercialLong,
    nonCommercialShort,
    nonReportableLong,
    nonReportableShort,
    provenance: {
      source: "cftc",
      sourceUrl: cotReportDateQueryUrl(reportDate),
      retrievedAt,
      parser: CFTC_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

export const cftcSource: DocketSource = {
  id: "cftc",
  title: "CFTC Commitments of Traders (legacy futures-only)",
  datasets: ["cot-reports"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("cftc");
    const result = emptySyncResult("cftc", true);
    if (opts.datasets && !opts.datasets.includes("cot-reports")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const watermark = opts.full ? null : await ctx.store.getWatermark("cftc", WATERMARK_KEY);
    const start =
      opts.since ??
      (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
    const untilBound = opts.until ?? today;
    const end = untilBound > today ? today : untilBound;
    const startDate = start > end ? end : start;

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let offset = 0;
    let maxReportDate: string | null = null;
    let fingerprinted = false;
    let complete = false;

    for (;;) {
      const remaining = Number.isFinite(limit)
        ? Math.max(1, Math.min(COT_PAGE_LIMIT, limit - processed))
        : COT_PAGE_LIMIT;

      let page: Record<string, unknown>[];
      try {
        page = await fetchCotPage(politeFetch, { start: startDate, end, limit: remaining, offset });
      } catch (error) {
        // Exhausted retries: keep partial progress, leave the watermark put.
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          break;
        }
        throw error;
      }

      if (!fingerprinted && page[0]) {
        await ctx.store.setFingerprint("cftc", FINGERPRINT_KEY, cotRowFingerprint(page[0]));
        fingerprinted = true;
      }

      const reports: CotReport[] = [];
      for (const raw of page) {
        processed += 1;
        result.parse.attempted += 1;
        try {
          const report = normalizeCotRow(raw, retrievedAt);
          reports.push(report);
          result.parse.succeeded += 1;
          if (maxReportDate === null || report.reportDate > maxReportDate) {
            maxReportDate = report.reportDate;
          }
        } catch (error) {
          logger.warn("row failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (reports.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["cot-reports"], reports);
        result.rowsUpserted += rows;
        result.perDataset["cot-reports"] = (result.perDataset["cot-reports"] ?? 0) + rows;
      }
      logger.info(`offset ${offset}: ${reports.length} reports (${startDate}..${end})`);

      if (page.length < remaining) {
        complete = true;
        break;
      }
      if (processed >= limit) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        break;
      }
      offset += remaining;
    }

    // Only a completed walk may advance the watermark, and only forward.
    if (complete && maxReportDate !== null) {
      const existing = await ctx.store.getWatermark("cftc", WATERMARK_KEY);
      if (existing === null || maxReportDate > existing) {
        await ctx.store.setWatermark("cftc", WATERMARK_KEY, maxReportDate);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const politeFetch = buildFetch(ctx);

    try {
      const page = await fetchCotPage(politeFetch, {
        start: addDays(today, -CANARY_PROBE_DAYS),
        end: today,
        limit: 1,
        offset: 0,
      });
      checks.push({
        name: "probe-cot",
        ok: true,
        severity: "hard",
        note: `${page.length} row(s) in the last ${CANARY_PROBE_DAYS} days`,
      });

      const first = page[0];
      if (first) {
        const hash = cotRowFingerprint(first);
        const stored = await ctx.store.getFingerprint("cftc", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("cftc", FINGERPRINT_KEY, hash);
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
            note: stored === hash ? undefined : "result-row field names changed",
          });
        }

        let succeeded = 0;
        for (const raw of page) {
          try {
            normalizeCotRow(raw, now.toISOString());
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        const rate = succeeded / page.length;
        checks.push({
          name: "parse-success-rate",
          ok: rate >= 0.99,
          severity: "hard",
          note: `${succeeded}/${page.length} probe rows`,
        });
      }
    } catch (error) {
      checks.push({
        name: "probe-cot",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // Published weekly (Fridays, for the prior Tuesday); the freshness window is 10 days.
    const lastIngested = await ctx.store.maxRetrievedAt("cot-reports");
    checks.push({
      name: "freshness-cot-reports",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["cot-reports"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
