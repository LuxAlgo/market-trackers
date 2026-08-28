import { describe, expect, it } from "vitest";
import {
  GovinfoHearingsDriftError,
  chrgSitemapIndexUrl,
  chrgYearSitemapUrl,
  hearingDetailsUrl,
  hearingModsUrl,
  parseSitemapIndex,
  parseYearSitemap,
} from "./client.js";
import { readFixture } from "../../test-helpers.js";

const CASE = ["govinfo-hearings", "case-chrg-sitemap-and-mods"];

describe("URL builders", () => {
  it("builds the sitemap, mods, and details URLs", () => {
    expect(chrgSitemapIndexUrl()).toBe("https://www.govinfo.gov/sitemap/CHRG_sitemap_index.xml");
    expect(chrgYearSitemapUrl(2026)).toBe("https://www.govinfo.gov/sitemap/CHRG_2026_sitemap.xml");
    expect(hearingModsUrl("CHRG-118hhrg52977")).toBe(
      "https://www.govinfo.gov/metadata/pkg/CHRG-118hhrg52977/mods.xml",
    );
    expect(hearingDetailsUrl("CHRG-118hhrg52977")).toBe(
      "https://www.govinfo.gov/app/details/CHRG-118hhrg52977",
    );
  });
});

describe("parseSitemapIndex", () => {
  it("extracts year entries with canonical lastmods and skips non-CHRG locs silently", () => {
    const entries = parseSitemapIndex(readFixture(...CASE, "sitemap-index.xml"), "index-url");
    expect(entries).toEqual([
      {
        year: 2025,
        sitemapUrl: "https://www.govinfo.gov/sitemap/CHRG_2025_sitemap.xml",
        lastmod: "2026-08-23T18:01:00.111Z",
      },
      {
        year: 2026,
        sitemapUrl: "https://www.govinfo.gov/sitemap/CHRG_2026_sitemap.xml",
        lastmod: "2026-08-24T06:00:00.000Z",
      },
    ]);
  });

  it("reads a missing <lastmod> as null rather than dropping the year", () => {
    const xml =
      `<sitemapindex><sitemap>` +
      `<loc>https://www.govinfo.gov/sitemap/CHRG_1999_sitemap.xml</loc>` +
      `</sitemap></sitemapindex>`;
    expect(parseSitemapIndex(xml, "u")).toEqual([
      {
        year: 1999,
        sitemapUrl: "https://www.govinfo.gov/sitemap/CHRG_1999_sitemap.xml",
        lastmod: null,
      },
    ]);
  });

  it("throws GovinfoHearingsDriftError when a 200 index yields zero year sitemaps", () => {
    const noBlocks = `<sitemapindex></sitemapindex>`;
    expect(() => parseSitemapIndex(noBlocks, "u")).toThrow(GovinfoHearingsDriftError);
    // Blocks exist but none extract — same drift, never a silent empty.
    const drifted =
      `<sitemapindex><sitemap><loc>https://www.govinfo.gov/sitemap/RENAMED_2026.xml</loc>` +
      `</sitemap></sitemapindex>`;
    expect(() => parseSitemapIndex(drifted, "u")).toThrow(GovinfoHearingsDriftError);
  });
});

describe("parseYearSitemap", () => {
  it("extracts package ids, dedupes repeats, and collects unrecognized locs", () => {
    const result = parseYearSitemap(readFixture(...CASE, "sitemap-2026.xml"), "u");
    expect(result.packageIds).toEqual([
      "CHRG-119hhrg90001",
      "CHRG-119shrg90002",
      "CHRG-119hhrg99999",
    ]);
    expect(result.unrecognizedLocs).toEqual(["https://www.govinfo.gov/features/some-feature-page"]);
  });

  it("throws GovinfoHearingsDriftError when a 200 urlset yields zero package ids", () => {
    expect(() => parseYearSitemap(`<urlset></urlset>`, "u")).toThrow(GovinfoHearingsDriftError);
    const drifted = `<urlset><url><loc>https://www.govinfo.gov/somewhere/else</loc></url></urlset>`;
    expect(() => parseYearSitemap(drifted, "u")).toThrow(GovinfoHearingsDriftError);
    expect(() => parseYearSitemap(drifted, "u")).toThrow(/somewhere\/else/);
  });

  it("routes a jacketless stub id to unrecognizedLocs instead of the fetch queue", () => {
    // Observed live in the 1997 sitemap: "CHRG-105jhrg" — congress + class
    // but no jacket number; its mods.xml exists but names no package.
    const xml =
      `<urlset>` +
      `<url><loc>https://www.govinfo.gov/app/details/CHRG-105jhrg</loc></url>` +
      `<url><loc>https://www.govinfo.gov/app/details/CHRG-105jhrg55298</loc></url>` +
      `</urlset>`;
    const result = parseYearSitemap(xml, "u");
    expect(result.packageIds).toEqual(["CHRG-105jhrg55298"]);
    expect(result.unrecognizedLocs).toEqual(["https://www.govinfo.gov/app/details/CHRG-105jhrg"]);
  });
});
