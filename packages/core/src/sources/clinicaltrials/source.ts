import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { ClinicalTrial } from "../../schema/clinical-trial.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import type { TrackerStore } from "../../store/store.js";
import { resolveEntityTickersTiered } from "../../resolve/sec-names.js";
import {
  createClinicalTrialsFetch,
  extractFullDate,
  extractPartialDate,
  fetchStudiesPage,
  studyDetailUrl,
  studyRowFingerprint,
  studySchema,
} from "./client.js";

export {
  CLINICALTRIALS_API_BASE,
  CLINICALTRIALS_STUDIES_URL,
  CLINICALTRIALS_FIELDS,
  CLINICALTRIALS_PAGE_SIZE,
  lastUpdatePostedRangeTerm,
  studiesPageUrl,
  studyDetailUrl,
  extractPartialDate,
  extractFullDate,
} from "./client.js";

/**
 * ClinicalTrials.gov API v2 — study registrations and status changes, walked
 * by `LastUpdatePostDate` range and paged via `pageToken`. Natural key is
 * `nctId`: a study's row is overwritten as its registration updates
 * (upsert), so the dataset always reflects each study's latest registry
 * state, while daily dump deltas preserve the change history. Sponsors
 * resolve to tickers through the two-tier resolver (curated map, then the
 * SEC issuer-name fallback — see `resolve/sec-names.ts`); still-unmatched
 * sponsors are stored with `tickers: []`.
 *
 * Non-goal guard: `primaryCompletionDate` ships verbatim as the sponsor's
 * declared plan. Nothing here turns it into a decision/catalyst calendar —
 * see the README's non-goals and docs/sources/clinicaltrials.md.
 */

export const CLINICALTRIALS_PARSER = "clinicaltrials-v2@1";

const WATERMARK_KEY = "clinicaltrials.lastUpdatePosted";
const FINGERPRINT_KEY = "clinicaltrials.study-row-fields";
/** Registries amend studies after posting; re-walk this many trailing days. */
const REWALK_DAYS = 7;
/** Canary probe window — wide enough that a quiet day never looks like an outage. */
const CANARY_PROBE_DAYS = 30;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createClinicalTrialsFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("clinicaltrials"),
  });
}

/** Multiple phases ("Phase 2/Phase 3" trials) join verbatim; no phase concept → null. */
function normalizePhase(phases: string[] | undefined): string | null {
  return phases && phases.length > 0 ? phases.join("/") : null;
}

/** Normalizes one raw study; throws when a required field is missing or unusable. */
export async function normalizeStudy(
  raw: Record<string, unknown>,
  retrievedAt: string,
  store: TrackerStore,
): Promise<ClinicalTrial> {
  const study = studySchema.parse(raw);
  const ps = study.protocolSection;

  const nctId = ps.identificationModule.nctId.trim();
  if (!/^NCT\d+$/.test(nctId)) throw new Error(`study '${nctId}': malformed nctId`);

  const title = ps.identificationModule.briefTitle?.trim();
  if (!title) throw new Error(`study ${nctId}: missing briefTitle`);

  const sponsorName = ps.sponsorCollaboratorsModule?.leadSponsor?.name?.trim();
  if (!sponsorName) throw new Error(`study ${nctId}: missing lead sponsor name`);

  const overallStatus = ps.statusModule?.overallStatus?.trim();
  if (!overallStatus) throw new Error(`study ${nctId}: missing overallStatus`);

  const lastUpdated = extractFullDate(ps.statusModule?.lastUpdatePostDateStruct);
  if (!lastUpdated) throw new Error(`study ${nctId}: missing/unusable lastUpdatePostDate`);

  return {
    id: nctId,
    nctId,
    title,
    sponsor: {
      name: sponsorName,
      tickers: await resolveEntityTickersTiered(store, { name: sponsorName }),
    },
    phase: normalizePhase(ps.designModule?.phases),
    overallStatus,
    studyType: ps.designModule?.studyType ?? null,
    conditions: ps.conditionsModule?.conditions ?? [],
    startDate: extractPartialDate(ps.statusModule?.startDateStruct),
    primaryCompletionDate: extractPartialDate(ps.statusModule?.primaryCompletionDateStruct),
    lastUpdated,
    provenance: {
      source: "clinicaltrials",
      sourceUrl: studyDetailUrl(nctId),
      retrievedAt,
      parser: CLINICALTRIALS_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

export const clinicaltrialsSource: TrackerSource = {
  id: "clinicaltrials",
  title: "ClinicalTrials.gov (study registrations)",
  datasets: ["clinical-trials"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("clinicaltrials");
    const result = emptySyncResult("clinicaltrials", true);
    if (opts.datasets && !opts.datasets.includes("clinical-trials")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const watermark = opts.full
      ? null
      : await ctx.store.getWatermark("clinicaltrials", WATERMARK_KEY);
    const start =
      opts.since ??
      (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
    const end = opts.until ?? today;
    if (start > end) {
      result.notes.push(`--since ${start} is after --until ${end}; nothing to walk`);
      return result;
    }

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let pageToken: string | undefined;
    let page = 1;
    let maxLastUpdated: string | null = null;
    let fingerprinted = false;
    let complete = false;

    for (;;) {
      let response;
      try {
        response = await fetchStudiesPage(politeFetch, { start, end, pageToken });
      } catch (error) {
        // Exhausted retries: keep partial progress, leave the watermark put.
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          break;
        }
        throw error;
      }

      if (!fingerprinted && response.studies[0]) {
        await ctx.store.setFingerprint(
          "clinicaltrials",
          FINGERPRINT_KEY,
          studyRowFingerprint(response.studies[0]),
        );
        fingerprinted = true;
      }

      const trials: ClinicalTrial[] = [];
      for (const raw of response.studies) {
        processed += 1;
        result.parse.attempted += 1;
        try {
          const trial = await normalizeStudy(raw, retrievedAt, ctx.store);
          trials.push(trial);
          result.parse.succeeded += 1;
          if (maxLastUpdated === null || trial.lastUpdated > maxLastUpdated) {
            maxLastUpdated = trial.lastUpdated;
          }
        } catch (error) {
          logger.warn("study row failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (trials.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["clinical-trials"], trials);
        result.rowsUpserted += rows;
        result.perDataset["clinical-trials"] = (result.perDataset["clinical-trials"] ?? 0) + rows;
      }
      logger.info(`page ${page}: ${trials.length} studies (${start}..${end})`);

      if (!response.nextPageToken) {
        complete = true;
        break;
      }
      if (processed >= limit) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        break;
      }
      pageToken = response.nextPageToken;
      page += 1;
    }

    // Only a completed walk may advance the watermark, only forward, and
    // never past `end` — a bounded --until chunk must not claim freshness
    // beyond what it actually walked.
    if (complete && maxLastUpdated !== null) {
      const bounded = maxLastUpdated > end ? end : maxLastUpdated;
      const existing = await ctx.store.getWatermark("clinicaltrials", WATERMARK_KEY);
      if (existing === null || bounded > existing) {
        await ctx.store.setWatermark("clinicaltrials", WATERMARK_KEY, bounded);
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
      const response = await fetchStudiesPage(politeFetch, {
        start: addDays(today, -CANARY_PROBE_DAYS),
        end: today,
        pageSize: 1,
      });
      checks.push({
        name: "probe-studies",
        ok: true,
        severity: "hard",
        note: `${response.studies.length} row(s) in the last ${CANARY_PROBE_DAYS} days`,
      });

      const first = response.studies[0];
      if (first) {
        const hash = studyRowFingerprint(first);
        const stored = await ctx.store.getFingerprint("clinicaltrials", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("clinicaltrials", FINGERPRINT_KEY, hash);
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
            note: stored === hash ? undefined : "study module/field shape changed",
          });
        }

        let succeeded = 0;
        for (const raw of response.studies) {
          try {
            await normalizeStudy(raw, now.toISOString(), ctx.store);
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        const rate = succeeded / response.studies.length;
        checks.push({
          name: "parse-success-rate",
          ok: rate >= 0.99,
          severity: "hard",
          note: `${succeeded}/${response.studies.length} probe rows`,
        });
      }
    } catch (error) {
      checks.push({
        name: "probe-studies",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("clinical-trials");
    checks.push({
      name: "freshness-clinical-trials",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["clinical-trials"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
