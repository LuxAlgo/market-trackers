import type {
  TrackerSource,
  ParseStats,
  SourceContext,
  SourceSyncResult,
  SyncOptions,
} from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import { congressHearingSchema, type CongressHearing } from "../../schema/congress-hearing.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { createGovinfoFetch } from "../govinfo/client.js";
import {
  GovinfoHearingsDriftError,
  fetchSitemapIndex,
  fetchYearSitemap,
  hearingModsUrl,
  type SitemapIndexEntry,
} from "./client.js";
import { HearingModsParseError, parseHearingMods } from "./mods-xml.js";

export {
  GovinfoHearingsDriftError,
  chrgSitemapIndexUrl,
  chrgYearSitemapUrl,
  hearingDetailsUrl,
  hearingModsUrl,
  parseSitemapIndex,
  parseYearSitemap,
} from "./client.js";
export { HearingModsParseError, parseHearingMods, attrValue } from "./mods-xml.js";

/**
 * GPO GovInfo CHRG — congressional hearing transcripts, discovered via the
 * collection's public sitemaps and described per package by mods.xml.
 * Natural key is the package id, so re-walks upsert rather than duplicate.
 *
 * Year selection and watermarking are two different jobs (the same split
 * the govinfo bills source keeps between congress selection and
 * `lastModified`). `--since`/`--until` pick WHICH year sitemaps to walk —
 * the sitemap year approximates the hearing's event year, but a package can
 * surface under its publication year instead, so windows should be drawn
 * generously. A year sitemap's `<lastmod>` is only a refresh hint: GPO
 * regenerates old years routinely (a 2015 sitemap can carry today's
 * lastmod), so it powers exactly one thing — skipping a year whose sitemap
 * hasn't been regenerated since the last fully-completed walk — and is
 * never read as a statement about hearing dates.
 *
 * Within a chosen year: fetch the year sitemap, extract package ids, skip
 * ids already in the store (unless `--full` — idempotent upserts make
 * re-walks safe), fetch mods.xml per new id, upsert.
 */

export const GOVINFO_HEARINGS_PARSER = "govinfo-hearings-mods@1";

/**
 * Earliest year worth asking the index about — the CHRG collection's
 * sitemaps reach back to the late 1990s ([verify-live]; years absent from
 * the index are skipped without a request anyway, so this only bounds the
 * loop when `--since` reaches absurdly far back).
 */
export const EARLIEST_CHRG_YEAR = 1995;

/**
 * A year whose walk fetched at least this many mods documents and parsed
 * NONE of them is collection-wide shape drift, not a run of GPO stubs —
 * per-document parse failures are skipped, so this tripwire is what keeps a
 * broken MODS reading from silently "completing" whole years with 0 rows.
 */
export const ZERO_PARSE_TRIPWIRE = 10;

function watermarkKey(year: number): string {
  return `sitemap.${year}.lastmod`;
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  // Same host, same politeness as the govinfo bills source (5 req/s).
  return createGovinfoFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("govinfo-hearings"),
  });
}

/**
 * Years `sync` walks this run. With no `--since` there is no window to map,
 * so the daily default walks the current year plus the previous one — GPO
 * publishes transcripts months after the hearing, so late-year hearings keep
 * landing in the next calendar year's runs. `--since` selects a year RANGE
 * through `--until` (or today), clamped to `[EARLIEST_CHRG_YEAR, currentYear]`.
 */
export function yearsToWalk(opts: SyncOptions, now: Date): number[] {
  const currentYear = now.getUTCFullYear();
  if (!opts.since) return [currentYear - 1, currentYear];
  const from = Math.max(EARLIEST_CHRG_YEAR, Number(opts.since.slice(0, 4)));
  const untilYear = Number((opts.until ?? toDateString(now)).slice(0, 4));
  const to = Math.min(Number.isInteger(untilYear) ? untilYear : currentYear, currentYear);
  const years: number[] = [];
  for (let year = from; year <= to; year++) years.push(year);
  return years;
}

/** Parses one package's mods.xml and builds the full, schema-validated row. */
export function normalizeHearingMods(
  xml: string,
  packageId: string,
  retrievedAt: string,
): CongressHearing {
  const fields = parseHearingMods(xml, packageId);
  return congressHearingSchema.parse({
    id: fields.packageId,
    packageId: fields.packageId,
    title: fields.title,
    chamber: fields.chamber,
    docClass: fields.docClass,
    congress: fields.congress,
    session: fields.session,
    heldDate: fields.heldDate,
    citation: fields.citation,
    committees: fields.committees,
    witnesses: fields.witnesses,
    memberBioguideIds: fields.memberBioguideIds,
    detailUrl: fields.detailUrl,
    htmlUrl: fields.htmlUrl,
    pdfUrl: fields.pdfUrl,
    provenance: {
      source: "govinfo-hearings",
      sourceUrl: hearingModsUrl(fields.packageId),
      retrievedAt,
      parser: GOVINFO_HEARINGS_PARSER,
      confidence: 1,
      needsReview: false,
    },
  } satisfies CongressHearing);
}

interface YearWalkOutcome {
  rowsUpserted: number;
  parse: ParseStats;
  /** mods.xml documents actually fetched — what the shared `--limit` budget counts against. */
  processed: number;
  notes: string[];
}

/**
 * Walks one year: fetch its sitemap, diff the package ids against the store
 * (all ids on `--full`), fetch+normalize each new package, continuing past a
 * single document's failure (skip-and-count) since packages are independent.
 * The year's watermark — the sitemap `<lastmod>` the index reported — is
 * recorded only when every candidate was fetched and `--limit` was never
 * hit, so the next run re-diffs a year whose walk didn't finish.
 */
async function syncYear(
  ctx: SourceContext,
  opts: SyncOptions,
  politeFetch: PoliteFetch,
  indexEntry: SitemapIndexEntry,
  retrievedAt: string,
  budget: number,
): Promise<YearWalkOutcome> {
  const logger = ctx.logger.child("govinfo-hearings");
  const year = indexEntry.year;
  const out: YearWalkOutcome = {
    rowsUpserted: 0,
    parse: { attempted: 0, succeeded: 0 },
    processed: 0,
    notes: [],
  };
  if (budget <= 0) return out;

  // The lastmod skip: a year fully walked at this exact sitemap generation
  // has nothing new — skip even the sitemap fetch. Any lastmod change (or a
  // missing lastmod, or --full) walks the year; the id diff below keeps that
  // walk cheap.
  const stored = opts.full
    ? null
    : await ctx.store.getWatermark("govinfo-hearings", watermarkKey(year));
  if (stored !== null && indexEntry.lastmod !== null && stored === indexEntry.lastmod) {
    logger.debug(`${year}: sitemap unchanged since last completed walk — skipped`);
    return out;
  }

  let packageIds: string[];
  try {
    const sitemap = await fetchYearSitemap(politeFetch, year);
    packageIds = sitemap.packageIds;
    for (const loc of sitemap.unrecognizedLocs) {
      logger.warn(`unrecognized loc in CHRG ${year} sitemap`, { loc });
    }
  } catch (error) {
    if (error instanceof HttpError) {
      out.notes.push(`${year}: ${error.message}`);
      return out;
    }
    throw error;
  }

  const existing = opts.full
    ? new Set<string>()
    : await ctx.store.existingIds("congress-hearings", packageIds);
  const candidates = packageIds.filter((id) => !existing.has(id));
  let complete = true;

  for (const packageId of candidates) {
    if (out.processed >= budget) {
      out.notes.push(`${year}: stopped at --limit ${opts.limit}; watermark not advanced`);
      complete = false;
      break;
    }
    out.processed += 1;
    out.parse.attempted += 1;
    const modsUrl = hearingModsUrl(packageId);
    try {
      const response = await politeFetch(modsUrl);
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new HttpError(modsUrl, response.status);
      }
      const hearing = normalizeHearingMods(await response.text(), packageId, retrievedAt);
      const { rows } = await ctx.store.upsert(DATASETS["congress-hearings"], [hearing]);
      out.rowsUpserted += rows;
      out.parse.succeeded += 1;
    } catch (error) {
      if (error instanceof HttpError) {
        // An unfetched package must be retried next run: it stays missing
        // from the store, so the diff re-selects it, and the watermark
        // below stays put.
        complete = false;
        logger.warn(`${packageId} failed`, {
          year,
          error: error.message,
        });
        continue;
      }
      if (error instanceof HearingModsParseError) {
        // A document GPO serves but that doesn't parse is (in every case
        // observed live) PERMANENTLY malformed — a stub like CHRG-105jhrg,
        // not a transient fault. Holding the year's watermark for it would
        // re-walk and re-fail the same document on every run forever, so it
        // is skipped with a note and the year may still complete; the next
        // sitemap regeneration re-selects it anyway (it stays missing from
        // the store), so a later GPO fix is still picked up.
        out.notes.push(`${year}: ${packageId} skipped — ${error.message}`);
        logger.warn(`${packageId} unparseable — skipped`, {
          year,
          error: error.message,
        });
        continue;
      }
      throw error; // drift and anything unexpected fail the run loudly
    }
  }

  // The per-document skip above must never be able to mask collection-wide
  // drift: a year where documents were fetched and NONE parsed means the
  // MODS shape (or our reading of it) broke, not that GPO published a year
  // of stubs.
  if (out.parse.attempted >= ZERO_PARSE_TRIPWIRE && out.parse.succeeded === 0) {
    throw new GovinfoHearingsDriftError(
      `${year}: ${out.parse.attempted} mods documents fetched, zero parsed — MODS shape drifted`,
    );
  }

  if (complete && indexEntry.lastmod !== null) {
    const existingMark = await ctx.store.getWatermark("govinfo-hearings", watermarkKey(year));
    if (existingMark === null || indexEntry.lastmod > existingMark) {
      await ctx.store.setWatermark("govinfo-hearings", watermarkKey(year), indexEntry.lastmod);
    }
  }

  return out;
}

export const govinfoHearingsSource: TrackerSource = {
  id: "govinfo-hearings",
  title: "GovInfo CHRG (hearing transcripts)",
  datasets: ["congress-hearings"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const result = emptySyncResult("govinfo-hearings", true);
    if (opts.datasets && !opts.datasets.includes("congress-hearings")) return result;

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const retrievedAt = now.toISOString();

    let index: SitemapIndexEntry[];
    try {
      index = await fetchSitemapIndex(politeFetch);
    } catch (error) {
      if (error instanceof HttpError) {
        // Transport failure on the index: nothing can be walked this run.
        // The canary is the loud channel for outages; shape drift (a 200
        // index yielding zero year sitemaps) still throws past this.
        result.notes.push(error.message);
        return result;
      }
      throw error;
    }
    const indexByYear = new Map(index.map((entry) => [entry.year, entry]));

    // --limit is a soft cap on mods.xml documents fetched this run, shared
    // across every year walked (not multiplied per year) — years are walked
    // oldest-first and each spends from what's left.
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let totalProcessed = 0;

    for (const year of yearsToWalk(opts, now)) {
      if (totalProcessed >= limit) {
        // The budget ran out exactly at a year boundary: no mid-year walk
        // pushed a "--limit" note, but later years are still unwalked — say
        // so, since the backfill engine reads that note as "stop, resume here".
        result.notes.push(`stopped at --limit ${opts.limit} before ${year}`);
        break;
      }
      const indexEntry = indexByYear.get(year);
      if (!indexEntry) {
        result.notes.push(`${year}: not listed in the CHRG sitemap index`);
        continue;
      }
      const budget = Number.isFinite(limit) ? limit - totalProcessed : Number.POSITIVE_INFINITY;
      const outcome = await syncYear(ctx, opts, politeFetch, indexEntry, retrievedAt, budget);

      totalProcessed += outcome.processed;
      result.rowsUpserted += outcome.rowsUpserted;
      result.parse.attempted += outcome.parse.attempted;
      result.parse.succeeded += outcome.parse.succeeded;
      if (outcome.rowsUpserted > 0) {
        result.perDataset["congress-hearings"] =
          (result.perDataset["congress-hearings"] ?? 0) + outcome.rowsUpserted;
      }
      result.notes.push(...outcome.notes);
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const politeFetch = buildFetch(ctx);

    try {
      const index = await fetchSitemapIndex(politeFetch);
      checks.push({
        name: "probe-sitemap-index",
        ok: index.length > 0,
        severity: "hard",
        note: `${index.length} year sitemap(s) listed`,
      });
    } catch (error) {
      checks.push({
        name: "probe-sitemap-index",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // Fetching and parsing a live mods.xml on every canary run would spend a
    // request on a metric the last sync already measured — reuse that run's
    // stats instead, the same pattern the govinfo bills source uses.
    const lastSync = await ctx.store.latestSyncRun("govinfo-hearings");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} documents (last sync)`,
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("congress-hearings");
    checks.push({
      name: "freshness-congress-hearings",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["congress-hearings"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
