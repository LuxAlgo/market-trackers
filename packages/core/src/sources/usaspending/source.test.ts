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
    // The grant universe wasn't asked for, so it never ran.
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBeNull();
    expect(await store.count("gov-grants")).toBe(0);

    // Re-running re-walks the trailing 3 days and duplicates nothing.
    const second = await usaspendingSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(second.rowsUpserted).toBe(4);
    expect(await store.count("gov-contracts")).toBe(4);
    expect(captured[2]?.filters.time_period).toEqual([
      { start_date: "2026-08-18", end_date: "2026-08-24" },
    ]);

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
    expect(
      rows.find((r) => r.recipient.name === "MODERNATX BIODEFENSE DIVISION")?.recipient.tickers,
    ).toEqual(["MRNA"]);
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

    expect(captured[0]?.filters.time_period).toEqual([
      { start_date: "2026-07-01", end_date: "2026-07-15" },
    ]);
    // The bounded walk still completes (hasNext: false on page 2) and
    // advances the watermark to the max action date it found.
    expect(result.rowsUpserted).toBe(4);
    expect(await store.getWatermark("usaspending", "usaspending.grants.lastActionDate")).toBe(
      "2026-08-21",
    );
    await store.close();
  });

  it("a future --until clamps to today rather than requesting a future date", async () => {
    const { ctx, captured } = await makeCtx();
    await usaspendingSource.sync(ctx, { datasets: ["gov-grants"], until: "2030-01-01" });
    expect(captured[0]?.filters.time_period[0]?.end_date).toBe("2026-08-24");
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
