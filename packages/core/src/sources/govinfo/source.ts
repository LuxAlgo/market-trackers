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
import { hoursSince, toDateString } from "../../lib/dates.js";
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
  type ListingResult,
} from "./client.js";
import { parseBillStatusXml } from "./bill-xml.js";

export {
  BILL_TYPES,
  CONGRESS_GOV_BASE,
  GOVINFO_BASE,
  GovinfoListingDriftError,
  billstatusListingUrl,
  billstatusXmlUrl,
  congressBillPageUrl,
  ordinal,
} from "./client.js";

/**
 * GPO GovInfo bulk BILLSTATUS — federal bill/resolution status records,
 * walked per (congress, bill type) directory. Natural key is `billId()`
 * (congress-type-number), so re-ingesting a revised bill upserts rather
 * than duplicates. Each (congress, bill type) pair keeps its own watermark
 * (the max file `lastModified` ingested) so one lagging or erroring type
 * never masks another — the same independence usaspending keeps between
 * its two award universes.
 *
 * Congress selection and watermarking are two different jobs fed by two
 * different signals. `--since`/`--until` (a calendar window) pick WHICH
 * congress directories `sync` walks — the only way to reach a historical
 * congress, since GovInfo's directories are keyed by congress, not by
 * date. Once inside a chosen congress, a file's `lastModified` powers ONLY
 * that (congress, type)'s incremental watermark; it never filters which
 * files a walk of that congress fetches. That split is deliberate: GPO
 * regenerates old congresses' files (a 113th-congress file can carry a
 * 2024 `lastModified`), so a modification date says nothing about when the
 * underlying legislative event happened, and filtering candidates by it
 * would silently and permanently exclude real backfill data.
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

/**
 * Congress in session on a given calendar date — same formula as
 * `currentCongress`, from the year alone. This deliberately approximates
 * the Jan-3 start-of-term boundary in a congress's first (odd) year: it
 * only picks which congress-directory chunks a backfill walks, adjacent
 * congresses are adjacent chunks, and every upsert is idempotent, so an
 * off-by-one there costs nothing.
 */
export function congressForDate(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  return Math.floor((year - 1789) / 2) + 1;
}

function watermarkKey(congress: number, billType: string): string {
  return `billstatus.${congress}.${billType}.lastModified`;
}

/**
 * Congresses `sync` walks this run. `--since` selects a congress RANGE:
 * every congress from the 108th (2003, BILLSTATUS's earliest coverage)
 * through `--until` (or today), clamped to the congress actually in
 * session, because GovInfo's directories are keyed by congress rather than
 * date and a file's `lastModified` can't stand in for one (see the module
 * docblock). With no `--since` there is no window to map, so this walks
 * only the current congress — daily `sync`'s behavior is unchanged.
 */
function congressesToWalk(opts: SyncOptions, now: Date): number[] {
  if (!opts.since) return [currentCongress(now)];
  const from = Math.max(108, congressForDate(opts.since));
  const to = Math.min(congressForDate(opts.until ?? toDateString(now)), currentCongress(now));
  const congresses: number[] = [];
  for (let congress = from; congress <= to; congress++) congresses.push(congress);
  return congresses;
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
 * Walks one (congress, bill type) directory: lists it, filters to files
 * newer than the stored watermark (or everything, on a type's first-ever
 * walk or `--full`), and fetches+normalizes each candidate, continuing
 * past a single file's failure (skip-and-count) since files are
 * independent — unlike paginated APIs, one bad file never blocks the rest.
 * `--since`/`--until` play no part in this function: by the time a
 * congress reaches here the caller has already decided to walk it in
 * full (see `congressesToWalk` and the module docblock) — a file's
 * `lastModified` is never a date-window filter, only the watermark input.
 * The watermark only advances when every candidate was fetched (regardless
 * of whether it parsed) and `--limit` was never hit.
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

  // The only gate: the per-(congress, type) watermark, an exclusive floor
  // (it's the max already-ingested lastModified). No watermark — this
  // type's first walk, or --full — fetches everything the listing names.
  const watermark = opts.full
    ? null
    : await ctx.store.getWatermark("govinfo", watermarkKey(congress, billType));

  const candidates = listing.entries
    .filter((entry) => watermark === null || entry.lastModified > watermark)
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
    const congresses = congressesToWalk(opts, now);

    // --limit is a soft cap on bill XML files fetched this run, shared
    // across every congress walked and all 8 bill types (not multiplied
    // per congress or per type) — congresses are walked oldest-first, each
    // in BILL_TYPES order, and each spends from what's left.
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let totalProcessed = 0;
    let fingerprinted = false;

    for (const congress of congresses) {
      if (totalProcessed >= limit) break;
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
        // Mid-congress, a genuinely empty hr directory is always wrong —
        // a listing that fetches fine but names zero files must fail this
        // check regardless of whether `sync` itself throws on it.
        ok: listing.entries.length > 0,
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
