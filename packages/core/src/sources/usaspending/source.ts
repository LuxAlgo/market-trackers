import type { DocketSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { GovContractAward } from "../../schema/gov-contract-award.js";
import { DOCKET_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { resolveEntityTickers } from "../../resolve/recipients.js";
import {
  AWARD_DATE_FIELD,
  AWARD_SEARCH_PAGE_LIMIT,
  awardPageUrl,
  awardRowFingerprint,
  awardSearchRowSchema,
  createUsaspendingFetch,
  fetchAwardSearchPage,
} from "./client.js";

export {
  USASPENDING_API_BASE,
  USASPENDING_AWARD_SEARCH_URL,
  awardPageUrl,
  awardRowFingerprint,
} from "./client.js";

/**
 * USAspending — federal contract awards (type codes A–D), walked ascending
 * by the award date field since the watermark. Natural key is the
 * `generated_internal_id`, so the trailing re-walk and today's partial data
 * upsert without duplicates. Recipients resolve to tickers through the
 * curated map; unmatched recipients are stored with `tickers: []`.
 */

export const USASPENDING_PARSER = "usaspending-awards@1";

const WATERMARK_KEY = "usaspending.lastActionDate";
const FINGERPRINT_KEY = "usaspending.award-row-fields";
/** Awards post to USAspending on a lag; re-walk this many trailing days. */
const REWALK_DAYS = 3;
/** Canary probe window — wide enough that a weekend never looks like an outage. */
const CANARY_PROBE_DAYS = 30;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createUsaspendingFetch({
    userAgent: ctx.config.userAgent ?? `docket/${DOCKET_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("usaspending"),
  });
}

/** Normalizes one raw result row; throws when a required field is unusable. */
export function normalizeAwardRow(
  raw: Record<string, unknown>,
  retrievedAt: string,
): GovContractAward {
  const row = awardSearchRowSchema.parse(raw);
  const id = row.generated_internal_id;

  const name = row["Recipient Name"]?.trim();
  if (!name) throw new Error(`award ${id}: missing recipient name`);
  const agency = row["Awarding Agency"]?.trim();
  if (!agency) throw new Error(`award ${id}: missing awarding agency`);
  const actionDate = row[AWARD_DATE_FIELD];
  if (!actionDate || !/^\d{4}-\d{2}-\d{2}$/.test(actionDate)) {
    throw new Error(`award ${id}: unusable ${AWARD_DATE_FIELD} '${String(actionDate)}'`);
  }

  const uei = row["Recipient UEI"]?.trim() || null;
  const naicsCode = row["NAICS Code"];

  return {
    id,
    awardId: row["Award ID"] ?? null,
    awardType: row["Contract Award Type"] ?? null,
    agency,
    subAgency: row["Awarding Sub Agency"] ?? null,
    recipient: { name, uei, tickers: resolveEntityTickers({ name, uei }) },
    // Null amounts stay null — never zeroed.
    amountUsd: row["Award Amount"] ?? null,
    actionDate,
    description: row.Description ?? null,
    naicsCode: naicsCode === null || naicsCode === undefined ? null : String(naicsCode),
    naicsDescription: row["NAICS Description"] ?? null,
    provenance: {
      source: "usaspending",
      sourceUrl: awardPageUrl(id),
      retrievedAt,
      parser: USASPENDING_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

export const usaspendingSource: DocketSource = {
  id: "usaspending",
  title: "USAspending (federal contract awards)",
  datasets: ["gov-contracts"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("usaspending");
    const result = emptySyncResult("usaspending", true);
    if (opts.datasets && !opts.datasets.includes("gov-contracts")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const watermark = opts.full
      ? null
      : await ctx.store.getWatermark("usaspending", WATERMARK_KEY);
    const start =
      opts.since ??
      (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
    const startDate = start > today ? today : start;

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let page = 1;
    let maxActionDate: string | null = null;
    let fingerprinted = false;
    let complete = false;

    for (;;) {
      const remaining = Number.isFinite(limit)
        ? Math.max(1, Math.min(AWARD_SEARCH_PAGE_LIMIT, limit - processed))
        : AWARD_SEARCH_PAGE_LIMIT;

      let response;
      try {
        response = await fetchAwardSearchPage(politeFetch, {
          startDate,
          endDate: today,
          page,
          limit: remaining,
        });
      } catch (error) {
        // Exhausted retries: keep partial progress, leave the watermark put.
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          break;
        }
        throw error;
      }

      if (!fingerprinted && response.results[0]) {
        await ctx.store.setFingerprint(
          "usaspending",
          FINGERPRINT_KEY,
          awardRowFingerprint(response.results[0]),
        );
        fingerprinted = true;
      }

      const awards: GovContractAward[] = [];
      for (const raw of response.results) {
        processed += 1;
        result.parse.attempted += 1;
        try {
          const award = normalizeAwardRow(raw, retrievedAt);
          awards.push(award);
          result.parse.succeeded += 1;
          if (maxActionDate === null || award.actionDate > maxActionDate) {
            maxActionDate = award.actionDate;
          }
        } catch (error) {
          logger.warn("award row failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (awards.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["gov-contracts"], awards);
        result.rowsUpserted += rows;
        result.perDataset["gov-contracts"] = (result.perDataset["gov-contracts"] ?? 0) + rows;
      }
      logger.info(`page ${page}: ${awards.length} awards (${startDate}..${today})`);

      if (!response.page_metadata.hasNext) {
        complete = true;
        break;
      }
      if (processed >= limit) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        break;
      }
      page += 1;
    }

    // Only a completed walk may advance the watermark, and only forward.
    if (complete && maxActionDate !== null) {
      const existing = await ctx.store.getWatermark("usaspending", WATERMARK_KEY);
      if (existing === null || maxActionDate > existing) {
        await ctx.store.setWatermark("usaspending", WATERMARK_KEY, maxActionDate);
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
      const response = await fetchAwardSearchPage(politeFetch, {
        startDate: addDays(today, -CANARY_PROBE_DAYS),
        endDate: today,
        page: 1,
        limit: 1,
      });
      checks.push({
        name: "probe-award-search",
        ok: true,
        severity: "hard",
        note: `${response.results.length} row(s) in the last ${CANARY_PROBE_DAYS} days`,
      });

      const first = response.results[0];
      if (first) {
        const hash = awardRowFingerprint(first);
        const stored = await ctx.store.getFingerprint("usaspending", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("usaspending", FINGERPRINT_KEY, hash);
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
        for (const raw of response.results) {
          try {
            normalizeAwardRow(raw, now.toISOString());
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        const rate = succeeded / response.results.length;
        checks.push({
          name: "parse-success-rate",
          ok: rate >= 0.99,
          severity: "hard",
          note: `${succeeded}/${response.results.length} probe rows`,
        });
      }
    } catch (error) {
      checks.push({
        name: "probe-award-search",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("gov-contracts");
    checks.push({
      name: "freshness-gov-contracts",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["gov-contracts"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
