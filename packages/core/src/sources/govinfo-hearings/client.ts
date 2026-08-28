import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { GOVINFO_BASE, toIsoInstant } from "../govinfo/client.js";
import { extractAllBlocks, extractTag } from "../govinfo/xml.js";

/**
 * GPO GovInfo CHRG (congressional hearings) discovery client — free and
 * keyless, no API key ever. Discovery is sitemap-driven: one sitemap index
 * for the whole collection, one standard `urlset` sitemap per year whose
 * `<loc>` entries point at package details pages, and one MODS metadata
 * document per package (`mods-xml.ts` parses those).
 *
 * Everything about the live shapes this module assumes is listed under
 * `[verify-live]` in docs/sources/govinfo-hearings.md. Sitemaps are a fixed
 * public standard (sitemapindex/urlset), so there is no field-name
 * fingerprint here the way JSON-listing sources keep one — a sitemap that
 * stops yielding locs fails loudly via `GovinfoHearingsDriftError` instead.
 */

export function chrgSitemapIndexUrl(): string {
  return `${GOVINFO_BASE}/sitemap/CHRG_sitemap_index.xml`;
}

export function chrgYearSitemapUrl(year: number): string {
  return `${GOVINFO_BASE}/sitemap/CHRG_${year}_sitemap.xml`;
}

/** The package's MODS metadata document — also every row's `provenance.sourceUrl`. */
export function hearingModsUrl(packageId: string): string {
  return `${GOVINFO_BASE}/metadata/pkg/${packageId}/mods.xml`;
}

/** The human-facing package details page (also carried in the MODS `Content Detail` url). */
export function hearingDetailsUrl(packageId: string): string {
  return `${GOVINFO_BASE}/app/details/${packageId}`;
}

/**
 * A 200 sitemap (index or per-year) that yields zero usable locs — the live
 * shape has moved out from under this module's assumptions. Deliberately NOT
 * an `HttpError`: the sync loop downgrades only `HttpError` to a note, so
 * this propagates and fails the run loudly rather than resolving as a quiet
 * zero-row success (same pattern as `GovinfoListingDriftError`).
 */
export class GovinfoHearingsDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovinfoHearingsDriftError";
  }
}

export interface SitemapIndexEntry {
  year: number;
  sitemapUrl: string;
  /** Canonical ISO-8601 instant of the year sitemap's `<lastmod>`, or null when absent/unparseable. */
  lastmod: string | null;
}

const YEAR_SITEMAP_RE = /CHRG_(\d{4})_sitemap\.xml$/;

/**
 * Parses the CHRG sitemap index (standard `sitemapindex` XML): one
 * `<sitemap>` per year, its `<loc>` naming `CHRG_{year}_sitemap.xml` and its
 * `<lastmod>` a refresh hint. The lastmod says when GPO REGENERATED that
 * year's sitemap, not anything about hearing dates — old years get
 * regenerated routinely (same lesson as BILLSTATUS `lastModified`).
 */
export function parseSitemapIndex(xml: string, url: string): SitemapIndexEntry[] {
  const blocks = extractAllBlocks(xml, "sitemap");
  const entries: SitemapIndexEntry[] = [];
  for (const block of blocks) {
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    const year = Number(YEAR_SITEMAP_RE.exec(loc)?.[1]);
    if (!Number.isInteger(year)) continue;
    entries.push({
      year,
      sitemapUrl: loc,
      lastmod: toIsoInstant(extractTag(block, "lastmod")),
    });
  }
  // A 200 index that names no per-year sitemaps at all is never legitimate —
  // the collection has decades of them. Zero entries means the index shape
  // (or the loc naming convention) drifted, and must fail loudly.
  if (entries.length === 0) {
    throw new GovinfoHearingsDriftError(
      `${url}: ${blocks.length} <sitemap> block(s) but zero CHRG year sitemaps extracted`,
    );
  }
  return entries;
}

export interface YearSitemapResult {
  packageIds: string[];
  /** `<loc>` values that didn't resolve to a CHRG package id — the caller logs these. */
  unrecognizedLocs: string[];
}

/**
 * ".../app/details/CHRG-118hhrg52977" → "CHRG-118hhrg52977" (the last path
 * segment). The jacket digits after the doc-class letters are REQUIRED: GPO
 * sitemaps carry the occasional stub entry without them (observed live:
 * "CHRG-105jhrg" in the 1997 sitemap) whose mods.xml exists but names no
 * package metadata — stubs belong in unrecognizedLocs, not the fetch queue.
 */
const PACKAGE_LOC_RE = /\/app\/details\/(CHRG-\d+[a-z]+\d+[A-Za-z0-9.-]*)\/?$/i;

/**
 * Parses one year's `urlset` sitemap into package ids. Every `<url>` block's
 * `<loc>` is expected to point at a package details page; locs that don't
 * are collected (not dropped silently) so the sync can log them. A 200
 * urlset with zero extractable package ids is drift, never emptiness — a
 * year with no packages has no sitemap at all (the fetch 404s instead).
 */
export function parseYearSitemap(xml: string, url: string): YearSitemapResult {
  const blocks = extractAllBlocks(xml, "url");
  const packageIds: string[] = [];
  const unrecognizedLocs: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    const packageId = PACKAGE_LOC_RE.exec(loc)?.[1];
    if (!packageId) {
      unrecognizedLocs.push(loc);
      continue;
    }
    if (seen.has(packageId)) continue;
    seen.add(packageId);
    packageIds.push(packageId);
  }
  if (packageIds.length === 0) {
    throw new GovinfoHearingsDriftError(
      `${url}: ${blocks.length} <url> block(s) but zero package ids extracted` +
        (unrecognizedLocs[0] ? ` — first loc: ${unrecognizedLocs[0]}` : ""),
    );
  }
  return { packageIds, unrecognizedLocs };
}

export async function fetchSitemapIndex(politeFetch: PoliteFetch): Promise<SitemapIndexEntry[]> {
  const url = chrgSitemapIndexUrl();
  const response = await politeFetch(url);
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  return parseSitemapIndex(await response.text(), url);
}

/**
 * Fetches one year's sitemap. A 404 reads as "GPO publishes no sitemap for
 * this year" (nothing to walk), not an error; any other non-2xx throws
 * `HttpError`. In the index-driven sync this is only ever called for years
 * the index actually lists, so a 404 here is rare but harmless.
 */
export async function fetchYearSitemap(
  politeFetch: PoliteFetch,
  year: number,
): Promise<YearSitemapResult> {
  const url = chrgYearSitemapUrl(year);
  const response = await politeFetch(url);
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    return { packageIds: [], unrecognizedLocs: [] };
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  return parseYearSitemap(await response.text(), url);
}
