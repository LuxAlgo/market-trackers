import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { fdaApprovalId, type FdaApproval } from "../../schema/fda-approval.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { addDays, expandCompactDate, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import type { TrackerStore } from "../../store/store.js";
import { resolveEntityTickersTiered } from "../../resolve/sec-names.js";
import {
  OPENFDA_PAGE_LIMIT,
  OPENFDA_SKIP_CEILING,
  drugApplicationOverviewUrl,
  drugsfdaApplicationSchema,
  drugsfdaRowFingerprint,
  fetchDrugsfdaPage,
  splitDateWindow,
  type DrugsfdaApplication,
  type DrugsfdaResponse,
  createOpenfdaFetch,
} from "./client.js";

export {
  OPENFDA_API_BASE,
  OPENFDA_DRUGSFDA_URL,
  OPENFDA_PAGE_LIMIT,
  OPENFDA_SKIP_CEILING,
  drugApplicationOverviewUrl,
  drugsfdaRowFingerprint,
  splitDateWindow,
  statusDateRangeSearch,
} from "./client.js";

/**
 * openFDA Drugs@FDA — one row per application-submission event (originals
 * and supplements) with its FDA status code, walked ascending by submission
 * status date since the watermark. Natural key is
 * `${applicationNumber}:${submissionType}:${submissionNumber}` (`fdaApprovalId`).
 *
 * A matched application carries *every* submission it has, not only the
 * one(s) whose date matched the search — sibling submissions outside the
 * queried window are silently skipped (they belong to whichever run's
 * window actually covers them); a submission with no usable status date is
 * always counted as a parse failure, because there is no way to tell which
 * window it belongs to.
 */

export const OPENFDA_PARSER = "openfda-drugsfda@1";

const WATERMARK_KEY = "openfda.lastStatusDate";
const FINGERPRINT_KEY = "openfda.application-row-fields";
/** Submission status updates can post with a short lag; re-walk this many trailing days. */
const REWALK_DAYS = 7;
/** Canary probe window — Drugs@FDA refreshes on a lag measured in days-to-weeks. */
const CANARY_PROBE_DAYS = 60;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createOpenfdaFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    apiKey: ctx.config.openfdaApiKey,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("openfda"),
  });
}

/** submission_status_date ("YYYYMMDD") → "YYYY-MM-DD", or null when missing/unparseable. */
export function parseSubmissionStatusDate(rawSubmission: Record<string, unknown>): string | null {
  const raw = rawSubmission.submission_status_date;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return expandCompactDate(trimmed);
}

/**
 * Normalizes one submission entry of an already-validated application into
 * a row. Throws when the submission's own status date, type, number, or the
 * application's sponsor name is missing or unusable — the caller counts
 * that as a parse failure, never a guess.
 */
export async function normalizeSubmission(
  application: DrugsfdaApplication,
  rawSubmission: Record<string, unknown>,
  retrievedAt: string,
  store: TrackerStore,
): Promise<FdaApproval> {
  const applicationNumber = application.application_number;
  const sponsorName = application.sponsor_name?.trim();
  if (!sponsorName) {
    throw new Error(`application ${applicationNumber}: missing sponsor_name`);
  }

  const rawType = rawSubmission.submission_type;
  const submissionType = typeof rawType === "string" ? rawType.trim() : "";
  if (!submissionType) {
    throw new Error(`application ${applicationNumber}: submission missing submission_type`);
  }

  const rawNumber = rawSubmission.submission_number;
  const submissionNumber =
    rawNumber === null || rawNumber === undefined ? "" : String(rawNumber).trim();
  if (!submissionNumber) {
    throw new Error(
      `application ${applicationNumber}:${submissionType}: missing submission_number`,
    );
  }

  const statusDate = parseSubmissionStatusDate(rawSubmission);
  if (!statusDate) {
    throw new Error(
      `application ${applicationNumber}:${submissionType}:${submissionNumber}: ` +
        "missing or unparseable submission_status_date",
    );
  }

  const rawStatus = rawSubmission.submission_status;
  const submissionStatus =
    typeof rawStatus === "string" && rawStatus.trim() ? rawStatus.trim() : null;

  const brandNames = application.openfda?.brand_name;
  const brandName =
    Array.isArray(brandNames) && brandNames.length > 0 ? (brandNames[0] ?? null) : null;

  return {
    id: fdaApprovalId(applicationNumber, submissionType, submissionNumber),
    applicationNumber,
    sponsor: {
      name: sponsorName,
      tickers: await resolveEntityTickersTiered(store, { name: sponsorName }),
    },
    brandName,
    submissionType,
    submissionNumber,
    submissionStatus,
    statusDate,
    provenance: {
      source: "openfda",
      sourceUrl: drugApplicationOverviewUrl(applicationNumber),
      retrievedAt,
      parser: OPENFDA_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

interface WalkDeps {
  politeFetch: PoliteFetch;
  store: TrackerStore;
  logger: Logger;
  apiKey: string | undefined;
  retrievedAt: string;
  limit: number;
}

interface WalkState {
  processed: number;
  fingerprinted: boolean;
  maxStatusDate: string | null;
  aborted: boolean;
  limitReached: boolean;
}

/**
 * Walks one `[start, end]` date window, paging via skip/limit and bisecting
 * (see `splitDateWindow`) whenever a window's own result total would
 * require paging past `OPENFDA_SKIP_CEILING`. Returns whether the window was
 * walked to completion (false on an HTTP error or hitting `--limit`, in
 * which case the caller must not advance the watermark past it).
 */
async function walkWindow(
  deps: WalkDeps,
  state: WalkState,
  result: SourceSyncResult,
  start: string,
  end: string,
): Promise<boolean> {
  const { politeFetch, store, logger, apiKey, retrievedAt, limit } = deps;
  let skip = 0;

  for (;;) {
    if (state.aborted) return false;
    if (state.processed >= limit) {
      state.limitReached = true;
      return false;
    }

    const remaining = Number.isFinite(limit)
      ? Math.max(1, Math.min(OPENFDA_PAGE_LIMIT, limit - state.processed))
      : OPENFDA_PAGE_LIMIT;

    let page: DrugsfdaResponse;
    try {
      page = await fetchDrugsfdaPage(politeFetch, { start, end, skip, limit: remaining, apiKey });
    } catch (error) {
      if (error instanceof HttpError) {
        result.notes.push(error.message);
        state.aborted = true;
        return false;
      }
      throw error;
    }

    if (skip === 0 && page.meta.results.total > OPENFDA_SKIP_CEILING) {
      const halves = splitDateWindow(start, end);
      if (halves) {
        const [[s1, e1], [s2, e2]] = halves;
        const leftOk = await walkWindow(deps, state, result, s1, e1);
        if (state.aborted || state.limitReached) return leftOk;
        const rightOk = await walkWindow(deps, state, result, s2, e2);
        return leftOk && rightOk;
      }
      result.notes.push(
        `${start}: ${page.meta.results.total} results exceed the skip ceiling of ` +
          `${OPENFDA_SKIP_CEILING} and the window (a single day) cannot be narrowed further; ` +
          "some results were not walked",
      );
      // Fall through: page this single day up to the ceiling anyway, then
      // the incomplete flag below keeps the watermark from advancing past it.
    }

    if (!state.fingerprinted && page.results[0]) {
      await store.setFingerprint(
        "openfda",
        FINGERPRINT_KEY,
        drugsfdaRowFingerprint(page.results[0]),
      );
      state.fingerprinted = true;
    }

    const approvals: FdaApproval[] = [];
    for (const raw of page.results) {
      state.processed += 1;
      let application: DrugsfdaApplication;
      try {
        application = drugsfdaApplicationSchema.parse(raw);
      } catch (error) {
        result.parse.attempted += 1;
        logger.warn("application failed to validate", {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const rawSubmission of application.submissions ?? []) {
        const statusDate = parseSubmissionStatusDate(rawSubmission);
        if (statusDate === null) {
          // Can't tell which window (if any) this submission belongs to —
          // surfaced as a failure every time its application is seen, rather
          // than silently dropped.
          result.parse.attempted += 1;
          logger.warn("submission missing a usable status date", {
            applicationNumber: application.application_number,
          });
          continue;
        }
        if (statusDate < start || statusDate > end) continue; // a sibling outside this window.

        result.parse.attempted += 1;
        try {
          const approval = await normalizeSubmission(
            application,
            rawSubmission,
            retrievedAt,
            store,
          );
          approvals.push(approval);
          result.parse.succeeded += 1;
          if (state.maxStatusDate === null || statusDate > state.maxStatusDate) {
            state.maxStatusDate = statusDate;
          }
        } catch (error) {
          logger.warn("submission failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (approvals.length > 0) {
      const { rows } = await store.upsert(DATASETS["fda-approvals"], approvals);
      result.rowsUpserted += rows;
      result.perDataset["fda-approvals"] = (result.perDataset["fda-approvals"] ?? 0) + rows;
    }
    logger.info(
      `${start}..${end} skip=${skip}: ${page.results.length} applications, ${approvals.length} rows`,
    );

    const consumed = skip + page.results.length;
    if (page.results.length < remaining || consumed >= page.meta.results.total) {
      return true;
    }
    skip += remaining;
  }
}

export const openfdaSource: TrackerSource = {
  id: "openfda",
  title: "openFDA (drug application events)",
  datasets: ["fda-approvals"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("openfda");
    const result = emptySyncResult("openfda", true);
    if (opts.datasets && !opts.datasets.includes("fda-approvals")) return result;

    const politeFetch = buildFetch(ctx);
    const apiKey = ctx.config.openfdaApiKey;
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const watermark = opts.full ? null : await ctx.store.getWatermark("openfda", WATERMARK_KEY);
    const start =
      opts.since ??
      (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
    const untilBound = opts.until ?? today;
    const end = untilBound > today ? today : untilBound;
    const windowStart = start > end ? end : start;

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const state: WalkState = {
      processed: 0,
      fingerprinted: false,
      maxStatusDate: null,
      aborted: false,
      limitReached: false,
    };

    const complete = await walkWindow(
      { politeFetch, store: ctx.store, logger, apiKey, retrievedAt, limit },
      state,
      result,
      windowStart,
      end,
    );

    if (state.limitReached) {
      result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
    }

    // Only a completed walk may advance the watermark, and only forward.
    if (complete && state.maxStatusDate !== null) {
      const existing = await ctx.store.getWatermark("openfda", WATERMARK_KEY);
      if (existing === null || state.maxStatusDate > existing) {
        await ctx.store.setWatermark("openfda", WATERMARK_KEY, state.maxStatusDate);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const politeFetch = buildFetch(ctx);
    const apiKey = ctx.config.openfdaApiKey;

    try {
      const page = await fetchDrugsfdaPage(politeFetch, {
        start: addDays(today, -CANARY_PROBE_DAYS),
        end: today,
        skip: 0,
        limit: 1,
        apiKey,
      });
      checks.push({
        name: "probe-drugsfda",
        ok: true,
        severity: "hard",
        note: `${page.results.length} row(s) in the last ${CANARY_PROBE_DAYS} days${apiKey ? " (keyed)" : " (keyless)"}`,
      });

      const first = page.results[0];
      if (first) {
        const hash = drugsfdaRowFingerprint(first);
        const stored = await ctx.store.getFingerprint("openfda", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("openfda", FINGERPRINT_KEY, hash);
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

        let application: DrugsfdaApplication | null = null;
        try {
          application = drugsfdaApplicationSchema.parse(first);
        } catch {
          application = null;
        }
        let attempted = 0;
        let succeeded = 0;
        for (const rawSubmission of application?.submissions ?? []) {
          attempted += 1;
          try {
            await normalizeSubmission(
              application as DrugsfdaApplication,
              rawSubmission,
              now.toISOString(),
              ctx.store,
            );
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        const rate = attempted > 0 ? succeeded / attempted : 1;
        checks.push({
          name: "parse-success-rate",
          ok: rate >= 0.99,
          severity: "hard",
          note: `${succeeded}/${attempted} submissions on the probe row`,
        });
      }
    } catch (error) {
      checks.push({
        name: "probe-drugsfda",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // Drugs@FDA refreshes on a lag measured in days-to-weeks; the freshness window is generous.
    const lastIngested = await ctx.store.maxRetrievedAt("fda-approvals");
    checks.push({
      name: "freshness-fda-approvals",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["fda-approvals"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
