import type { DocketSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { Patent } from "../../schema/patent.js";
import { DOCKET_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { resolveEntityTickers } from "../../resolve/recipients.js";
import {
  createPatentsviewFetch,
  fetchPatentPage,
  patentDocumentUrl,
  patentRowFingerprint,
  patentsviewPatentRowSchema,
  requirePatentsviewApiKey,
  PATENTSVIEW_PAGE_SIZE,
  type PatentsviewListResponse,
} from "./client.js";

export {
  PATENTSVIEW_API_BASE,
  PATENTSVIEW_PATENT_URL,
  PATENTSVIEW_PAGE_SIZE,
  PATENTSVIEW_FIELDS,
  PATENTSVIEW_SORT,
  patentDocumentUrl,
  requirePatentsviewApiKey,
  patentRowFingerprint,
  buildPatentDateRangeQuery,
} from "./client.js";

/**
 * PatentsView PatentSearch API — granted US patents (USPTO data). A single
 * grant-date range query, walked forward page by page via the API's
 * "after" cursor (ascending `patent_id`); natural key is `patent_id`.
 *
 * With no watermark (or `--full`) the walk starts `backfillDays` back from
 * today, same as FINRA/EDGAR. With a watermark it starts a small trailing
 * re-walk before `patents.lastGrantDate` — patents occasionally get
 * corrected/republished within the same weekly grant batch. The watermark
 * only advances after a fully completed walk, and only forward (the
 * USAspending/LDA pattern).
 *
 * Every live-payload assumption here (query encoding, field names,
 * pagination cursor, response envelope) is listed under `[verify-live]` in
 * docs/sources/patentsview.md.
 */

export const PATENTSVIEW_PARSER = "patentsview-api@1";

const WATERMARK_KEY = "patentsview.lastGrantDate";
const FINGERPRINT_KEY = "patentsview.patent-row-fields";
/** Patents grant weekly; re-walk a few trailing days for late corrections. */
const REWALK_DAYS = 3;
/** Canary probe window: wide enough to reliably span a weekly grant batch. */
const CANARY_PROBE_DAYS = 21;
const CANARY_PROBE_SIZE = 5;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createPatentsviewFetch({
    userAgent: ctx.config.userAgent ?? `docket/${DOCKET_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("patentsview"),
  });
}

/** Normalizes one raw result row; throws when a required field is unusable. */
export function normalizePatentRow(raw: Record<string, unknown>, retrievedAt: string): Patent {
  const row = patentsviewPatentRowSchema.parse(raw);

  const patentId = row.patent_id.trim();
  if (!patentId) throw new Error("patent row: missing patent_id");
  const title = row.patent_title.trim();
  if (!title) throw new Error(`patent ${patentId}: missing title`);
  const grantDateMatch = /^\d{4}-\d{2}-\d{2}/.exec(row.patent_date);
  if (!grantDateMatch) throw new Error(`patent ${patentId}: unparseable patent_date`);
  const grantDate = grantDateMatch[0];

  // "assignee = first-listed organization": individual assignees (no
  // organization name) are skipped when looking for the display name, but
  // still count toward assigneeCount; a patent with no assignees at all
  // (or only individuals) keeps `name: null`.
  const assignees = row.assignees ?? [];
  const orgName = assignees
    .map((a) => a.assignee_organization?.trim())
    .find((name): name is string => Boolean(name));

  const cpcEntries = row.cpc_current ?? [];
  const cpcClass = cpcEntries
    .map((c) => c.cpc_class_id?.trim())
    .find((id): id is string => Boolean(id));

  return {
    id: patentId,
    patentId,
    title,
    grantDate,
    assignee: {
      name: orgName ?? null,
      tickers: orgName ? resolveEntityTickers({ name: orgName }) : [],
    },
    assigneeCount: assignees.length,
    kind: row.wipo_kind?.trim() || null,
    cpcClass: cpcClass ? cpcClass.toUpperCase() : null,
    provenance: {
      source: "patentsview",
      sourceUrl: patentDocumentUrl(patentId),
      retrievedAt,
      parser: PATENTSVIEW_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

/** True once every matching row has been paged through (per `total_hits`, else a short page). */
function pageExhausted(
  response: PatentsviewListResponse,
  cumulativeCount: number,
  requestedSize: number,
): boolean {
  if (response.patents.length === 0) return true;
  if (typeof response.total_hits === "number") return cumulativeCount >= response.total_hits;
  return response.patents.length < requestedSize;
}

function lastPatentId(response: PatentsviewListResponse): string | null {
  const last = response.patents[response.patents.length - 1];
  const id = last?.patent_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export const patentsviewSource: DocketSource = {
  id: "patentsview",
  title: "PatentsView (granted US patents)",
  datasets: ["patents"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("patentsview");
    const result = emptySyncResult("patentsview", true);
    if (opts.datasets && !opts.datasets.includes("patents")) return result;

    const apiKey = requirePatentsviewApiKey(ctx.config);
    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);
    const retrievedAt = now.toISOString();

    const watermark = opts.full ? null : await ctx.store.getWatermark("patentsview", WATERMARK_KEY);
    const since =
      opts.since ??
      (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays));
    const until = opts.until ?? today;

    if (since > until) {
      result.notes.push(`nothing to do: since ${since} is after until ${until}`);
      return result;
    }

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const requestedSize = PATENTSVIEW_PAGE_SIZE;
    let processed = 0;
    let cumulativeCount = 0;
    let maxGrantDate: string | null = null;
    let fingerprinted = false;
    let complete = true;
    let after: string | undefined;

    for (;;) {
      let response: PatentsviewListResponse;
      try {
        response = await fetchPatentPage(politeFetch, {
          since,
          until,
          apiKey,
          after,
          size: requestedSize,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          complete = false;
          break;
        }
        throw error;
      }
      cumulativeCount += response.patents.length;

      if (!fingerprinted && response.patents[0]) {
        await ctx.store.setFingerprint(
          "patentsview",
          FINGERPRINT_KEY,
          patentRowFingerprint(response.patents[0]),
        );
        fingerprinted = true;
      }

      const rows: Patent[] = [];
      for (const raw of response.patents) {
        processed += 1;
        result.parse.attempted += 1;
        try {
          const patent = normalizePatentRow(raw, retrievedAt);
          rows.push(patent);
          result.parse.succeeded += 1;
          if (maxGrantDate === null || patent.grantDate > maxGrantDate)
            maxGrantDate = patent.grantDate;
        } catch (error) {
          logger.warn("patent row failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (rows.length > 0) {
        const { rows: upserted } = await ctx.store.upsert(DATASETS.patents, rows);
        result.rowsUpserted += upserted;
        result.perDataset.patents = (result.perDataset.patents ?? 0) + upserted;
      }
      logger.info(
        `page: ${rows.length} patents (${response.patents.length} raw, cursor ${after ?? "start"})`,
      );

      if (pageExhausted(response, cumulativeCount, requestedSize)) break;
      if (processed >= limit) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        complete = false;
        break;
      }
      const next = lastPatentId(response);
      if (!next) break; // no usable cursor to continue from
      after = next;
    }

    // Only a completed walk may advance the watermark, and only forward.
    if (complete && maxGrantDate !== null) {
      const existing = await ctx.store.getWatermark("patentsview", WATERMARK_KEY);
      if (existing === null || maxGrantDate > existing) {
        await ctx.store.setWatermark("patentsview", WATERMARK_KEY, maxGrantDate);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();

    if (!ctx.config.patentsviewApiKey) {
      checks.push({
        name: "probe-patent",
        ok: false,
        severity: "soft",
        note:
          "skipped: no PatentsView API key configured (DOCKET_PATENTSVIEW_KEY, or " +
          "patentsviewApiKey in docket.config.json — the key is free)",
      });
    } else {
      const politeFetch = buildFetch(ctx);
      const until = toDateString(now);
      const since = addDays(until, -CANARY_PROBE_DAYS);
      try {
        const response = await fetchPatentPage(politeFetch, {
          since,
          until,
          apiKey: ctx.config.patentsviewApiKey,
          size: CANARY_PROBE_SIZE,
        });
        checks.push({
          name: "probe-patent",
          ok: true,
          severity: "hard",
          note: `${response.patents.length} row(s) for ${since}..${until}`,
        });

        const first = response.patents[0];
        if (first) {
          const hash = patentRowFingerprint(first);
          const stored = await ctx.store.getFingerprint("patentsview", FINGERPRINT_KEY);
          if (stored === null) {
            await ctx.store.setFingerprint("patentsview", FINGERPRINT_KEY, hash);
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
          for (const raw of response.patents) {
            try {
              normalizePatentRow(raw, now.toISOString());
              succeeded += 1;
            } catch {
              // counted below
            }
          }
          const rate = succeeded / response.patents.length;
          checks.push({
            name: "parse-success-rate",
            ok: rate >= 0.99,
            severity: "hard",
            note: `${succeeded}/${response.patents.length} probe rows`,
          });
        }
      } catch (error) {
        checks.push({
          name: "probe-patent",
          ok: false,
          severity: "hard",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const lastIngested = await ctx.store.maxRetrievedAt("patents");
    checks.push({
      name: "freshness-patents",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS.patents.freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
