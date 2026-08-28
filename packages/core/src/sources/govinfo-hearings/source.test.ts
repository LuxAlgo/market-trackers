import { describe, expect, it } from "vitest";
import {
  govinfoHearingsSource,
  yearsToWalk,
  chrgSitemapIndexUrl,
  chrgYearSitemapUrl,
  hearingModsUrl,
  GovinfoHearingsDriftError,
} from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { CongressHearing } from "../../schema/congress-hearing.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network, against the 2025+2026 CHRG
 * fixture. 2026 carries one package with an unusable mods.xml (no title), so
 * its year watermark never advances while 2025's does — the same per-unit
 * independence the govinfo bills source keeps per (congress, type).
 */

const NOW = "2026-08-24T12:00:00.000Z";
const CASE = ["govinfo-hearings", "case-chrg-sitemap-and-mods"];

const MODS_FIXTURES: Record<string, string> = {
  "CHRG-119hhrg90001": "CHRG-119hhrg90001-mods.xml",
  "CHRG-119shrg90002": "CHRG-119shrg90002-mods.xml",
  "CHRG-119jhrg80001": "CHRG-119jhrg80001-mods.xml",
  "CHRG-119hhrg99999": "CHRG-119hhrg99999-mods.xml",
};

function mockFetch(captured: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    captured.push(url);

    if (url === chrgSitemapIndexUrl()) {
      return new Response(readFixture(...CASE, "sitemap-index.xml"), { status: 200 });
    }
    if (url === chrgYearSitemapUrl(2025)) {
      return new Response(readFixture(...CASE, "sitemap-2025.xml"), { status: 200 });
    }
    if (url === chrgYearSitemapUrl(2026)) {
      return new Response(readFixture(...CASE, "sitemap-2026.xml"), { status: 200 });
    }
    for (const [packageId, file] of Object.entries(MODS_FIXTURES)) {
      if (url === hearingModsUrl(packageId)) {
        return new Response(readFixture(...CASE, file), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: AltDataStore; captured: string[] }> {
  const store = await AltDataStore.open(":memory:");
  const captured: string[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

const WM_2025 = "sitemap.2025.lastmod";
const WM_2026 = "sitemap.2026.lastmod";

describe("govinfoHearingsSource.sync", () => {
  it("walks previous+current year, skip-and-counts the bad mods, and stores the rest", async () => {
    const { ctx, store, captured } = await makeCtx();

    const result = await govinfoHearingsSource.sync(ctx);
    expect(result.rowsUpserted).toBe(3);
    expect(result.perDataset["congress-hearings"]).toBe(3);
    expect(result.parse).toEqual({ attempted: 4, succeeded: 3 });
    expect(result.notes.join(" ")).toContain("CHRG-119hhrg99999 skipped");
    expect(await store.count("congress-hearings")).toBe(3);

    // Index + 2 year sitemaps + 4 mods documents; the duplicate loc and the
    // unrecognized loc are never fetched at all.
    expect(captured).toHaveLength(7);
    expect(captured).toContain(chrgSitemapIndexUrl());
    expect(captured).toContain(chrgYearSitemapUrl(2025));
    expect(captured).toContain(chrgYearSitemapUrl(2026));

    const rows: CongressHearing[] = [];
    for await (const row of store.iterate(DATASETS["congress-hearings"])) rows.push(row);
    expect(rows).toEqual(readFixtureJson<CongressHearing[]>(...CASE, "expected.json"));

    // CHRG-119hhrg99999's missing title is permanent document damage — a
    // noted skip, not a held watermark — so BOTH years complete and record
    // their sitemap lastmods.
    expect(await store.getWatermark("govinfo-hearings", WM_2025)).toBe("2026-08-23T18:01:00.111Z");
    expect(await store.getWatermark("govinfo-hearings", WM_2026)).toBe("2026-08-24T06:00:00.000Z");

    await store.close();
  });

  it("re-running skips both unchanged sitemaps entirely — the stub package is not re-fetched", async () => {
    const { ctx, store, captured } = await makeCtx();
    await govinfoHearingsSource.sync(ctx);
    captured.length = 0;

    const second = await govinfoHearingsSource.sync(ctx);
    // Both years' watermarks equal their index lastmods → not even the year
    // sitemaps are fetched, and the permanently-unparseable package is left
    // alone until GPO regenerates the 2026 sitemap (new lastmod → re-diff →
    // it is still missing from the store → retried then).
    expect(captured).toEqual([chrgSitemapIndexUrl()]);
    expect(second.rowsUpserted).toBe(0);
    expect(second.parse).toEqual({ attempted: 0, succeeded: 0 });
    expect(await store.count("congress-hearings")).toBe(3);

    await store.close();
  });

  it("--full re-walks every package past both the lastmod skip and the id diff", async () => {
    const { ctx, store, captured } = await makeCtx();
    await govinfoHearingsSource.sync(ctx);
    captured.length = 0;

    const full = await govinfoHearingsSource.sync(ctx, { full: true });
    expect(captured).toContain(chrgYearSitemapUrl(2025));
    expect(captured).toContain(hearingModsUrl("CHRG-119hhrg90001"));
    expect(captured).toContain(hearingModsUrl("CHRG-119jhrg80001"));
    expect(full.parse).toEqual({ attempted: 4, succeeded: 3 });
    // Idempotent: same natural keys, still 3 rows.
    expect(await store.count("congress-hearings")).toBe(3);

    await store.close();
  });

  it("--since selects a year range and notes years the index doesn't list", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoHearingsSource.sync(ctx, { since: "2024-06-01" });

    expect(result.notes).toContain("2024: not listed in the CHRG sitemap index");
    expect(captured).toContain(chrgYearSitemapUrl(2025));
    expect(captured).toContain(chrgYearSitemapUrl(2026));
    expect(result.rowsUpserted).toBe(3);

    await store.close();
  });

  it("honors a shared --limit across years and notes the stop", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoHearingsSource.sync(ctx, { limit: 1 });

    // 2025's single package spends the whole budget; 2026 is never walked.
    expect(result.rowsUpserted).toBe(1);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(captured).not.toContain(chrgYearSitemapUrl(2026));
    // 2025's own walk completed within budget, so its watermark advances;
    // 2026 was never started.
    expect(await store.getWatermark("govinfo-hearings", WM_2025)).toBe("2026-08-23T18:01:00.111Z");
    expect(await store.getWatermark("govinfo-hearings", WM_2026)).toBeNull();

    await store.close();
  });

  it("notes an index transport failure instead of pretending an empty success", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("boom", { status: 400 })) as typeof fetch;

    const result = await govinfoHearingsSource.sync(ctx);
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes.join(" ")).toContain("HTTP 400");

    await store.close();
  });

  it("rejects loudly when a year sitemap's shape has drifted to zero locs", async () => {
    const { ctx, store } = await makeCtx();
    const base = ctx.fetchImpl as typeof fetch;
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === chrgYearSitemapUrl(2025)) {
        return new Response(`<urlset></urlset>`, { status: 200 });
      }
      return base(input);
    }) as typeof fetch;

    await expect(govinfoHearingsSource.sync(ctx)).rejects.toThrow(GovinfoHearingsDriftError);
    await store.close();
  });

  it("skips a stub mods document (no title, no accessId) with a note and still completes the year", async () => {
    // GPO really publishes such stubs (observed live: CHRG-105jhrg in the
    // 1997 sitemap) — one of them must never stop the walk or hold the
    // year's watermark hostage forever.
    const { ctx, store } = await makeCtx();
    const base = ctx.fetchImpl as typeof fetch;
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === hearingModsUrl("CHRG-119jhrg80001")) {
        return new Response(`<mods><originInfo></originInfo></mods>`, { status: 200 });
      }
      return base(input);
    }) as typeof fetch;

    const result = await govinfoHearingsSource.sync(ctx);
    expect(result.rowsUpserted).toBe(2);
    expect(result.notes.join(" ")).toContain("CHRG-119jhrg80001 skipped");
    // The parse skip is permanent-document damage, not a transport fault —
    // the year still completes and records its watermark.
    expect(await store.getWatermark("govinfo-hearings", WM_2025)).toBe("2026-08-23T18:01:00.111Z");
    await store.close();
  });

  it("rejects loudly when a year fetches many mods documents and parses none (zero-parse tripwire)", async () => {
    const { ctx, store } = await makeCtx();
    const base = ctx.fetchImpl as typeof fetch;
    const stub = `<mods><originInfo></originInfo></mods>`;
    // Every 2025 package resolves to a stub, and the sitemap lists enough of
    // them to arm the tripwire.
    const locs = Array.from(
      { length: 12 },
      (_, i) =>
        `<url><loc>https://www.govinfo.gov/app/details/CHRG-119hhrg7${String(i).padStart(4, "0")}</loc></url>`,
    ).join("");
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === chrgYearSitemapUrl(2025)) {
        return new Response(`<urlset>${locs}</urlset>`, { status: 200 });
      }
      if (/CHRG-119hhrg7\d{4}\/mods\.xml$/.test(url)) {
        return new Response(stub, { status: 200 });
      }
      return base(input);
    }) as typeof fetch;

    await expect(govinfoHearingsSource.sync(ctx)).rejects.toThrow(GovinfoHearingsDriftError);
    await expect(govinfoHearingsSource.sync(ctx)).rejects.toThrow(/zero parsed/);
    await store.close();
  });

  it("respects the datasets filter as a full no-op", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoHearingsSource.sync(ctx, { datasets: ["bills"] });

    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);

    await store.close();
  });
});

describe("yearsToWalk", () => {
  const now = new Date(NOW);

  it("defaults to the previous and current year (late publications land under the next year)", () => {
    expect(yearsToWalk({}, now)).toEqual([2025, 2026]);
  });

  it("maps --since/--until to a year range, clamped to the current year", () => {
    expect(yearsToWalk({ since: "2023-05-01" }, now)).toEqual([2023, 2024, 2025, 2026]);
    expect(yearsToWalk({ since: "2023-05-01", until: "2024-02-01" }, now)).toEqual([2023, 2024]);
    expect(yearsToWalk({ since: "2026-01-01", until: "2030-01-01" }, now)).toEqual([2026]);
  });

  it("floors ancient --since values at the collection's earliest plausible year", () => {
    const years = yearsToWalk({ since: "1900-01-01", until: "1996-12-31" }, now);
    expect(years[0]).toBe(1995);
    expect(years[years.length - 1]).toBe(1996);
  });
});

describe("govinfoHearingsSource.canary", () => {
  it("probes the sitemap index and reports freshness", async () => {
    const { ctx, store } = await makeCtx();

    const outcome = await govinfoHearingsSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-sitemap-index"]?.ok).toBe(true);
    expect(byName["probe-sitemap-index"]?.note).toContain("2 year sitemap(s)");
    expect(byName["freshness-congress-hearings"]?.ok).toBe(false);
    expect(byName["freshness-congress-hearings"]?.note).toBe("no rows ingested yet");

    await store.close();
  });

  it("goes green on freshness once hearings have been ingested", async () => {
    const { ctx, store } = await makeCtx();
    await govinfoHearingsSource.sync(ctx);

    const outcome = await govinfoHearingsSource.canary(ctx);
    const freshness = outcome.checks.find((c) => c.name === "freshness-congress-hearings");
    expect(freshness?.ok).toBe(true);
    expect(freshness?.severity).toBe("soft");

    await store.close();
  });

  it("hard-fails the index probe when the request errors", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("boom", { status: 400 })) as typeof fetch;

    const outcome = await govinfoHearingsSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-sitemap-index");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");

    await store.close();
  });

  it("scores parse-success-rate from the last recorded sync run", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("govinfo-hearings");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 5,
      parseAttempted: 10,
      parseSucceeded: 5,
    });

    const outcome = await govinfoHearingsSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(false);
    expect(rate?.severity).toBe("hard");

    await store.close();
  });
});
