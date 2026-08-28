import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import {
  fedCommunicationSchema,
  type FedCommunication,
  type FedCommunicationType,
} from "../../schema/fed-communication.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { hoursSince } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import {
  FED_PRESS_FEED_URL,
  FED_SPEECHES_FEED_URL,
  FED_TESTIMONY_FEED_URL,
  MONETARY_POLICY_CATEGORY,
  classifyMonetaryPolicyTitle,
  createFederalReserveFetch,
  fedAbsoluteUrl,
  fedDateToIso,
  fedFeedItemSchema,
  fedItemFingerprint,
  fedItemIdFromLink,
  fetchFedFeed,
} from "./client.js";

export {
  FEDERALRESERVE_BASE,
  FED_PRESS_FEED_URL,
  FED_SPEECHES_FEED_URL,
  FED_TESTIMONY_FEED_URL,
  MONETARY_POLICY_CATEGORY,
  FederalReserveFeedDriftError,
  classifyMonetaryPolicyTitle,
  fedAbsoluteUrl,
  fedDateToIso,
  fedItemFingerprint,
  fedItemIdFromLink,
  stripBom,
} from "./client.js";

/**
 * Federal Reserve Board monetary-policy communications, from the Board's
 * three public news-events JSON feeds: speeches, congressional testimony,
 * and Monetary Policy press releases (FOMC statements, minutes
 * availability, implementation notes). The feeds are small whole-history
 * files, so every sync fetches all three and upserts everything — the
 * natural key (the link path) makes that idempotent, and `--since`/`--until`
 * are ignored for fetching (there is nothing narrower to fetch). Coverage
 * IS the feed content: how far back each feed reaches is not documented by
 * the Board, so this source never pretends to a deeper archive
 * ([verify-live] in docs/sources/federalreserve.md).
 *
 * Press releases outside the Monetary Policy category (enforcement actions,
 * banking-application orders, …) are out of scope for this dataset and are
 * filtered out at ingestion.
 */

export const FEDERALRESERVE_PARSER = "federalreserve-json@1";

/** Informational: the newest item date seen across all three feeds. */
const WATERMARK_KEY = "feeds.latestItemDate";
const FINGERPRINT_KEY = "press.item-fields";
/** A live feed carries hundreds of entries; fewer than this is worth an operator's glance. */
export const FEED_SHORT_THRESHOLD = 50;

interface FeedSpec {
  url: string;
  label: string;
  /** null → per-item mapping (the press feed classifies by category + title). */
  type: "speech" | "testimony" | null;
}

const FEEDS: FeedSpec[] = [
  { url: FED_SPEECHES_FEED_URL, label: "ne-speeches.json", type: "speech" },
  { url: FED_TESTIMONY_FEED_URL, label: "ne-testimony.json", type: "testimony" },
  { url: FED_PRESS_FEED_URL, label: "ne-press.json", type: null },
];

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createFederalReserveFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("federalreserve"),
  });
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalizes one raw feed item into a `FedCommunication`, or returns null
 * for a press item outside the Monetary Policy category (out of scope, not
 * a failure). A malformed item (no usable date, title, or link) throws —
 * one skip-and-count parse failure, never a partial row.
 */
export function normalizeFedItem(
  raw: Record<string, unknown>,
  feedType: "speech" | "testimony" | null,
  feedUrl: string,
  retrievedAt: string,
): FedCommunication | null {
  const item = fedFeedItemSchema.parse(raw);

  let type: FedCommunicationType;
  if (feedType === null) {
    if (item.pt !== MONETARY_POLICY_CATEGORY) return null;
    type = classifyMonetaryPolicyTitle(item.t ?? "");
  } else {
    type = feedType;
  }

  const date = fedDateToIso(item.d);
  if (!date) throw new Error(`unusable d '${String(item.d ?? "")}'`);
  const title = nonEmpty(item.t);
  if (!title) throw new Error(`${date}: missing t (title)`);
  const link = nonEmpty(item.l);
  const id = fedItemIdFromLink(link);
  if (!link || !id) throw new Error(`${date}: unusable l (link) '${String(item.l ?? "")}'`);

  const video = nonEmpty(item.v);

  return fedCommunicationSchema.parse({
    id,
    type,
    date,
    title,
    // The press feed carries no speaker; a blank s on any feed reads as null.
    speaker: nonEmpty(item.s),
    venue: nonEmpty(item.lo),
    url: fedAbsoluteUrl(link),
    videoUrl: video ? fedAbsoluteUrl(video) : null,
    note: nonEmpty(item.a),
    provenance: {
      source: "federalreserve",
      sourceUrl: feedUrl,
      retrievedAt,
      parser: FEDERALRESERVE_PARSER,
      confidence: 1,
      needsReview: false,
    },
  } satisfies FedCommunication);
}

export const federalreserveSource: TrackerSource = {
  id: "federalreserve",
  title: "Federal Reserve Board (monetary-policy communications)",
  datasets: ["fed-communications"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("federalreserve");
    const result = emptySyncResult("federalreserve", true);
    if (opts.datasets && !opts.datasets.includes("fed-communications")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const retrievedAt = now.toISOString();

    // --limit caps items normalized this run, shared across the three feeds
    // (the same row-level reading cftc gives it). since/until are ignored:
    // the feeds are whole-history files, so there is nothing narrower to
    // fetch and every run is already the full pass.
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let maxItemDate: string | null = null;
    let fingerprinted = false;
    let complete = true;
    let limitNoted = false;
    const noteLimit = () => {
      if (!limitNoted) {
        result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        limitNoted = true;
      }
      complete = false;
    };

    for (const feed of FEEDS) {
      if (processed >= limit) {
        noteLimit();
        break;
      }

      let items: Record<string, unknown>[];
      try {
        items = await fetchFedFeed(politeFetch, feed.url);
      } catch (error) {
        if (error instanceof HttpError) {
          // Transport failure: note it, keep the other feeds' progress.
          result.notes.push(error.message);
          complete = false;
          continue;
        }
        throw error; // feed-shape drift fails the run loudly
      }

      if (feed.url === FED_PRESS_FEED_URL && !fingerprinted && items[0]) {
        await ctx.store.setFingerprint(
          "federalreserve",
          FINGERPRINT_KEY,
          fedItemFingerprint(items[0]),
        );
        fingerprinted = true;
      }
      if (items.length < FEED_SHORT_THRESHOLD) {
        result.notes.push(
          `${feed.label}: only ${items.length} entr${items.length === 1 ? "y" : "ies"} — feed may have shortened`,
        );
      }

      const rows: FedCommunication[] = [];
      let outOfScope = 0;
      for (const raw of items) {
        if (processed >= limit) {
          noteLimit();
          break;
        }
        processed += 1;
        result.parse.attempted += 1;
        try {
          const row = normalizeFedItem(raw, feed.type, feed.url, retrievedAt);
          result.parse.succeeded += 1;
          if (row === null) {
            outOfScope += 1; // non-Monetary-Policy press item: parsed fine, out of scope
            continue;
          }
          rows.push(row);
          if (maxItemDate === null || row.date > maxItemDate) maxItemDate = row.date;
        } catch (error) {
          complete = false;
          logger.warn(`${feed.label}: item failed to normalize`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (rows.length > 0) {
        const { rows: upserted } = await ctx.store.upsert(DATASETS["fed-communications"], rows);
        result.rowsUpserted += upserted;
        result.perDataset["fed-communications"] =
          (result.perDataset["fed-communications"] ?? 0) + upserted;
      }
      logger.info(
        `${feed.label}: ${rows.length} rows upserted` +
          (outOfScope > 0 ? ` (${outOfScope} non-Monetary-Policy items out of scope)` : ""),
      );
    }

    // Informational watermark: the newest communication date seen. Never a
    // fetch filter (every run re-reads the whole feeds); only advanced by a
    // complete pass so it can't record a date a partial run half-saw.
    if (complete && maxItemDate !== null) {
      const existing = await ctx.store.getWatermark("federalreserve", WATERMARK_KEY);
      if (existing === null || maxItemDate > existing) {
        await ctx.store.setWatermark("federalreserve", WATERMARK_KEY, maxItemDate);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const politeFetch = buildFetch(ctx);

    try {
      const items = await fetchFedFeed(politeFetch, FED_PRESS_FEED_URL);
      const monetaryPolicy = items.filter(
        (raw) => (raw as { pt?: unknown }).pt === MONETARY_POLICY_CATEGORY,
      );
      checks.push({
        name: "probe-press-feed",
        ok: items.length > 0 && monetaryPolicy.length > 0,
        severity: "hard",
        note: `${items.length} item(s), ${monetaryPolicy.length} in '${MONETARY_POLICY_CATEGORY}'`,
      });

      const first = items[0];
      if (first) {
        const hash = fedItemFingerprint(first);
        const stored = await ctx.store.getFingerprint("federalreserve", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("federalreserve", FINGERPRINT_KEY, hash);
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
            note: stored === hash ? undefined : "press-feed item field names changed",
          });
        }

        let succeeded = 0;
        for (const raw of monetaryPolicy) {
          try {
            normalizeFedItem(raw, null, FED_PRESS_FEED_URL, now.toISOString());
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        if (monetaryPolicy.length > 0) {
          const rate = succeeded / monetaryPolicy.length;
          checks.push({
            name: "parse-success-rate",
            ok: rate >= 0.99,
            severity: "hard",
            note: `${succeeded}/${monetaryPolicy.length} probe items`,
          });
        }
      }
    } catch (error) {
      checks.push({
        name: "probe-press-feed",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("fed-communications");
    checks.push({
      name: "freshness-fed-communications",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["fed-communications"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
