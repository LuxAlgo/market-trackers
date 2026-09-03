import type {
  TrackerSource,
  ParseStats,
  SourceContext,
  SourceSyncResult,
  SyncOptions,
} from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS, type DatasetId } from "../../schema/datasets.js";
import type { GovContractAward } from "../../schema/gov-contract-award.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { ZodError } from "zod";
import type { PoliteFetch } from "../../lib/http.js";
import type { TrackerStore } from "../../store/store.js";
import { resolveEntityTickersTiered } from "../../resolve/sec-names.js";
import {
  AWARD_DATE_FIELD,
  AWARD_SEARCH_PAGE_LIMIT,
  AWARD_START_FIELD,
  awardPageUrl,
  awardRowFingerprint,
  awardSearchRowSchema,
  CONTRACT_AWARD_TYPE_CODES,
  createUsaspendingFetch,
  fetchAwardSearchPage,
  GRANT_AWARD_TYPE_CODES,
  nextCursor,
  type AwardSearchCursor,
} from "./client.js";

export {
  USASPENDING_API_BASE,
  USASPENDING_AWARD_SEARCH_URL,
  awardPageUrl,
  awardRowFingerprint,
} from "./client.js";

/**
 * USAspending — federal award search, walked ascending by signing date
 * (`new_awards_only` windows, see client.ts for why) since the watermark,
 * with search_after paging so a busy window is read in full. Rows arrive
 * sorted on that date, so a walk interrupted by the time budget or the
 * upstream API reports the last fully covered day and resumes there. One
 * endpoint, two award universes: contracts
 * (type codes A–D → `gov-contracts`, exactly as before) and grants (type
 * codes 02/03/04/05 → `gov-grants`, [verify-live] — see docs/sources/
 * usaspending.md). Both universes share the record shape, the normalizer,
 * and the parser id (`usaspending-awards@1`): nothing about parsing a grant
 * row differs from parsing a contract row, only the query does. Each
 * universe keeps an independent watermark and fingerprint so one can lag or
 * drift without masking the other. Natural key is the `generated_internal_id`,
 * so the trailing re-walk and today's partial data upsert without
 * duplicates. Recipients resolve to tickers through the two-tier resolver
 * (curated map, then the SEC issuer-name fallback — see
 * `resolve/sec-names.ts`); still-unmatched recipients are stored with
 * `tickers: []`.
 */

export const USASPENDING_PARSER = "usaspending-awards@1";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Awards post to USAspending on a lag; re-walk this many trailing days. */
const REWALK_DAYS = 3;
/** Canary probe window — wide enough that a weekend never looks like an outage. */
const CANARY_PROBE_DAYS = 30;

interface AwardUniverse {
  datasetId: "gov-contracts" | "gov-grants";
  awardTypeCodes: readonly string[];
  watermarkKey: string;
  fingerprintKey: string;
}

const CONTRACT_UNIVERSE: AwardUniverse = {
  datasetId: "gov-contracts",
  awardTypeCodes: CONTRACT_AWARD_TYPE_CODES,
  watermarkKey: "usaspending.lastActionDate",
  fingerprintKey: "usaspending.award-row-fields",
};

const GRANT_UNIVERSE: AwardUniverse = {
  datasetId: "gov-grants",
  awardTypeCodes: GRANT_AWARD_TYPE_CODES,
  watermarkKey: "usaspending.grants.lastActionDate",
  fingerprintKey: "usaspending.grants.award-row-fields",
};

const ALL_UNIVERSES: readonly AwardUniverse[] = [CONTRACT_UNIVERSE, GRANT_UNIVERSE];

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createUsaspendingFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("usaspending"),
  });
}

/** Normalizes one raw result row; throws when a required field is unusable. */
export async function normalizeAwardRow(
  raw: Record<string, unknown>,
  retrievedAt: string,
  store: TrackerStore,
): Promise<GovContractAward> {
  const row = awardSearchRowSchema.parse(raw);
  const id = row.generated_internal_id;

  const name = row["Recipient Name"]?.trim();
  if (!name) throw new Error(`award ${id}: missing recipient name`);
  const agency = row["Awarding Agency"]?.trim();
  if (!agency) throw new Error(`award ${id}: missing awarding agency`);
  // The signing date is the award's date; a row without one (seen on some
  // legacy records) falls back to its period-of-performance start.
  const signed = row[AWARD_DATE_FIELD];
  const start = row[AWARD_START_FIELD];
  const actionDate = signed && ISO_DATE.test(signed) ? signed : start;
  if (!actionDate || !ISO_DATE.test(actionDate)) {
    throw new Error(
      `award ${id}: unusable ${AWARD_DATE_FIELD} '${String(signed)}' and ${AWARD_START_FIELD} '${String(start)}'`,
    );
  }

  const uei = row["Recipient UEI"]?.trim() || null;
  const naicsCode = row["NAICS Code"];

  return {
    id,
    awardId: row["Award ID"] ?? null,
    awardType: row["Contract Award Type"] ?? null,
    agency,
    subAgency: row["Awarding Sub Agency"] ?? null,
    recipient: { name, uei, tickers: await resolveEntityTickersTiered(store, { name, uei }) },
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

interface UniverseSyncOutcome {
  rowsUpserted: number;
  perDataset: Partial<Record<DatasetId, number>>;
  parse: ParseStats;
  notes: string[];
  /** Raw rows iterated (attempted), for the shared --limit budget across universes. */
  processed: number;
  /** Set when the walk ended before the window did; see SourceSyncResult. */
  stoppedEarly?: "deadline" | "limit" | "upstream";
  /** With `stoppedEarly`: the last signing date fully covered, or null. */
  completedThrough?: string | null;
}

/**
 * Walks one award universe (contracts or grants) from its own watermark
 * (or `opts.since`) through `opts.until` (or today), paging with
 * search_after until exhausted, until `opts.deadlineMs`, until `budget`
 * (the remaining shared --limit across universes) runs out, or until the
 * upstream API stops answering. Every early stop reports the last signing
 * date fully covered: rows arrive sorted ascending on it, so once a page is
 * stored every award signed strictly before that page's last date is in the
 * store.
 */
async function syncUniverse(
  ctx: SourceContext,
  opts: SyncOptions,
  politeFetch: PoliteFetch,
  universe: AwardUniverse,
  today: string,
  retrievedAt: string,
  budget: number,
): Promise<UniverseSyncOutcome> {
  const logger = ctx.logger.child("usaspending");
  const out: UniverseSyncOutcome = {
    rowsUpserted: 0,
    perDataset: {},
    parse: { attempted: 0, succeeded: 0 },
    notes: [],
    processed: 0,
  };
  if (budget <= 0) return out;

  const stored = opts.full
    ? null
    : await ctx.store.getWatermark("usaspending", universe.watermarkKey);
  // A watermark past today is an artifact (earlier walks keyed on
  // period-of-performance start dates, which run years ahead); trusting it
  // would pin every daily window to an empty [today, today] forever.
  const watermark = stored !== null && stored > today ? today : stored;
  if (stored !== null && watermark !== stored) {
    out.notes.push(
      `${universe.datasetId}: stored watermark ${stored} is in the future; treating it as ${today}`,
    );
  }
  const endDate = opts.until && opts.until < today ? opts.until : today;
  const rawStart =
    opts.since ??
    (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
  const startDate =
    rawStart > endDate ? (opts.since ? endDate : addDays(endDate, -REWALK_DAYS)) : rawStart;

  const nowMs = () => (ctx.now?.() ?? new Date()).getTime();

  let page = 1;
  let after: AwardSearchCursor | null = null;
  let maxSignedDate: string | null = null;
  let fingerprinted = false;
  let complete = false;

  // Day-granular resume point for an early stop: the day before the newest
  // signing date stored, when that still lies inside the window.
  const coveredThrough = (): string | null => {
    if (maxSignedDate === null) return null;
    const through = addDays(maxSignedDate, -1);
    return through >= startDate ? through : null;
  };
  const stopEarly = (reason: NonNullable<UniverseSyncOutcome["stoppedEarly"]>, note: string) => {
    out.stoppedEarly = reason;
    out.completedThrough = coveredThrough();
    out.notes.push(`${universe.datasetId}: ${note}`);
  };

  for (;;) {
    if (opts.deadlineMs !== undefined && nowMs() >= opts.deadlineMs) {
      stopEarly("deadline", `deadline reached before page ${page}; watermark not advanced`);
      break;
    }
    const remaining = Number.isFinite(budget)
      ? Math.max(1, Math.min(AWARD_SEARCH_PAGE_LIMIT, budget - out.processed))
      : AWARD_SEARCH_PAGE_LIMIT;

    let response;
    try {
      response = await fetchAwardSearchPage(politeFetch, {
        startDate,
        endDate,
        page,
        limit: remaining,
        awardTypeCodes: universe.awardTypeCodes,
        after,
      });
    } catch (error) {
      // A response that no longer matches the contract is drift — fail
      // loudly. Anything else (an HTTP status or a dropped connection
      // that outlived the polite fetch's retries) is the upstream API
      // giving out: keep the partial progress, report where it stopped.
      if (error instanceof ZodError) throw error;
      stopEarly("upstream", error instanceof Error ? error.message : String(error));
      break;
    }

    if (!fingerprinted && response.results[0]) {
      await ctx.store.setFingerprint(
        "usaspending",
        universe.fingerprintKey,
        awardRowFingerprint(response.results[0]),
      );
      fingerprinted = true;
    }

    const awards: GovContractAward[] = [];
    for (const raw of response.results) {
      out.processed += 1;
      out.parse.attempted += 1;
      try {
        const award = await normalizeAwardRow(raw, retrievedAt, ctx.store);
        awards.push(award);
        out.parse.succeeded += 1;
      } catch (error) {
        logger.warn(`${universe.datasetId} row failed to normalize`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Progress is measured on the sort key itself, never on a fallback
      // date, so the resume point stays honest for rows missing it.
      const signed = raw[AWARD_DATE_FIELD];
      if (typeof signed === "string" && ISO_DATE.test(signed)) {
        if (maxSignedDate === null || signed > maxSignedDate) maxSignedDate = signed;
      }
    }

    if (awards.length > 0) {
      const { rows } = await ctx.store.upsert(DATASETS[universe.datasetId], awards);
      out.rowsUpserted += rows;
      out.perDataset[universe.datasetId] = (out.perDataset[universe.datasetId] ?? 0) + rows;
    }
    logger.info(
      `${universe.datasetId} page ${page}: ${awards.length} rows (${startDate}..${endDate})`,
    );

    if (!response.page_metadata.hasNext) {
      complete = true;
      break;
    }
    if (out.processed >= budget) {
      stopEarly("limit", `stopped at --limit ${opts.limit}; watermark not advanced`);
      break;
    }
    after = nextCursor(response);
    page += 1;
  }

  // Only a completed walk may advance the watermark, only forward, and never
  // past the window's end: a bounded (--until) historical backfill run must
  // never regress or overshoot the live incremental watermark. A stored
  // future watermark is the one value this may overwrite backwards.
  if (complete && maxSignedDate !== null) {
    const advanceTo = maxSignedDate > endDate ? endDate : maxSignedDate;
    const existing = await ctx.store.getWatermark("usaspending", universe.watermarkKey);
    if (existing === null || advanceTo > existing || existing > today) {
      await ctx.store.setWatermark("usaspending", universe.watermarkKey, advanceTo);
    }
  }

  return out;
}

export const usaspendingSource: TrackerSource = {
  id: "usaspending",
  title: "USAspending (federal contract and grant awards)",
  datasets: ["gov-contracts", "gov-grants"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const result = emptySyncResult("usaspending", true);

    const wantContracts = !opts.datasets || opts.datasets.includes("gov-contracts");
    const wantGrants = !opts.datasets || opts.datasets.includes("gov-grants");
    if (!wantContracts && !wantGrants) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const universes = [
      ...(wantContracts ? [CONTRACT_UNIVERSE] : []),
      ...(wantGrants ? [GRANT_UNIVERSE] : []),
    ];

    // --limit is a soft cap on documents fetched THIS RUN, shared across
    // both universes (not doubled per dataset) — contracts spends from the
    // budget first, and grants only gets what's left.
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let totalProcessed = 0;

    for (const [index, universe] of universes.entries()) {
      if (totalProcessed >= limit) break;
      const budget = Number.isFinite(limit) ? limit - totalProcessed : Number.POSITIVE_INFINITY;
      const outcome = await syncUniverse(
        ctx,
        opts,
        politeFetch,
        universe,
        today,
        retrievedAt,
        budget,
      );
      totalProcessed += outcome.processed;
      result.rowsUpserted += outcome.rowsUpserted;
      result.parse.attempted += outcome.parse.attempted;
      result.parse.succeeded += outcome.parse.succeeded;
      for (const key of Object.keys(outcome.perDataset) as DatasetId[]) {
        result.perDataset[key] = (result.perDataset[key] ?? 0) + (outcome.perDataset[key] ?? 0);
      }
      result.notes.push(...outcome.notes);

      if (outcome.stoppedEarly) {
        // The window is covered only as far as EVERY wanted universe walked
        // it. Contracts run first, so a stop there leaves grants untouched
        // for the whole window: nothing is fully covered, and the later
        // universes are not started against a deadline or an API that has
        // already given out. A stop in the last universe reports its own
        // covered day, the earlier ones having completed the window.
        result.stoppedEarly = outcome.stoppedEarly;
        result.completedThrough =
          index === universes.length - 1 ? (outcome.completedThrough ?? null) : null;
        break;
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const politeFetch = buildFetch(ctx);
    const probeStart = addDays(today, -CANARY_PROBE_DAYS);

    const checks: SourceCanaryCheck[] = [];
    for (const universe of ALL_UNIVERSES) {
      const suffix = universe.datasetId === "gov-grants" ? "-grants" : "";
      const probeName =
        universe.datasetId === "gov-grants" ? "probe-grant-search" : "probe-award-search";
      try {
        const response = await fetchAwardSearchPage(politeFetch, {
          startDate: probeStart,
          endDate: today,
          page: 1,
          limit: 1,
          awardTypeCodes: universe.awardTypeCodes,
        });
        checks.push({
          name: probeName,
          ok: true,
          severity: "hard",
          note: `${response.results.length} row(s) in the last ${CANARY_PROBE_DAYS} days`,
        });

        const first = response.results[0];
        if (first) {
          const hash = awardRowFingerprint(first);
          const stored = await ctx.store.getFingerprint("usaspending", universe.fingerprintKey);
          if (stored === null) {
            await ctx.store.setFingerprint("usaspending", universe.fingerprintKey, hash);
            checks.push({
              name: `fingerprint${suffix}`,
              ok: true,
              severity: "hard",
              note: "baseline recorded",
            });
          } else {
            checks.push({
              name: `fingerprint${suffix}`,
              ok: stored === hash,
              severity: "hard",
              note: stored === hash ? undefined : "result-row field names changed",
            });
          }

          let succeeded = 0;
          for (const raw of response.results) {
            try {
              await normalizeAwardRow(raw, now.toISOString(), ctx.store);
              succeeded += 1;
            } catch {
              // Counted below.
            }
          }
          const rate = succeeded / response.results.length;
          checks.push({
            name: `parse-success-rate${suffix}`,
            ok: rate >= 0.99,
            severity: "hard",
            note: `${succeeded}/${response.results.length} probe rows`,
          });
        }
      } catch (error) {
        checks.push({
          name: probeName,
          ok: false,
          severity: "hard",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const universe of ALL_UNIVERSES) {
      const lastIngested = await ctx.store.maxRetrievedAt(universe.datasetId);
      checks.push({
        name: `freshness-${universe.datasetId}`,
        ok:
          lastIngested !== null &&
          hoursSince(lastIngested, now) <= DATASETS[universe.datasetId].freshnessWindowHours,
        severity: "soft",
        note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
      });
    }

    return { checks };
  },
};
