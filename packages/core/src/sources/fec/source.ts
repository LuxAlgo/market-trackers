import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { hoursSince } from "../../lib/dates.js";
import type { PoliteFetch } from "../../lib/http.js";
import {
  CM_ENTRY_NAME,
  CN_ENTRY_NAME,
  createFecFetch,
  fecCandidateMasterZipUrl,
  fecCommitteeMasterZipUrl,
  fecPas2ZipUrl,
  fecWeballZipUrl,
  fetchBulkTextFile,
  firstNonEmptyLine,
  PAS2_ENTRY_NAME,
  pipeColumnFingerprint,
  cycleSuffix,
  weballEntryName,
} from "./client.js";
import {
  buildCandidateNameMap,
  buildCommitteeNameMap,
  normalizeCandidateLine,
  normalizeContributionLine,
} from "./records.js";
import { walkPipeFile } from "./walk.js";

/**
 * FEC bulk downloads (keyless): the "all candidates" summary and
 * committee→candidate contributions, per two-year election cycle. Both are
 * point-in-time snapshot files (not date-walkable APIs), so this source's
 * sync semantics differ from most others in the project — see
 * docs/sources/fec.md for the full model. `[verify-live]` the exact bulk
 * file base path, naming convention, and column layouts (the last of
 * these lives in `fields.ts`).
 */

export * from "./zip.js";
export * from "./fields.js";
export * from "./normalize.js";
export * from "./client.js";
export * from "./records.js";
export * from "./walk.js";

const WEBALL_FINGERPRINT_KEY = "fec.weball.columns";
const PAS2_FINGERPRINT_KEY = "fec.pas2.columns";
const CN_FINGERPRINT_KEY = "fec.cn.columns";
const CM_FINGERPRINT_KEY = "fec.cm.columns";

/** Freshness throttle: a cycle's bulk files are point-in-time snapshots, so
 *  a completed walk younger than this is not re-fetched unless the caller
 *  passes `--full` or `--since` — see docs/sources/fec.md. */
const FRESHNESS_THROTTLE_HOURS = 20;

function lastFetchedWatermarkKey(cycle: number): string {
  return `fec.${cycle}.lastFetchedAt`;
}

/**
 * The current even-year election cycle for a given clock: an odd year
 * belongs to the cycle that closes at its *next* even year (2025 → 2026),
 * an even year is its own cycle (2026 → 2026).
 */
export function fecCurrentCycle(now: Date): number {
  const year = now.getUTCFullYear();
  return year % 2 === 0 ? year : year + 1;
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createFecFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("fec"),
  });
}

export const fecSource: AltDataSource = {
  id: "fec",
  title: "FEC campaign finance",
  datasets: ["fec-candidates", "fec-contributions"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("fec");
    const result = emptySyncResult("fec", true);

    const wantCandidates = !opts.datasets || opts.datasets.includes("fec-candidates");
    const wantContributions = !opts.datasets || opts.datasets.includes("fec-contributions");
    if (!wantCandidates && !wantContributions) return result;

    const now = ctx.now?.() ?? new Date();
    const cycle = fecCurrentCycle(now);
    const retrievedAt = now.toISOString();
    const watermarkKey = lastFetchedWatermarkKey(cycle);

    // These bulk files are whole-cycle point-in-time snapshots, not a
    // date-walked feed: `--since` has no date-boundary meaning here (there
    // is nothing to walk "from"), so — like `--full` — its mere presence is
    // read only as "force a refetch, ignore the freshness throttle."
    const forceRefetch = Boolean(opts.full) || opts.since !== undefined;
    if (!forceRefetch) {
      const watermark = await ctx.store.getWatermark("fec", watermarkKey);
      if (watermark !== null && hoursSince(watermark, now) < FRESHNESS_THROTTLE_HOURS) {
        result.notes.push(
          `skipped: cycle ${cycle} bulk files were fetched ${hoursSince(watermark, now).toFixed(1)}h ago ` +
            `(freshness throttle is ${FRESHNESS_THROTTLE_HOURS}h); pass --full or --since to force a refetch`,
        );
        return result;
      }
    }

    const politeFetch = buildFetch(ctx);
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let limitHit = false;
    let fetchFailed = false;

    if (wantCandidates) {
      try {
        const url = fecWeballZipUrl(cycle);
        const text = await fetchBulkTextFile(politeFetch, url, weballEntryName(cycle));
        const outcome = await walkPipeFile(
          text,
          limit,
          (line) => normalizeCandidateLine({ line, cycle, retrievedAt }),
          async (batch) => (await ctx.store.upsert(DATASETS["fec-candidates"], batch)).rows,
          logger,
        );
        result.parse.attempted += outcome.attempted;
        result.parse.succeeded += outcome.succeeded;
        result.rowsUpserted += outcome.upserted;
        result.perDataset["fec-candidates"] =
          (result.perDataset["fec-candidates"] ?? 0) + outcome.upserted;
        if (outcome.firstLine !== null) {
          await ctx.store.setFingerprint(
            "fec",
            WEBALL_FINGERPRINT_KEY,
            pipeColumnFingerprint(outcome.firstLine),
          );
        }
        if (outcome.limitHit) {
          limitHit = true;
          result.notes.push(
            `stopped at --limit ${opts.limit} for weball${cycleSuffix(cycle)}.txt; watermark not advanced`,
          );
        }
        logger.info(
          `weball${cycleSuffix(cycle)}.txt: ${outcome.succeeded}/${outcome.attempted} rows parsed, ${outcome.upserted} upserted`,
        );
      } catch (error) {
        fetchFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        result.notes.push(`weball fetch/parse failed: ${message}`);
        logger.warn("weball fetch/parse failed", { error: message });
      }
    }

    if (wantContributions) {
      try {
        const cnText = await fetchBulkTextFile(
          politeFetch,
          fecCandidateMasterZipUrl(cycle),
          CN_ENTRY_NAME,
        );
        const candidateNames = buildCandidateNameMap(cnText);
        const cnFirstLine = firstNonEmptyLine(cnText);
        if (cnFirstLine !== null) {
          await ctx.store.setFingerprint(
            "fec",
            CN_FINGERPRINT_KEY,
            pipeColumnFingerprint(cnFirstLine),
          );
        }

        const cmText = await fetchBulkTextFile(
          politeFetch,
          fecCommitteeMasterZipUrl(cycle),
          CM_ENTRY_NAME,
        );
        const committeeNames = buildCommitteeNameMap(cmText);
        const cmFirstLine = firstNonEmptyLine(cmText);
        if (cmFirstLine !== null) {
          await ctx.store.setFingerprint(
            "fec",
            CM_FINGERPRINT_KEY,
            pipeColumnFingerprint(cmFirstLine),
          );
        }

        const pas2Text = await fetchBulkTextFile(
          politeFetch,
          fecPas2ZipUrl(cycle),
          PAS2_ENTRY_NAME,
        );
        const outcome = await walkPipeFile(
          pas2Text,
          limit,
          (line) =>
            normalizeContributionLine({ line, cycle, retrievedAt, candidateNames, committeeNames }),
          async (batch) => (await ctx.store.upsert(DATASETS["fec-contributions"], batch)).rows,
          logger,
        );
        result.parse.attempted += outcome.attempted;
        result.parse.succeeded += outcome.succeeded;
        result.rowsUpserted += outcome.upserted;
        result.perDataset["fec-contributions"] =
          (result.perDataset["fec-contributions"] ?? 0) + outcome.upserted;
        if (outcome.firstLine !== null) {
          await ctx.store.setFingerprint(
            "fec",
            PAS2_FINGERPRINT_KEY,
            pipeColumnFingerprint(outcome.firstLine),
          );
        }
        if (outcome.limitHit) {
          limitHit = true;
          result.notes.push(
            `stopped at --limit ${opts.limit} for itpas2.txt; watermark not advanced`,
          );
        }
        logger.info(
          `itpas2.txt: ${outcome.succeeded}/${outcome.attempted} rows parsed, ${outcome.upserted} upserted`,
        );
      } catch (error) {
        fetchFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        result.notes.push(`pas2/masters fetch/parse failed: ${message}`);
        logger.warn("pas2/masters fetch/parse failed", { error: message });
      }
    }

    // Only a walk that hit neither an HTTP/parse-fatal failure nor --limit
    // may advance the watermark — a partial walk must be retried in full.
    if (!limitHit && !fetchFailed) {
      await ctx.store.setWatermark("fec", watermarkKey, retrievedAt);
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const cycle = fecCurrentCycle(now);
    const politeFetch = buildFetch(ctx);
    const weballUrl = fecWeballZipUrl(cycle);

    // Hard fetch check: a cheap HEAD first. weball is comparatively small
    // (the "all candidates" summary, not the much larger contributions
    // file), so falling back to a real full GET when HEAD isn't supported
    // is acceptable — and that GET is needed anyway for the fingerprint
    // check right below, so there is no separate, wasted "reachability
    // only" request.
    let headOk = false;
    let headNote: string | undefined;
    try {
      const headResponse = await politeFetch(weballUrl, { method: "HEAD" });
      await headResponse.arrayBuffer().catch(() => undefined);
      headOk = headResponse.ok;
      if (!headOk) headNote = `HEAD returned HTTP ${headResponse.status}`;
    } catch (error) {
      headNote = `HEAD failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      const text = await fetchBulkTextFile(politeFetch, weballUrl, weballEntryName(cycle));
      checks.push({
        name: "fetch-weball",
        ok: true,
        severity: "hard",
        note: headOk
          ? undefined
          : `${headNote ?? "HEAD unsupported"}; fell back to a full GET, which succeeded`,
      });

      const firstLine = firstNonEmptyLine(text);
      const hash = pipeColumnFingerprint(firstLine ?? "");
      const stored = await ctx.store.getFingerprint("fec", WEBALL_FINGERPRINT_KEY);
      if (stored === null) {
        await ctx.store.setFingerprint("fec", WEBALL_FINGERPRINT_KEY, hash);
        checks.push({
          name: "fingerprint-weball",
          ok: true,
          severity: "hard",
          note: "baseline recorded",
        });
      } else {
        checks.push({
          name: "fingerprint-weball",
          ok: stored === hash,
          severity: "hard",
          note:
            stored === hash
              ? undefined
              : `weball column count changed (was ${stored}, now ${hash})`,
        });
      }
    } catch (error) {
      checks.push({
        name: "fetch-weball",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // pas2 is never re-fetched here: in production it can be a multi-
    // hundred-MB file, far too large for a routine health check. Its
    // fingerprint check instead confirms a baseline was recorded by the
    // last real sync — true drift detection for pas2 happens the moment
    // sync() recomputes it and finds it no longer matches.
    // Soft: a fresh store simply hasn't synced contributions yet — that's
    // staleness, not drift. Real pas2 drift turns red at sync time, when the
    // recomputed fingerprint no longer matches this stored baseline.
    const pas2Fingerprint = await ctx.store.getFingerprint("fec", PAS2_FINGERPRINT_KEY);
    checks.push({
      name: "fingerprint-pas2",
      ok: pas2Fingerprint !== null,
      severity: "soft",
      note:
        pas2Fingerprint !== null
          ? undefined
          : "no pas2 fingerprint recorded yet — recorded on the first contributions sync",
    });

    const lastSync = await ctx.store.latestSyncRun("fec");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} rows`,
      });
    }

    for (const datasetId of ["fec-candidates", "fec-contributions"] as const) {
      const lastIngested = await ctx.store.maxRetrievedAt(datasetId);
      checks.push({
        name: `freshness-${datasetId}`,
        ok:
          lastIngested !== null &&
          hoursSince(lastIngested, now) <= DATASETS[datasetId].freshnessWindowHours,
        severity: "soft",
        note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
      });
    }

    return { checks };
  },
};
