import { createHash } from "node:crypto";
import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { createPoliteFetch, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import { addDays, hoursSince, isoNow, toDateString } from "../../lib/dates.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { matchMember, refreshMemberMapIfStale } from "../../resolve/members.js";
import type { MemberMapEntry } from "../../store/store.js";
import {
  fetchYearIndex,
  housePtrPdfUrl,
  houseClerkYearIndexUrl,
  parseYearIndexXml,
  type HouseIndexFiling,
} from "./client.js";
import { parsePtrItems } from "./parse-ptr-items.js";
import { extractPositionedText } from "./pdf-text.js";

/**
 * House Clerk financial disclosures — Periodic Transaction Reports filed by
 * representatives. The yearly index ZIP lists every filing; type "P" rows
 * are PTRs whose PDFs are layout-parsed at confidence 0.9 (see
 * docs/sources/house-clerk.md).
 */

export { HOUSE_CLERK_BASE, houseClerkYearIndexUrl, housePtrPdfUrl } from "./client.js";

const WATERMARK_KEY = "clerk.lastFiledDate";
const INDEX_FINGERPRINT_KEY = "clerk.index-fields";
const HEADER_FINGERPRINT_KEY = "clerk.ptr-header";
/** The index gains late entries; every sync re-walks this many days behind the watermark. */
const REWALK_DAYS = 7;

/**
 * The PDF-bytes → positioned-text step is injectable so the fully offline
 * test suite can stub it at this seam; everything downstream (layout
 * parsing, member resolution, storage) runs unmodified.
 */
export const houseClerkDeps: { extractPositionedText: typeof extractPositionedText } = {
  extractPositionedText,
};

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createPoliteFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("house-clerk"),
  });
}

function fingerprintHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Current year, plus the previous year through January (late December filings). */
function yearsToWalk(today: string, startDate: string | null): number[] {
  const currentYear = Number(today.slice(0, 4));
  let firstYear = today.slice(5, 7) === "01" ? currentYear - 1 : currentYear;
  if (startDate !== null) {
    firstYear = Math.min(firstYear, Number(startDate.slice(0, 4)));
  }
  const years: number[] = [];
  for (let year = firstYear; year <= currentYear; year++) years.push(year);
  return years;
}

function memberDisplayName(filing: HouseIndexFiling): string {
  return [filing.prefix, filing.first, filing.last, filing.suffix]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function resolveMember(
  members: MemberMapEntry[],
  filing: HouseIndexFiling,
): { name: string; bioguideId: string | null; party: string | null; state: string | null } {
  const resolved = matchMember(members, `${filing.last}, ${filing.first}`, "house");
  return {
    name: memberDisplayName(filing),
    bioguideId: resolved?.bioguideId ?? null,
    party: resolved?.party ?? null,
    state: resolved?.state ?? null,
  };
}

function byFiledDateThenDocId(a: HouseIndexFiling, b: HouseIndexFiling): number {
  if (a.filingDate !== b.filingDate) return a.filingDate < b.filingDate ? -1 : 1;
  return a.docId.localeCompare(b.docId);
}

export const houseClerkSource: AltDataSource = {
  id: "house-clerk",
  title: "House Clerk financial disclosures (PTRs)",
  datasets: ["congress-trades"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("house-clerk");
    const result = emptySyncResult("house-clerk", true);
    if (opts.datasets && !opts.datasets.includes("congress-trades")) return result;

    const politeFetch = buildFetch(ctx);
    await refreshMemberMapIfStale(ctx.store, ctx.fetchImpl ?? fetch, logger);
    const members = await ctx.store.allMembers();

    const today = toDateString(ctx.now?.() ?? new Date());
    const watermark = opts.full ? null : await ctx.store.getWatermark("house-clerk", WATERMARK_KEY);
    // Process filings filed on/after this date; null = no floor (--full).
    const startDate = opts.full
      ? (opts.since ?? null)
      : (opts.since ??
        (watermark ? addDays(watermark, -REWALK_DAYS) : addDays(today, -ctx.config.backfillDays)));
    const years = yearsToWalk(today, startDate);
    // Conditional GETs only apply to the plain incremental walk: --full and
    // --since must see the index content even when the ZIP is unchanged.
    const conditional = !opts.full && !opts.since;

    let fetched = 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let limitStopped = false;
    let maxFiled: string | null = null;

    for (const year of years) {
      const index = await fetchYearIndex(politeFetch, ctx.store, year, { conditional });
      if (index.status === "not-modified") {
        result.notes.push(`${year}FD.zip unchanged since last sync (304)`);
        continue;
      }
      if (index.status === "not-found") {
        result.notes.push(`${year}FD.zip not published yet (404)`);
        continue;
      }
      const parsed = parseYearIndexXml(index.xml);
      if (parsed.skipped > 0) {
        result.notes.push(`${year}: ${parsed.skipped} malformed index rows skipped`);
      }
      await ctx.store.setFingerprint(
        "house-clerk",
        INDEX_FINGERPRINT_KEY,
        fingerprintHash(parsed.fieldSignature),
      );

      const ptrs = parsed.filings
        .filter((f) => f.filingType === "P")
        .filter((f) => startDate === null || f.filingDate >= startDate)
        .sort(byFiledDateThenDocId);
      logger.info(
        `${year}: ${ptrs.length} PTR filings in window (${parsed.filings.length} filings in index)`,
      );

      let yearComplete = true;
      for (const filing of ptrs) {
        if (fetched >= limit) {
          yearComplete = false;
          limitStopped = true;
          break;
        }
        fetched += 1;
        const pdfUrl = housePtrPdfUrl(year, filing.docId);
        const response = await politeFetch(pdfUrl);
        if (response.status === 404) {
          await response.arrayBuffer().catch(() => undefined);
          result.notes.push(`PTR PDF missing for ${filing.docId} (paper filing?) — skipped`);
          continue;
        }
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          result.notes.push(`HTTP ${response.status} for ${pdfUrl}`);
          yearComplete = false;
          break;
        }
        const pdfBytes = new Uint8Array(await response.arrayBuffer());

        let parsedPtr;
        try {
          const items = await houseClerkDeps.extractPositionedText(pdfBytes);
          if (items.length === 0) {
            // No text layer: a scanned paper filing. Recorded as pending
            // rather than inventing rows (scan extraction is a separate,
            // 0.7-confidence path that does not exist yet).
            result.notes.push(`no text layer in ${filing.docId} — scan extraction pending`);
            continue;
          }
          parsedPtr = parsePtrItems({
            items,
            docId: filing.docId,
            filedAt: filing.filingDate,
            member: resolveMember(members, filing),
            sourceUrl: pdfUrl,
            retrievedAt: isoNow(),
          });
        } catch (error) {
          result.parse.attempted += 1;
          logger.warn(`extraction failed for ${filing.docId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (parsedPtr.headerSignature === null) {
          result.parse.attempted += 1;
          result.notes.push(`no transactions table found in ${filing.docId}`);
          continue;
        }
        await ctx.store.setFingerprint(
          "house-clerk",
          HEADER_FINGERPRINT_KEY,
          fingerprintHash(parsedPtr.headerSignature),
        );
        result.parse.attempted += parsedPtr.stats.attempted;
        result.parse.succeeded += parsedPtr.stats.succeeded;
        if (parsedPtr.rows.length > 0) {
          const { rows } = await ctx.store.upsert(DATASETS["congress-trades"], parsedPtr.rows);
          result.rowsUpserted += rows;
          result.perDataset["congress-trades"] = (result.perDataset["congress-trades"] ?? 0) + rows;
        }
        logger.info(`${filing.docId} (${filing.filingDate}): ${parsedPtr.rows.length} rows`);
        if (maxFiled === null || filing.filingDate > maxFiled) maxFiled = filing.filingDate;
      }

      if (yearComplete && (index.etag || index.lastModified)) {
        // Persisted only after the whole window processed, so a partial walk
        // can never be skipped by a later 304.
        await ctx.store.setFetchCache(houseClerkYearIndexUrl(year), {
          etag: index.etag,
          lastModified: index.lastModified,
        });
      }
      if (!yearComplete) break;
    }

    if (limitStopped) {
      result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
    } else if (maxFiled !== null && (watermark === null || maxFiled > watermark)) {
      await ctx.store.setWatermark("house-clerk", WATERMARK_KEY, maxFiled);
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const politeFetch = buildFetch(ctx);
    const currentYear = Number(toDateString(now).slice(0, 4));

    let filings: HouseIndexFiling[] | null = null;
    try {
      let indexYear = currentYear;
      let index = await fetchYearIndex(politeFetch, ctx.store, indexYear, { conditional: false });
      if (index.status === "not-found") {
        // Early January: the new year's index may not exist yet.
        indexYear = currentYear - 1;
        index = await fetchYearIndex(politeFetch, ctx.store, indexYear, { conditional: false });
      }
      if (index.status !== "ok") {
        throw new Error(`no index ZIP published for ${currentYear} or ${currentYear - 1}`);
      }
      const parsed = parseYearIndexXml(index.xml);
      filings = parsed.filings;
      checks.push({
        name: "fetch-year-index",
        ok: parsed.filings.length > 0,
        severity: "hard",
        note: `${indexYear}FD.xml: ${parsed.filings.length} filings`,
      });

      const hash = fingerprintHash(parsed.fieldSignature);
      const stored = await ctx.store.getFingerprint("house-clerk", INDEX_FINGERPRINT_KEY);
      if (stored === null) {
        await ctx.store.setFingerprint("house-clerk", INDEX_FINGERPRINT_KEY, hash);
        checks.push({
          name: "index-fingerprint",
          ok: true,
          severity: "hard",
          note: "baseline recorded",
        });
      } else {
        checks.push({
          name: "index-fingerprint",
          ok: stored === hash,
          severity: "hard",
          note: stored === hash ? undefined : "index XML field set changed",
        });
      }
    } catch (error) {
      checks.push({
        name: "fetch-year-index",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    if (filings) {
      const ptrs = filings
        .filter((f) => f.filingType === "P")
        .sort(byFiledDateThenDocId)
        .reverse();

      // Probe the newest fetchable PTR PDF for the table-layout fingerprint.
      let probed = false;
      for (const filing of ptrs.slice(0, 3)) {
        try {
          const response = await politeFetch(housePtrPdfUrl(filing.year, filing.docId));
          if (!response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            continue; // paper filing or missing PDF; try the next one
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          const items = await houseClerkDeps.extractPositionedText(bytes);
          if (items.length === 0) continue; // scanned filing; try the next one
          const parsed = parsePtrItems({
            items,
            docId: filing.docId,
            filedAt: filing.filingDate,
            member: { name: memberDisplayName(filing), bioguideId: null, party: null, state: null },
            sourceUrl: housePtrPdfUrl(filing.year, filing.docId),
            retrievedAt: isoNow(),
          });
          probed = true;
          if (parsed.headerSignature === null) {
            checks.push({
              name: "ptr-header-fingerprint",
              ok: false,
              severity: "hard",
              note: `no transactions table found in ${filing.docId}`,
            });
            break;
          }
          const hash = fingerprintHash(parsed.headerSignature);
          const stored = await ctx.store.getFingerprint("house-clerk", HEADER_FINGERPRINT_KEY);
          if (stored === null) {
            await ctx.store.setFingerprint("house-clerk", HEADER_FINGERPRINT_KEY, hash);
            checks.push({
              name: "ptr-header-fingerprint",
              ok: true,
              severity: "hard",
              note: "baseline recorded",
            });
          } else {
            checks.push({
              name: "ptr-header-fingerprint",
              ok: stored === hash,
              severity: "hard",
              note: stored === hash ? undefined : "PTR table header layout changed",
            });
          }
          break;
        } catch (error) {
          probed = true;
          checks.push({
            name: "ptr-header-fingerprint",
            ok: false,
            severity: "hard",
            note: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
      if (!probed && ptrs.length > 0) {
        checks.push({
          name: "ptr-header-fingerprint",
          ok: false,
          severity: "hard",
          note: "none of the 3 newest PTR PDFs had a text layer to fingerprint",
        });
      }

      const latestFiled = ptrs[0]?.filingDate ?? null;
      checks.push({
        name: "ptr-freshness",
        ok: latestFiled !== null && hoursSince(`${latestFiled}T00:00:00Z`, now) <= 72,
        severity: "soft",
        note: latestFiled ? `latest PTR filed ${latestFiled}` : "no PTR filings in the index",
      });
    }

    const lastSync = await ctx.store.latestSyncRun("house-clerk");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} rows`,
      });
    }

    return { checks };
  },
};
