import { describe, expect, it } from "vitest";
import { ldaSource, ldaFilingYears, LDA_FILINGS_URL } from "./source.js";
import { parseLdaAmount } from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { LobbyingFiling } from "../../schema/lobbying-filing.js";
import { DocketStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: the filings list pages
 * through two fixture responses for filing year 2026 (newest-first by
 * dt_posted). The sync must normalize every filing, parse string amounts
 * (nulls stay null), resolve client tickers, set the posted-date watermark,
 * and be idempotent on re-runs.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const EMPTY_PAGE = JSON.stringify({ count: 0, next: null, previous: null, results: [] });

interface CapturedRequest {
  filingYear: string | null;
  page: string | null;
  pageSize: string | null;
  ordering: string | null;
  authorization: string | null;
}

function mockFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== LDA_FILINGS_URL) {
      return new Response("not found", { status: 404 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      filingYear: url.searchParams.get("filing_year"),
      page: url.searchParams.get("page"),
      pageSize: url.searchParams.get("page_size"),
      ordering: url.searchParams.get("ordering"),
      authorization: headers.authorization ?? null,
    });
    if (url.searchParams.get("filing_year") !== "2026") {
      return new Response(EMPTY_PAGE, { status: 200 });
    }
    const fixture =
      url.searchParams.get("page") === "1" ? "input-page-1.json" : "input-page-2.json";
    return new Response(readFixture("lda", "case-filings-2026", fixture), { status: 200 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: DocketStore; captured: CapturedRequest[] }> {
  const store = await DocketStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

describe("ldaSource.sync", () => {
  it("pages the filing year newest-first, normalizes every filing, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await ldaSource.sync(ctx);
    expect(first.rowsUpserted).toBe(5);
    expect(first.perDataset["lobbying-filings"]).toBe(5);
    expect(first.parse).toEqual({ attempted: 5, succeeded: 5 });
    expect(await store.count("lobbying-filings")).toBe(5);

    // Both pages of the current filing year, keyless, ordered by -dt_posted.
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      filingYear: "2026",
      page: "1",
      pageSize: "25",
      ordering: "-dt_posted",
      authorization: null,
    });
    expect(captured[1]?.page).toBe("2");

    // Stored rows match the hand-verified expected output exactly.
    const rows: LobbyingFiling[] = [];
    for await (const row of store.iterate(DATASETS["lobbying-filings"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<LobbyingFiling[]>("lda", "case-filings-2026", "expected.json"),
    );

    // Watermark lands on the max posted date; fingerprint recorded.
    expect(await store.getWatermark("lda", "lda.lastPostedDate")).toBe("2026-07-24");
    expect(await store.getFingerprint("lda", "lda.filing-row-fields")).toBeTruthy();

    // Re-running re-walks the trailing week and duplicates nothing.
    const second = await ldaSource.sync(ctx);
    expect(second.rowsUpserted).toBe(5);
    expect(await store.count("lobbying-filings")).toBe(5);

    await store.close();
  });

  it("sends the registered key as an Authorization: Token header", async () => {
    const { ctx, store, captured } = await makeCtx({ ldaApiKey: "test-key-123" });
    await ldaSource.sync(ctx);
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.authorization).toBe("Token test-key-123");
    }
    await store.close();
  });

  it("stops paging once a whole page is older than the incremental window", async () => {
    const { ctx, store, captured } = await makeCtx();
    // since = watermark - 7 = 2026-07-23; page 1's oldest row (2026-07-21)
    // is already past it, so page 2 must never be requested.
    await store.setWatermark("lda", "lda.lastPostedDate", "2026-07-30");
    const result = await ldaSource.sync(ctx);
    expect(result.rowsUpserted).toBe(3);
    expect(captured).toHaveLength(1);
    // The watermark never moves backwards.
    expect(await store.getWatermark("lda", "lda.lastPostedDate")).toBe("2026-07-30");
    await store.close();
  });

  it("walks the previous filing year too in January", async () => {
    const { ctx, store, captured } = await makeCtx({}, "2026-01-10T12:00:00.000Z");
    await ldaSource.sync(ctx);
    expect(captured.map((r) => `${r.filingYear}:${r.page}`)).toEqual([
      "2025:1",
      "2026:1",
      "2026:2",
    ]);
    await store.close();
  });

  it("honors --limit without advancing the watermark", async () => {
    const { ctx, store } = await makeCtx();
    const result = await ldaSource.sync(ctx, { limit: 3 });
    expect(result.rowsUpserted).toBe(3);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.getWatermark("lda", "lda.lastPostedDate")).toBeNull();
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await ldaSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });
});

describe("ldaSource.canary", () => {
  it("goes green when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await ldaSource.sync(ctx);

    const outcome = await ldaSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-filings"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-lobbying-filings"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when result-row field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("lda", "lda.filing-row-fields", "somethingelse");
    const outcome = await ldaSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await ldaSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-filings");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });
});

describe("parseLdaAmount", () => {
  it("parses decimal strings, keeps explicit zeros, and nulls the rest", () => {
    expect(parseLdaAmount("230000.00")).toBe(230000);
    expect(parseLdaAmount("$1,250,000.00")).toBe(1250000);
    expect(parseLdaAmount("0.00")).toBe(0);
    expect(parseLdaAmount(45000)).toBe(45000);
    expect(parseLdaAmount("")).toBeNull();
    expect(parseLdaAmount("  ")).toBeNull();
    expect(parseLdaAmount(null)).toBeNull();
    expect(parseLdaAmount(undefined)).toBeNull();
    expect(parseLdaAmount("not a number")).toBeNull();
  });
});

describe("ldaFilingYears", () => {
  it("walks the current year, plus the previous one in January", () => {
    expect(ldaFilingYears(new Date("2026-08-24T12:00:00Z"))).toEqual([2026]);
    expect(ldaFilingYears(new Date("2026-01-10T12:00:00Z"))).toEqual([2025, 2026]);
    expect(ldaFilingYears(new Date("2026-02-01T00:00:00Z"))).toEqual([2026]);
  });
});
