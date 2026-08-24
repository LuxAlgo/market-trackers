import { describe, expect, it } from "vitest";
import { usaspendingSource, USASPENDING_AWARD_SEARCH_URL } from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { GovContractAward } from "../../schema/gov-contract-award.js";
import { DocketStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: the award-search POST pages
 * through two fixture responses (page 1 hasNext, page 2 final). The sync
 * must normalize every row, resolve tickers through the curated map, set
 * the action-date watermark, and be idempotent on re-runs.
 */

const NOW = "2026-08-24T12:00:00.000Z";

interface CapturedBody {
  filters: { time_period: { start_date: string; end_date: string }[]; award_type_codes: string[] };
  fields: string[];
  page: number;
  limit: number;
  sort: string;
  order: string;
}

function mockFetch(captured: CapturedBody[]): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url) !== USASPENDING_AWARD_SEARCH_URL || init?.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init.body)) as CapturedBody;
    captured.push(body);
    const fixture = body.page === 1 ? "input-page-1.json" : "input-page-2.json";
    return new Response(readFixture("usaspending", "case-award-search", fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{
  ctx: SourceContext;
  store: DocketStore;
  captured: CapturedBody[];
}> {
  const store = await DocketStore.open(":memory:");
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

describe("usaspendingSource.sync", () => {
  it("pages until hasNext is false, normalizes every award, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await usaspendingSource.sync(ctx);
    expect(first.rowsUpserted).toBe(4);
    expect(first.perDataset["gov-contracts"]).toBe(4);
    expect(first.parse).toEqual({ attempted: 4, succeeded: 4 });
    expect(await store.count("gov-contracts")).toBe(4);

    // Both pages were requested with the pinned contract shape.
    expect(captured).toHaveLength(2);
    expect(captured[0]?.page).toBe(1);
    expect(captured[1]?.page).toBe(2);
    expect(captured[0]?.limit).toBe(100);
    expect(captured[0]?.sort).toBe("Start Date");
    expect(captured[0]?.order).toBe("asc");
    expect(captured[0]?.filters.award_type_codes).toEqual(["A", "B", "C", "D"]);
    expect(captured[0]?.fields).toContain("generated_internal_id");
    expect(captured[0]?.fields).toContain("Recipient UEI");
    // No watermark yet: backfillDays (3) before the pinned today.
    expect(captured[0]?.filters.time_period).toEqual([
      { start_date: "2026-08-21", end_date: "2026-08-24" },
    ]);

    // Stored rows match the hand-verified expected output exactly.
    const rows: GovContractAward[] = [];
    for await (const row of store.iterate(DATASETS["gov-contracts"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<GovContractAward[]>("usaspending", "case-award-search", "expected.json"),
    );

    // Watermark lands on the max action date; fingerprint recorded.
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBe(
      "2026-08-21",
    );
    expect(await store.getFingerprint("usaspending", "usaspending.award-row-fields")).toBeTruthy();

    // Re-running re-walks the trailing 3 days and duplicates nothing.
    const second = await usaspendingSource.sync(ctx);
    expect(second.rowsUpserted).toBe(4);
    expect(await store.count("gov-contracts")).toBe(4);
    expect(captured[2]?.filters.time_period).toEqual([
      { start_date: "2026-08-18", end_date: "2026-08-24" },
    ]);

    await store.close();
  });

  it("honors --limit without advancing the watermark", async () => {
    const { ctx, store } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, { limit: 2 });
    expect(result.rowsUpserted).toBe(2);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.getWatermark("usaspending", "usaspending.lastActionDate")).toBeNull();
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await usaspendingSource.sync(ctx, { datasets: ["short-volume"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });
});

describe("usaspendingSource.canary", () => {
  it("goes green when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await usaspendingSource.sync(ctx);

    const outcome = await usaspendingSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-award-search"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-gov-contracts"]?.ok).toBe(true);
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

  it("hard-fails the probe when the API rejects the query", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await usaspendingSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-award-search");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });
});
