import { createHash } from "node:crypto";
import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { CongressTrade } from "../../schema/congress-trade.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { addDays, hoursSince, isoNow, toDateString } from "../../lib/dates.js";
import type { Logger } from "../../lib/logger.js";
import { matchMember, refreshMemberMapIfStale } from "../../resolve/members.js";
import {
  SenateEfdClient,
  searchRowShape,
  type EfdSearchPage,
  type EfdSearchRow,
} from "./client.js";
import { parsePtrHtml } from "./ptr-html.js";
import { getSenateEfdScanExtractor, scanRowContractViolation } from "./scan-extract.js";

export { SENATE_EFD_BASE, SENATE_EFD_SEARCH_HOME, SENATE_EFD_SEARCH_DATA } from "./client.js";

/**
 * Senate eFD — Periodic Transaction Reports filed by senators.
 *
 * Web-table PTRs parse directly (efd-ptr-html@1, confidence 0.9); scanned
 * paper PTRs go through the pluggable scan extractor (confidence 0.7,
 * needsReview) and are reported as pending when none is registered.
 * Amounts stay ranges; member identity resolves to bioguide or stays null.
 *
 * Watermark rides the filed date; every incremental run re-walks the last
 * 7 days before it to catch late postings — idempotent upserts by natural
 * key make the overlap free.
 */

const WATERMARK_KEY = "efd.lastFiledDate";
const FINGERPRINT_KEY = "efd.structure";
const LATE_POSTING_REWALK_DAYS = 7;
const SEARCH_PAGE_LENGTH = 100;
const CANARY_WINDOW_DAYS = 30;

function buildClient(ctx: SourceContext, logger: Logger): SenateEfdClient {
  return new SenateEfdClient({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger,
  });
}

/** Search-grid shape + PTR table header, hashed for drift detection. */
function structuralFingerprint(shape: string, headerRow: string[]): string {
  return createHash("sha256")
    .update(`${shape}\n${headerRow.join("|")}`)
    .digest("hex")
    .slice(0, 16);
}

function filerName(row: EfdSearchRow): string {
  const name = `${row.firstName} ${row.lastName}`.trim();
  return name.length > 0 ? name : row.office;
}

/** Pages the whole grid since `filedAfter`, deduped and sorted by filed date. */
async function collectSearchRows(
  client: SenateEfdClient,
  filedAfter: string,
): Promise<EfdSearchRow[]> {
  const byDocId = new Map<string, EfdSearchRow>();
  let start = 0;
  let total = Number.POSITIVE_INFINITY;
  while (start < total) {
    const page = await client.searchPtrs({ filedAfter, start, length: SEARCH_PAGE_LENGTH });
    total = page.recordsTotal;
    if (page.raw.length === 0) break;
    for (const row of page.rows) byDocId.set(row.docId, row);
    start += page.raw.length;
  }
  return [...byDocId.values()].sort((a, b) =>
    a.filedAt === b.filedAt ? a.docId.localeCompare(b.docId) : a.filedAt < b.filedAt ? -1 : 1,
  );
}

export const senateEfdSource: AltDataSource = {
  id: "senate-efd",
  title: "Senate eFD (Periodic Transaction Reports)",
  datasets: ["congress-trades"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("senate-efd");
    const result = emptySyncResult("senate-efd", true);
    if (opts.datasets && !opts.datasets.includes("congress-trades")) return result;

    await refreshMemberMapIfStale(ctx.store, ctx.fetchImpl ?? fetch, logger);
    const members = await ctx.store.allMembers();

    const client = buildClient(ctx, logger);
    const today = toDateString(ctx.now?.() ?? new Date());
    const watermark = opts.full ? null : await ctx.store.getWatermark("senate-efd", WATERMARK_KEY);
    const start =
      opts.since ??
      (watermark
        ? // Re-walk a week behind the watermark: eFD posts filings late and
          // amends under fresh UUIDs; upserts by natural key keep this free.
          addDays(watermark, -LATE_POSTING_REWALK_DAYS)
        : addDays(today, -ctx.config.backfillDays));

    const filings = await collectSearchRows(client, start);
    if (filings.length === 0) {
      result.notes.push(`no PTR filings found since ${start}`);
      return result;
    }

    const extractor = getSenateEfdScanExtractor();
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let fetched = 0;
    let pendingScanned = 0;
    let stoppedAtLimit = false;
    // Advances only through filed dates whose every filing was handled, so an
    // early stop never skips the remainder of a day.
    let maxCompletedFiledDate: string | null = null;

    for (let i = 0; i < filings.length; i++) {
      const filing = filings[i] as EfdSearchRow;
      const memberName = filerName(filing);

      if (filing.docType === "paper" && !extractor) {
        // No extractor: count it, never fabricate rows for an image scan.
        pendingScanned += 1;
      } else {
        if (fetched >= limit) {
          stoppedAtLimit = true;
          break;
        }
        fetched += 1;
        result.parse.attempted += 1;
        try {
          let rows: CongressTrade[];
          if (filing.docType === "paper") {
            // Non-null: the branch above catches paper filings without one.
            rows = await (extractor as NonNullable<typeof extractor>).extract({
              docId: filing.docId,
              url: filing.url,
              memberName,
              filedAt: filing.filedAt,
            });
            const violation = scanRowContractViolation(rows);
            if (violation) {
              throw new Error(`scan extractor broke the honesty contract: ${violation}`);
            }
          } else {
            const html = await client.fetchPtrHtml(filing.docId);
            rows = parsePtrHtml({
              html,
              docId: filing.docId,
              memberName,
              filedAt: filing.filedAt,
              sourceUrl: filing.url,
              retrievedAt: isoNow(),
            }).rows;
          }

          const resolved = matchMember(members, memberName, "senate");
          if (resolved) {
            for (const row of rows) {
              row.member.bioguideId = resolved.bioguideId;
              row.member.party = resolved.party;
              row.member.state = resolved.state;
            }
          }

          const { rows: upserted } = await ctx.store.upsert(DATASETS["congress-trades"], rows);
          result.rowsUpserted += upserted;
          result.perDataset["congress-trades"] =
            (result.perDataset["congress-trades"] ?? 0) + upserted;
          result.parse.succeeded += 1;
          logger.info(`${filing.docId} (${memberName}, filed ${filing.filedAt}): ${upserted} rows`);
        } catch (error) {
          logger.warn(`parse failed for ${filing.url}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const next = filings[i + 1];
      if (!next || next.filedAt !== filing.filedAt) maxCompletedFiledDate = filing.filedAt;
    }

    if (stoppedAtLimit) result.notes.push(`stopped at --limit ${opts.limit}`);
    if (pendingScanned > 0) {
      result.notes.push(`${pendingScanned} scanned filings pending (no scan extractor configured)`);
    }

    if (maxCompletedFiledDate) {
      // Never regress: the re-walk window starts behind the stored watermark.
      const existing = await ctx.store.getWatermark("senate-efd", WATERMARK_KEY);
      if (existing === null || maxCompletedFiledDate > existing) {
        await ctx.store.setWatermark("senate-efd", WATERMARK_KEY, maxCompletedFiledDate);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const logger = ctx.logger.child("senate-efd");
    const client = buildClient(ctx, logger);
    const windowStart = addDays(toDateString(now), -CANARY_WINDOW_DAYS);

    let page: EfdSearchPage | null = null;
    try {
      page = await client.searchPtrs({ filedAfter: windowStart, start: 0, length: 25 });
      checks.push({
        name: "agreement-and-search",
        ok: true,
        severity: "hard",
        note: `${page.recordsTotal} PTR filings since ${windowStart}`,
      });
    } catch (error) {
      checks.push({
        name: "agreement-and-search",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    if (page) {
      const shape = searchRowShape(page.raw);
      const ptrRow = page.rows.find((row) => row.docType === "ptr");
      if (shape && ptrRow) {
        try {
          const html = await client.fetchPtrHtml(ptrRow.docId);
          const parsed = parsePtrHtml({
            html,
            docId: ptrRow.docId,
            memberName: filerName(ptrRow),
            filedAt: ptrRow.filedAt,
            sourceUrl: ptrRow.url,
            retrievedAt: isoNow(),
          });
          const hash = structuralFingerprint(shape, parsed.headerRow);
          const stored = await ctx.store.getFingerprint("senate-efd", FINGERPRINT_KEY);
          if (stored === null) {
            await ctx.store.setFingerprint("senate-efd", FINGERPRINT_KEY, hash);
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
              note: stored === hash ? undefined : "search row shape or PTR table header changed",
            });
          }
        } catch (error) {
          checks.push({
            name: "fingerprint",
            ok: false,
            severity: "hard",
            note: `PTR page no longer parses: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const latestFiled =
        page.rows
          .map((row) => row.filedAt)
          .sort()
          .at(-1) ?? null;
      const windowHours = DATASETS["congress-trades"].freshnessWindowHours;
      checks.push({
        name: "freshness-congress-trades",
        ok: latestFiled !== null && hoursSince(`${latestFiled}T00:00:00.000Z`, now) <= windowHours,
        severity: "soft",
        note: latestFiled ? `latest PTR filed ${latestFiled}` : "no PTR filings in probe window",
      });
    }

    const lastSync = await ctx.store.latestSyncRun("senate-efd");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} documents`,
      });
    }

    return { checks };
  },
};
