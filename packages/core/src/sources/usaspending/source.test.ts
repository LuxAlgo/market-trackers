import { describe, expect, it } from "vitest";
import { normalizeAwardRow, usaspendingSource, USASPENDING_AWARD_SEARCH_URL } from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { GovContractAward } from "../../schema/gov-contract-award.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source tests with a mocked network. USAspending is one client
 * serving two award universes (contracts A–D, grants 02/03/04/05); the mock
 * routes on the requested `award_type_codes` so each universe pages through
 * its own fixture set. The sync must normalize every row, resolve tickers
 * through the curated map, keep the two watermarks/fingerprints
 * independent, honor the dataset filter and `--until`, and be idempotent on
 * re-runs.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const GRANT_CODES = ["02", "03", "04", "05"];

interface CapturedBody {
  filters: {
    time_period: { start_date: string; end_date: string; date_type?: string }[];
    award_type_codes: string[];
    award_amounts?: { lower_bound?: number; upper_bound?: number }[];
  };
  fields: string[];
  page: number;
  limit: number;
  sort: string;
  order: string;
  last_record_unique_id?: number;
  last_record_sort_value?: string | number;
}

/** The window every request is expected to carry: signing-date bounded, inclusive. */
function window(start_date: string, end_date: string) {
  return [{ start_date, end_date, date_type: "new_awards_only" }];
}

function mockFetch(captured: CapturedBody[]): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url) !== USASPENDING_AWARD_SEARCH_URL || init?.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init.body)) as CapturedBody;
    captured.push(body);
    const isGrant = body.filters.award_type_codes.some((c) => GRANT_CODES.includes(c));
    const fixtureCase = isGrant ? "case-grant-search" : "case-award-search";
    const fixture = body.page === 1 ? "input-page-1.json" : "input-page-2.json";
    return new Response(readFixture("usaspending", fixtureCase, fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{
  ctx: SourceContext;
  store: TrackerStore;
  captured: CapturedBody[];
}> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedBody[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(NOW),
  };
  return { ctx, store, captured };
}

describe("usaspendingSource.sync — contracts", () => {
  it("pages until hasNext is false, normalizes every award, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await usaspendingSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(first.rowsUpserted).toBe(4);
    expect(first.perDataset["gov-contracts"]).toBe(4);
    expect(first.parse).toEqual({ attempted: 4, succeeded: 4 });
    expect(await store.count("gov-contracts")).toBe(4);

    // Both pages were requested with the pinned contract shape.
    expect(captured).toHaveLength(2);
    expect(captured[0]?.page).toBe(1);
    expect(captured[1]?.page).toBe(2);
    expect(captured[0]?.limit).toBe(100);
    expect(captured[0]?.sort).toBe("Base Obligation Date");
    expect(captured[0]?.order).toBe("asc");
    expect(captured[0]?.filters.award_type_codes).toEqual(["A", "B", "C", "D"]);
    expect(captured[0]?.fields).toContain("generated_internal_id");
    expect(captured[0]?.fields).toContain("Recipient UEI");
    expect(captured[0]?.fields).toContain("Base Obligation Date");
    // No watermark yet: backfillDays (3) before the pinned today, bounded on
    // the signing date so every award falls in exactly one window.
    expect(captured[0]?.filters.time_period).toEqual(window("2026-08-21", "2026-08-24"));
    // Paging is by number only: the server's search_after cursor answers
    // 503 for this sort field live, so it is never echoed.
    for (const body of captured) {
      expect(body.last_record_unique_id).toBeUndefined();
      expect(body.last_record_sort_value).toBeUndefined();
    }

    // Stored rows match the hand-verified expected output exactly.
    const rows: GovContractAward[] = [];
    for await (const row of store.iterate(DATASETS["gov-contracts"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<GovContractAward[]>("usaspending", "case-award-search", "expected.json"),
    );

    // Watermark lands on the newest signing date; fingerprint recorded.
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
      "2026-08-21",
    );
    expect(await store.getFingerprint("usaspending", "usaspending.award-row-fields")).toBeTruthy();
    // The grant universe wasn't asked for, so it never ran.
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBeNull();
    expect(await store.count("gov-grants")).toBe(0);

    // Re-running re-walks the trailing 3 days and duplicates nothing.
    const second = await usaspendingSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(second.rowsUpserted).toBe(4);
    expect(await store.count("gov-contracts")).toBe(4);
    expect(captured[2]?.filters.time_period).toEqual(window("2026-08-18", "2026-08-24"));

    await store.close();
  });

  it("honors --limit without advancing the watermark (shared across both universes)", async () => {
    const { ctx, store } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, { limit: 2 });
    // The budget is spent entirely on contracts (walked first); grants gets
    // none of it and never fetches.
    expect(result.rowsUpserted).toBe(2);
    expect(result.perDataset["gov-contracts"]).toBe(2);
    expect(result.perDataset["gov-grants"]).toBeUndefined();
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBeNull();
    expect(await store.count("gov-grants")).toBe(0);
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, { datasets: ["short-volume"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });

  it("resolves a recipient through the SEC-name fallback, seeded in cik_tickers before the sync runs", async () => {
    const { ctx, store } = await makeCtx();
    // A name the curated map has no entry for at all — only the SEC tier,
    // seeded directly into this store, can resolve it.
    await store.replaceCikTickers([
      { cik: "0000000789", ticker: "TRFC", name: "Torchlight Robotics Corp" },
    ]);
    ctx.fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              generated_internal_id: "SEC_FALLBACK_0001",
              "Award ID": "SEC-FALLBACK-1",
              "Recipient Name": "TORCHLIGHT ROBOTICS CORP",
              "Recipient UEI": null,
              "Awarding Agency": "Department of Example",
              "Awarding Sub Agency": null,
              "Award Amount": 500_000,
              Description: null,
              "Contract Award Type": "DEFINITIVE CONTRACT",
              "NAICS Code": null,
              "NAICS Description": null,
              "Start Date": "2026-08-20",
            },
          ],
          page_metadata: { page: 1, hasNext: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const result = await usaspendingSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(result.rowsUpserted).toBe(1);
    const rows: GovContractAward[] = [];
    for await (const row of store.iterate(DATASETS["gov-contracts"])) rows.push(row);
    expect(rows[0]?.recipient).toEqual({
      name: "TORCHLIGHT ROBOTICS CORP",
      uei: null,
      tickers: ["TRFC"],
    });
    // No signing date on this row: the period-of-performance start stands in.
    expect(rows[0]?.actionDate).toBe("2026-08-20");
    await store.close();
  });
});

describe("usaspendingSource.sync — walk semantics", () => {
  const baseRow = {
    generated_internal_id: "CONT_AWD_X_1",
    "Award ID": "X-1",
    "Recipient Name": "EXAMPLE CORP",
    "Recipient UEI": null,
    "Awarding Agency": "Department of Example",
    "Awarding Sub Agency": null,
    "Award Amount": 1,
    Description: null,
    "Contract Award Type": "DEFINITIVE CONTRACT",
    "NAICS Code": null,
    "NAICS Description": null,
  };

  it("dates a row by its signing date, falling back to the period-of-performance start", async () => {
    const store = await TrackerStore.open(":memory:");
    const signed = await normalizeAwardRow(
      { ...baseRow, "Base Obligation Date": "2026-08-10", "Start Date": "2026-09-01" },
      NOW,
      store,
    );
    expect(signed.actionDate).toBe("2026-08-10");
    const unsigned = await normalizeAwardRow(
      { ...baseRow, "Base Obligation Date": null, "Start Date": "2026-09-01" },
      NOW,
      store,
    );
    expect(unsigned.actionDate).toBe("2026-09-01");
    await expect(
      normalizeAwardRow(
        { ...baseRow, "Base Obligation Date": null, "Start Date": null },
        NOW,
        store,
      ),
    ).rejects.toThrow(/unusable/);
    await store.close();
  });

  it("treats a stored watermark in the future as today and rewrites it on a completed walk", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("usaspending", "usaspending.lastActionDate", "2027-08-31");

    const result = await usaspendingSource.sync(ctx, { datasets: ["gov-contracts"] });
    // The window is the trailing re-walk from today, not an empty [today, today].
    expect(captured[0]?.filters.time_period).toEqual(window("2026-08-21", "2026-08-24"));
    expect(result.rowsUpserted).toBe(4);
    expect(result.notes.join(" ")).toMatch(/2027-08-31 is in the future/);
    // The completed walk replaces the artifact with a real date.
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
      "2026-08-21",
    );
    await store.close();
  });

  it("a mid-walk upstream failure keeps the rows already stored and reports the covered day", async () => {
    const { ctx, store, captured } = await makeCtx();
    const fixtureFetch = ctx.fetchImpl!;
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      const real = await fixtureFetch(url, init);
      // 400 is not a retry status, so the polite fetch surfaces it at once.
      return body.page === 2 ? new Response("gone", { status: 400 }) : real;
    }) as typeof fetch;

    const result = await usaspendingSource.sync(ctx, {
      datasets: ["gov-contracts"],
      since: "2026-08-01",
    });
    expect(captured.map((b) => b.page)).toEqual([1, 2]);
    expect(result.rowsUpserted).toBe(2);
    expect(await store.count("gov-contracts")).toBe(2);
    expect(result.stoppedEarly).toBe("upstream");
    // Page 1's newest signing date is 2026-08-19; every award signed before
    // it is stored, so the day before is the safe resume point.
    expect(result.completedThrough).toBe("2026-08-18");
    expect(result.notes.join(" ")).toMatch(/HTTP 400/);
    // An incomplete walk never advances the watermark.
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBeNull();
    await store.close();
  });

  it("an elapsed deadline stops before the first request", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, {
      datasets: ["gov-contracts"],
      deadlineMs: new Date(NOW).getTime() - 1,
    });
    expect(captured).toHaveLength(0);
    expect(result.stoppedEarly).toBe("deadline");
    expect(result.completedThrough).toBeNull();
    expect(result.rowsUpserted).toBe(0);
    await store.close();
  });

  it("a stop in the contracts walk leaves nothing fully covered, since grants never ran", async () => {
    const { ctx, store, captured } = await makeCtx();
    const fixtureFetch = ctx.fetchImpl!;
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      const real = await fixtureFetch(url, init);
      return body.page === 2 ? new Response("gone", { status: 400 }) : real;
    }) as typeof fetch;

    const result = await usaspendingSource.sync(ctx, { since: "2026-08-01" });
    expect(result.stoppedEarly).toBe("upstream");
    expect(result.completedThrough).toBeNull();
    // Contracts got two requests; grants were never started.
    expect(captured).toHaveLength(2);
    expect(captured.every((b) => b.filters.award_type_codes[0] === "A")).toBe(true);
    expect(await store.count("gov-grants")).toBe(0);
    await store.close();
  });

  it("a stop in the grants walk reports grants' covered day, contracts having completed", async () => {
    const { ctx, store } = await makeCtx();
    const fixtureFetch = ctx.fetchImpl!;
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      const isGrant = body.filters.award_type_codes.includes("02");
      const real = await fixtureFetch(url, init);
      return isGrant && body.page === 2 ? new Response("gone", { status: 400 }) : real;
    }) as typeof fetch;

    const result = await usaspendingSource.sync(ctx, { since: "2026-08-01" });
    expect(result.stoppedEarly).toBe("upstream");
    expect(result.completedThrough).toBe("2026-08-18");
    expect(await store.count("gov-contracts")).toBe(4);
    expect(await store.count("gov-grants")).toBe(2);
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
      "2026-08-21",
    );
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBeNull();
    await store.close();
  });
});

describe("usaspendingSource.sync — grants", () => {
  it("ingests the grant universe into gov-grants with its own watermark and fingerprint", async () => {
    const { ctx, store, captured } = await makeCtx();

    const result = await usaspendingSource.sync(ctx, { datasets: ["gov-grants"] });
    expect(result.rowsUpserted).toBe(4);
    expect(result.perDataset["gov-grants"]).toBe(4);
    expect(result.perDataset["gov-contracts"]).toBeUndefined();
    expect(await store.count("gov-grants")).toBe(4);
    expect(await store.count("gov-contracts")).toBe(0);

    expect(captured).toHaveLength(2);
    for (const body of captured) {
      expect(body.filters.award_type_codes).toEqual(["02", "03", "04", "05"]);
    }

    // Stored rows match the hand-verified expected output exactly: a
    // curated-map exact match (Pfizer -> PFE), an unmapped university, and a
    // word-boundary prefix match (Modernatx Biodefense Division -> MRNA)
    // that also carries the null amount + null description.
    const rows: GovContractAward[] = [];
    for await (const row of store.iterate(DATASETS["gov-grants"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<GovContractAward[]>("usaspending", "case-grant-search", "expected.json"),
    );
    expect(rows.find((r) => r.recipient.name === "PFIZER INC")?.recipient.tickers).toEqual(["PFE"]);
    expect(
      rows.find((r) => r.recipient.name === "TRUENORTH STATE UNIVERSITY")?.recipient.tickers,
    ).toEqual([]);
    // Single-token map names are exact-match only: "MODERNATX" never
    // prefix-claims a longer division name (see resolve/recipients.ts).
    expect(
      rows.find((r) => r.recipient.name === "MODERNATX BIODEFENSE DIVISION")?.recipient.tickers,
    ).toEqual([]);
    const nullAmountRow = rows.find((r) => r.amountUsd === null);
    expect(nullAmountRow?.description).toBeNull();

    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBe(
      "2026-08-21",
    );
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBeNull();
    expect(
      await store.getFingerprint("usaspending", "usaspending.grants.award-row-fields"),
    ).toBeTruthy();

    await store.close();
  });

  it("re-running the grants sync re-walks trailing days and duplicates nothing", async () => {
    const { ctx, store } = await makeCtx();
    await usaspendingSource.sync(ctx, { datasets: ["gov-grants"] });
    expect(await store.count("gov-grants")).toBe(4);

    const second = await usaspendingSource.sync(ctx, { datasets: ["gov-grants"] });
    expect(second.rowsUpserted).toBe(4);
    expect(await store.count("gov-grants")).toBe(4);
    await store.close();
  });

  it("syncs both datasets in one run when no dataset filter is given", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await usaspendingSource.sync(ctx);

    expect(result.perDataset["gov-contracts"]).toBe(4);
    expect(result.perDataset["gov-grants"]).toBe(4);
    expect(result.rowsUpserted).toBe(8);
    expect(await store.count("gov-contracts")).toBe(4);
    expect(await store.count("gov-grants")).toBe(4);

    // Contracts walk first (2 pages), then grants (2 pages).
    expect(captured).toHaveLength(4);
    expect(captured[0]?.filters.award_type_codes).toEqual(["A", "B", "C", "D"]);
    expect(captured[1]?.filters.award_type_codes).toEqual(["A", "B", "C", "D"]);
    expect(captured[2]?.filters.award_type_codes).toEqual(["02", "03", "04", "05"]);
    expect(captured[3]?.filters.award_type_codes).toEqual(["02", "03", "04", "05"]);

    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
      "2026-08-21",
    );
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBe(
      "2026-08-21",
    );
    await store.close();
  });

  it("honors --until, clamping the request window instead of walking through today", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, {
      datasets: ["gov-grants"],
      since: "2026-07-01",
      until: "2026-07-15",
    });

    expect(captured[0]?.filters.time_period).toEqual(window("2026-07-01", "2026-07-15"));
    // The bounded walk still completes (hasNext: false on page 2) and
    // advances the watermark — but never past the window it walked, even
    // when rows (synthetic here) carry later dates.
    expect(result.rowsUpserted).toBe(4);
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBe(
      "2026-07-15",
    );
    await store.close();
  });

  it("a future --until clamps to today rather than requesting a future date", async () => {
    const { ctx, captured } = await makeCtx();
    await usaspendingSource.sync(ctx, { datasets: ["gov-grants"], until: "2030-01-01" });
    expect(captured[0]?.filters.time_period[0]?.end_date).toBe("2026-08-24");
  });
});

describe("usaspendingSource.sync — the server's result window", () => {
  const ENV = "MARKET_TRACKERS_USASPENDING_RESULT_WINDOW";
  function rowsResponse(ids: string[], hasNext: boolean, date = "2026-08-21") {
    return new Response(
      JSON.stringify({
        results: ids.map((id) => ({
          generated_internal_id: id,
          "Award ID": id,
          "Recipient Name": "SLICE RECIPIENT",
          "Recipient UEI": null,
          "Awarding Agency": "Department of Example",
          "Awarding Sub Agency": null,
          "Award Amount": 1000,
          Description: null,
          "Contract Award Type": "DEFINITIVE CONTRACT",
          "NAICS Code": null,
          "NAICS Description": null,
          "Base Obligation Date": date,
          "Start Date": date,
        })),
        page_metadata: { page: 1, hasNext },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("a multi-day window that fills the result window stops with the day to resume from", async () => {
    process.env[ENV] = "4";
    try {
      const { ctx, store } = await makeCtx();
      // The fixture's four rows arrive over two pages and the server then
      // reports no next page: exactly the window size, so the tail of the
      // newest day (and every later day) may be missing.
      const result = await usaspendingSource.sync(ctx, {
        datasets: ["gov-contracts"],
        since: "2026-08-01",
      });
      expect(result.rowsUpserted).toBe(4);
      expect(result.stoppedEarly).toBe("window");
      expect(result.completedThrough).toBe("2026-08-20");
      expect(result.notes.join(" ")).toMatch(/result window \(4 rows\) reached at 2026-08-21/);
      expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBeNull();
      await store.close();
    } finally {
      delete process.env[ENV];
    }
  });

  it("a single day that fills the result window is re-read one award type at a time", async () => {
    process.env[ENV] = "4";
    try {
      const { ctx, store, captured } = await makeCtx();
      const fixtureFetch = ctx.fetchImpl!;
      ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as CapturedBody;
        const codes = body.filters.award_type_codes;
        // The whole universe overflows (fixture: 4 rows = the window); each
        // single type fits comfortably.
        if (codes.length === 1) {
          captured.push(body);
          return rowsResponse([`TYPE_${codes[0]}_0001`], false);
        }
        return fixtureFetch(url, init);
      }) as typeof fetch;

      const result = await usaspendingSource.sync(ctx, {
        datasets: ["gov-contracts"],
        since: "2026-08-21",
        until: "2026-08-21",
      });
      expect(result.stoppedEarly).toBeUndefined();
      expect(result.notes.join(" ")).toMatch(
        /2026-08-21 overflowed the result window; re-read by award type and amount band in full/,
      );
      // Two whole-universe pages, then one request per type code, no amount bands.
      expect(captured.map((b) => b.filters.award_type_codes.join(""))).toEqual([
        "ABCD",
        "ABCD",
        "A",
        "B",
        "C",
        "D",
      ]);
      expect(captured.every((b) => b.filters.award_amounts === undefined)).toBe(true);
      expect(await store.count("gov-contracts")).toBe(8);
      // The day completed, so the watermark advances to it.
      expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
        "2026-08-21",
      );
      await store.close();
    } finally {
      delete process.env[ENV];
    }
  });

  it("an award type that still overflows a single day is re-read by amount band", async () => {
    process.env[ENV] = "4";
    try {
      const { ctx, store, captured } = await makeCtx();
      const fixtureFetch = ctx.fetchImpl!;
      ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as CapturedBody;
        const codes = body.filters.award_type_codes;
        if (codes.length === 4) return fixtureFetch(url, init);
        captured.push(body);
        // Type A alone still fills the window; each of its amount bands fits.
        if (codes[0] === "A" && !body.filters.award_amounts) {
          return rowsResponse(["A_0001", "A_0002", "A_0003", "A_0004"], false);
        }
        if (codes[0] === "A") {
          const band = body.filters.award_amounts![0]!;
          return rowsResponse([`A_BAND_${band.lower_bound ?? 0}`], false);
        }
        return rowsResponse([`TYPE_${codes[0]}_0001`], false);
      }) as typeof fetch;

      const result = await usaspendingSource.sync(ctx, {
        datasets: ["gov-contracts"],
        since: "2026-08-21",
        until: "2026-08-21",
      });
      expect(result.stoppedEarly).toBeUndefined();
      const bandRequests = captured.filter((b) => b.filters.award_amounts);
      expect(bandRequests.map((b) => b.filters.award_amounts![0])).toEqual([
        { upper_bound: 25_000 },
        { lower_bound: 25_000, upper_bound: 100_000 },
        { lower_bound: 100_000, upper_bound: 1_000_000 },
        { lower_bound: 1_000_000 },
      ]);
      expect(bandRequests.every((b) => b.filters.award_type_codes[0] === "A")).toBe(true);
      // 4 fixture rows + 4 type-A rows + 4 band rows + one each for B, C, D.
      expect(await store.count("gov-contracts")).toBe(15);
      expect(result.notes.join(" ")).toMatch(/in full/);
      await store.close();
    } finally {
      delete process.env[ENV];
    }
  });
});

describe("usaspendingSource.canary", () => {
  it("goes green for both universes when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await usaspendingSource.sync(ctx);

    const outcome = await usaspendingSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-award-search"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-gov-contracts"]?.ok).toBe(true);
    expect(byName["probe-grant-search"]?.ok).toBe(true);
    expect(byName["fingerprint-grants"]?.ok).toBe(true);
    expect(byName["parse-success-rate-grants"]?.ok).toBe(true);
    expect(byName["freshness-gov-grants"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when result-row field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("usaspending", "usaspending.award-row-fields", "somethingelse");
    const outcome = await usaspendingSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the grants fingerprint check independently of the contracts one", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("usaspending", "usaspending.grants.award-row-fields", "wrong");
    const outcome = await usaspendingSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fingerprint-grants"]?.ok).toBe(false);
    expect(byName["fingerprint-grants"]?.severity).toBe("hard");
    // Contracts fingerprint has no stored baseline yet, so it records one and passes.
    expect(byName["fingerprint"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the probe when the API rejects the query", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await usaspendingSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-award-search");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    const grantProbe = outcome.checks.find((c) => c.name === "probe-grant-search");
    expect(grantProbe?.ok).toBe(false);
    expect(grantProbe?.severity).toBe("hard");
    await store.close();
  });
});
