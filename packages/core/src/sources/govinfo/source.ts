import type {
  AltDataSource,
  ParseStats,
  SourceContext,
  SourceSyncResult,
  SyncOptions,
} from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { billId, billSchema, type Bill } from "../../schema/bill.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { addDays, hoursSince } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import {
  BILL_TYPES,
  billstatusXmlUrl,
  congressBillPageUrl,
  createGovinfoFetch,
  fetchBillstatusListing,
  listingFileFingerprint,
  parseListingFileName,
  type BillType,
  type ListingEntry,
  type ListingResult,
} from "./client.js";
import { parseBillStatusXml } from "./bill-xml.js";

export {
  BILL_TYPES,
  CONGRESS_GOV_BASE,
  GOVINFO_BASE,
  billstatusListingUrl,
  billstatusXmlUrl,
  congressBillPageUrl,
  ordinal,
} from "./client.js";

/**
 * GPO GovInfo bulk BILLSTATUS — federal bill/resolution status records,
 * walked per (current congress, bill type) directory. Natural key is
 * `billId()` (congress-type-number), so re-ingesting a revised bill upserts
 * rather than duplicates. Each of the 8 bill types keeps its own watermark
 * (the max file `lastModified` ingested) so one type lagging or erroring
 * never masks another — the same independence usaspending keeps between
 * its two award universes.
 */

export const GOVINFO_PARSER = "govinfo-billstatus@1";

const LISTING_FINGERPRINT_KEY = "govinfo.listing-fields";
/** Canary probe type — cheap, always populated, and the one named in the brief. */
const CANARY_PROBE_TYPE: BillType = "hr";

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createGovinfoFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("govinfo"),
  });
}

/** Congress in session for a given moment: the 119th runs 2025–2027, etc. */
export function currentCongress(now: Date): number {
  return Math.floor((now.getUTCFullYear() - 1789) / 2) + 1;
}

function watermarkKey(congress: number, billType: string): string {
  return `billstatus.${congress}.${billType}.lastModified`;
}

/** Parses one bill's XML and builds the full, schema-validated `Bill` row. */
export function normalizeBillXml(
  xml: string,
  context: { congress: number; billType: string; billNumber: number },
  retrievedAt: string,
): Bill {
  const fields = parseBillStatusXml(xml, context);
  return billSchema.parse({
    id: billId(fields.congress, fields.billType, fields.billNumber),
    congress: fields.congress,
    billType: fields.billType,
    billNumber: fields.billNumber,
    title: fields.title,
    introducedDate: fields.introducedDate,
    latestActionDate: fields.latestActionDate,
    latestActionText: fields.latestActionText,
    sponsorBioguideId: fields.sponsorBioguideId,
    sponsorName: fields.sponsorName,
    policyArea: fields.policyArea,
    cosponsorCount: fields.cosponsorCount,
    provenance: {
      source: "govinfo",
      sourceUrl: congressBillPageUrl(fields.congress, fields.billType, fields.billNumber),
      retrievedAt,
      parser: GOVINFO_PARSER,
      confidence: 1,
      needsReview: false,
    },
  } satisfies Bill);
}

interface TypeWalkOutcome {
  rowsUpserted: number;
  parse: ParseStats;
  /** Bill XML files actually fetched — what the shared `--limit` budget counts against. */
  processed: number;
  notes: string[];
  /** First raw listing-file row seen, for the shared run-wide fingerprint. */
  sampleRow: Record<string, unknown> | null;
}

/**
 * Walks one (congress, bill type) directory: lists it, filters to files in
 * the requested window, and fetches+normalizes each candidate, continuing
 * past a single file's failure (skip-and-count) since files are
 * independent — unlike paginated APIs, one bad file never blocks the rest.
 * The watermark only advances when every candidate in the window was
 * fetched (regardless of whether it parsed) and `--limit` was never hit.
 */
async function syncBillType(
  ctx: SourceContext,
  opts: SyncOptions,
  politeFetch: PoliteFetch,
  congress: number,
  billType: BillType,
  retrievedAt: string,
  budget: number,
): Promise<TypeWalkOutcome> {
  const logger = ctx.logger.child("govinfo");
  const out: TypeWalkOutcome = {
    rowsUpserted: 0,
    parse: { attempted: 0, succeeded: 0 },
    processed: 0,
    notes: [],
    sampleRow: null,
  };
  if (budget <= 0) return out;

  let listing: ListingResult;
  try {
    listing = await fetchBillstatusListing(politeFetch, congress, billType);
  } catch (error) {
    if (error instanceof HttpError) {
      out.notes.push(`${billType}: ${error.message}`);
      return out;
    }
    throw error;
  }
  out.sampleRow = listing.sampleRow;

  const watermark = opts.full
    ? null
    : await ctx.store.getWatermark("govinfo", watermarkKey(congress, billType));
  // An explicit --since is an inclusive floor that overrides the watermark;
  // otherwise the watermark is an exclusive floor (it's the max already-
  // ingested lastModified) — no watermark and no --since walks everything.
  const sinceFloor = opts.since ? `${opts.since}T00:00:00.000Z` : null;
  // --until is inclusive of the whole day; expressed as an exclusive
  // ceiling at the start of the following day.
  const untilCeiling = opts.until ? `${addDays(opts.until, 1)}T00:00:00.000Z` : null;

  const inWindow = (entry: ListingEntry): boolean => {
    if (sinceFloor !== null) {
      if (entry.lastModified < sinceFloor) return false;
    } else if (watermark !== null) {
      if (entry.lastModified <= watermark) return false;
    }
    if (untilCeiling !== null && entry.lastModified >= untilCeiling) return false;
    return true;
  };

  const candidates = listing.entries
    .filter(inWindow)
    .sort((a, b) =>
      a.lastModified < b.lastModified ? -1 : a.lastModified > b.lastModified ? 1 : 0,
    );

  let maxLastModified: string | null = null;
  let complete = true;

  for (const entry of candidates) {
    if (out.processed >= budget) {
      out.notes.push(`${billType}: stopped at --limit ${opts.limit}; watermark not advanced`);
      complete = false;
      break;
    }
    const parsedName = parseListingFileName(entry.fileName);
    if (!parsedName || parsedName.congress !== congress || parsedName.billType !== billType) {
      logger.warn(
        `unrecognized BILLSTATUS file name '${entry.fileName}' in ${congress}/${billType}`,
        {
          billType,
        },
      );
      continue;
    }

    out.processed += 1;
    out.parse.attempted += 1;
    const xmlUrl = billstatusXmlUrl(congress, billType, parsedName.billNumber);
    try {
      const response = await politeFetch(xmlUrl);
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new HttpError(xmlUrl, response.status);
      }
      const xml = await response.text();
      const bill = normalizeBillXml(
        xml,
        { congress, billType, billNumber: parsedName.billNumber },
        retrievedAt,
      );
      const { rows } = await ctx.store.upsert(DATASETS.bills, [bill]);
      out.rowsUpserted += rows;
      out.parse.succeeded += 1;
      if (maxLastModified === null || entry.lastModified > maxLastModified) {
        maxLastModified = entry.lastModified;
      }
    } catch (error) {
      complete = false; // an unfetched/unparsed file in the window must be retried next time
      logger.warn(`${entry.fileName} failed to parse`, {
        billType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (complete && maxLastModified !== null) {
    const existing = await ctx.store.getWatermark("govinfo", watermarkKey(congress, billType));
    if (existing === null || maxLastModified > existing) {
      await ctx.store.setWatermark("govinfo", watermarkKey(congress, billType), maxLastModified);
    }
  }

  return out;
}

export const govinfoSource: AltDataSource = {
  id: "govinfo",
  title: "GovInfo (bill status)",
  datasets: ["bills"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const result = emptySyncResult("govinfo", true);
    if (opts.datasets && !opts.datasets.includes("bills")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const retrievedAt = now.toISOString();
    const congress = currentCongress(now);

    // --limit is a soft cap on bill XML files fetched this run, shared
    // across all 8 bill types (not multiplied per type) — types are walked
    // in BILL_TYPES order and each spends from what the previous left.
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let totalProcessed = 0;
    let fingerprinted = false;

    for (const billType of BILL_TYPES) {
      if (totalProcessed >= limit) break;
      const budget = Number.isFinite(limit) ? limit - totalProcessed : Number.POSITIVE_INFINITY;
      const outcome = await syncBillType(
        ctx,
        opts,
        politeFetch,
        congress,
        billType,
        retrievedAt,
        budget,
      );

      totalProcessed += outcome.processed;
      result.rowsUpserted += outcome.rowsUpserted;
      result.parse.attempted += outcome.parse.attempted;
      result.parse.succeeded += outcome.parse.succeeded;
      if (outcome.rowsUpserted > 0) {
        result.perDataset.bills = (result.perDataset.bills ?? 0) + outcome.rowsUpserted;
      }
      result.notes.push(...outcome.notes);

      if (!fingerprinted && outcome.sampleRow) {
        await ctx.store.setFingerprint(
          "govinfo",
          LISTING_FINGERPRINT_KEY,
          listingFileFingerprint(outcome.sampleRow),
        );
        fingerprinted = true;
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const congress = currentCongress(now);
    const politeFetch = buildFetch(ctx);

    try {
      const listing = await fetchBillstatusListing(politeFetch, congress, CANARY_PROBE_TYPE);
      checks.push({
        name: "probe-listing",
        ok: true,
        severity: "hard",
        note: `${listing.entries.length} file(s) listed for congress ${congress} type '${CANARY_PROBE_TYPE}'`,
      });

      if (listing.sampleRow) {
        const hash = listingFileFingerprint(listing.sampleRow);
        const stored = await ctx.store.getFingerprint("govinfo", LISTING_FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("govinfo", LISTING_FINGERPRINT_KEY, hash);
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
            note: stored === hash ? undefined : "listing file-entry field names changed",
          });
        }
      }
    } catch (error) {
      checks.push({
        name: "probe-listing",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // Fetching and parsing a live bill XML file on every canary run would
    // cost a real request for a metric the last sync already measured
    // across every type it walked — so this reuses that run's stats
    // instead of re-probing, the same pattern house-clerk/senate-efd/edgar use.
    const lastSync = await ctx.store.latestSyncRun("govinfo");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} files (last sync)`,
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("bills");
    checks.push({
      name: "freshness-bills",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS.bills.freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
