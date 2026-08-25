import { describe, expect, it } from "vitest";
import {
  patentsviewSource,
  normalizePatentRow,
  PATENTSVIEW_PATENT_URL,
  buildPatentDateRangeQuery,
} from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { Patent } from "../../schema/patent.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import { deriveCanaryStatus, type SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: the patent list pages
 * through two fixture responses (page 1 full, page 2 short) for a
 * grant-date range query, walked via the "after" cursor on ascending
 * patent_id. The sync must normalize every patent, resolve assignee
 * tickers, set the grant-date watermark, and be idempotent on re-runs.
 */

const NOW = "2026-08-18T12:00:00.000Z";
const LAST_PAGE_1_ID = "11800004";

interface CapturedRequest {
  q: { _and: [{ _gte: { patent_date: string } }, { _lte: { patent_date: string } }] };
  o: { size?: number; after?: string };
  apiKey: string | null;
}

function mockFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== PATENTSVIEW_PATENT_URL) {
      return new Response("not found", { status: 404 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const o = JSON.parse(url.searchParams.get("o") ?? "{}") as CapturedRequest["o"];
    captured.push({
      q: JSON.parse(url.searchParams.get("q") ?? "{}") as CapturedRequest["q"],
      o,
      apiKey: headers["x-api-key"] ?? null,
    });
    const fixture = o.after === LAST_PAGE_1_ID ? "input-page-2.json" : "input-page-1.json";
    return new Response(readFixture("patentsview", "case-weekly-grants-2026", fixture), {
      status: 200,
    });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: AltDataStore; captured: CapturedRequest[] }> {
  const store = await AltDataStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig(
      { logLevel: "silent", patentsviewApiKey: "test-key-123", ...overrides },
      { cwd: "/nonexistent", env: {} },
    ),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

async function makeCtxNoKey(
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: AltDataStore; captured: CapturedRequest[] }> {
  const store = await AltDataStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

describe("patentsviewSource.sync", () => {
  it("walks both pages via the after cursor, normalizes every patent, sets the watermark, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await patentsviewSource.sync(ctx);
    expect(first.rowsUpserted).toBe(5);
    expect(first.perDataset.patents).toBe(5);
    expect(first.parse).toEqual({ attempted: 5, succeeded: 5 });
    expect(await store.count("patents")).toBe(5);

    // Two pages: the first request carries no cursor, the second carries
    // page 1's last patent_id; the API key rides every request.
    expect(captured).toHaveLength(2);
    expect(captured[0]?.o.after).toBeUndefined();
    expect(captured[1]?.o.after).toBe(LAST_PAGE_1_ID);
    for (const request of captured) expect(request.apiKey).toBe("test-key-123");

    // Stored rows match the hand-verified expected output exactly.
    const rows: Patent[] = [];
    for await (const row of store.iterate(DATASETS.patents)) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<Patent[]>("patentsview", "case-weekly-grants-2026", "expected.json"),
    );

    // Watermark lands on the max grant date across both pages; fingerprint recorded.
    expect(await store.getWatermark("patentsview", "patentsview.lastGrantDate")).toBe("2026-08-11");
    expect(await store.getFingerprint("patentsview", "patentsview.patent-row-fields")).toBeTruthy();

    // Re-running re-walks the trailing window and duplicates nothing.
    const second = await patentsviewSource.sync(ctx);
    expect(second.rowsUpserted).toBe(5);
    expect(await store.count("patents")).toBe(5);

    await store.close();
  });

  it("falls back to the configured backfill window when there is no watermark", async () => {
    const { ctx, store, captured } = await makeCtx({ backfillDays: 3 });
    await patentsviewSource.sync(ctx);
    expect(captured[0]?.q._and[0]._gte.patent_date).toBe("2026-08-15"); // NOW - 3 days
    expect(captured[0]?.q._and[1]._lte.patent_date).toBe("2026-08-18"); // NOW
    await store.close();
  });

  it("re-walks a small trailing window before the watermark, not from scratch", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("patentsview", "patentsview.lastGrantDate", "2026-08-11");
    await patentsviewSource.sync(ctx);
    expect(captured[0]?.q._and[0]._gte.patent_date).toBe("2026-08-08"); // watermark - 3 days
    await store.close();
  });

  it("honors opts.since and opts.until, overriding the watermark and today", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("patentsview", "patentsview.lastGrantDate", "2026-08-11");
    await patentsviewSource.sync(ctx, { since: "2026-01-01", until: "2026-06-30" });
    expect(captured[0]?.q._and[0]._gte.patent_date).toBe("2026-01-01");
    expect(captured[0]?.q._and[1]._lte.patent_date).toBe("2026-06-30");
    await store.close();
  });

  it("honors --limit at page granularity, without advancing the watermark", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await patentsviewSource.sync(ctx, { limit: 3 });
    // The whole first page (4 rows) is upserted before the soft cap is checked.
    expect(result.rowsUpserted).toBe(4);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(captured).toHaveLength(1);
    expect(await store.getWatermark("patentsview", "patentsview.lastGrantDate")).toBeNull();
    await store.close();
  });

  it("respects the datasets filter without requiring a key", async () => {
    const { ctx, store, captured } = await makeCtxNoKey();
    const result = await patentsviewSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });

  it("throws a friendly, actionable error when no key is configured", async () => {
    const { ctx, store, captured } = await makeCtxNoKey();
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(
      /PatentsView requires a free API key/,
    );
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/ALT_DATA_PATENTSVIEW_KEY/);
    expect(captured).toHaveLength(0); // fails fast, before any fetch
    await store.close();
  });
});

describe("patentsviewSource.canary", () => {
  it("goes green when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await patentsviewSource.sync(ctx);

    const outcome = await patentsviewSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-patent"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-patents"]?.ok).toBe(true);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("green");
    await store.close();
  });

  it("hard-fails the fingerprint check when result-row field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("patentsview", "patentsview.patent-row-fields", "somethingelse");
    const outcome = await patentsviewSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });

  it("hard-fails the probe when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await patentsviewSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-patent");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });

  it("soft-skips the probe when no key is configured, without turning the source red", async () => {
    const { ctx, store } = await makeCtxNoKey();
    const outcome = await patentsviewSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-patent");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("soft");
    expect(probe?.note).toMatch(/no PatentsView API key configured/);
    // No hard check ran or failed: the source goes amber (missing config), never red.
    expect(outcome.checks.some((c) => c.severity === "hard")).toBe(false);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("amber");
    await store.close();
  });
});

describe("normalizePatentRow", () => {
  const RETRIEVED_AT = "2026-08-18T12:00:00.000Z";

  it("resolves the first-listed organization, skipping individual (org-less) assignees", () => {
    const patent = normalizePatentRow(
      {
        patent_id: "1",
        patent_title: "Example",
        patent_date: "2026-08-11",
        assignees: [{ assignee_organization: null }, { assignee_organization: "Boeing" }],
      },
      RETRIEVED_AT,
    );
    expect(patent.assignee).toEqual({ name: "Boeing", tickers: ["BA"] });
    expect(patent.assigneeCount).toBe(2);
  });

  it("keeps assignee.name null and assigneeCount 0 for a fully unassigned patent", () => {
    const patent = normalizePatentRow(
      { patent_id: "2", patent_title: "Example", patent_date: "2026-08-11", assignees: [] },
      RETRIEVED_AT,
    );
    expect(patent.assignee).toEqual({ name: null, tickers: [] });
    expect(patent.assigneeCount).toBe(0);
  });

  it("tolerates assignees/cpc_current being entirely absent, not just empty", () => {
    const patent = normalizePatentRow(
      { patent_id: "3", patent_title: "Example", patent_date: "2026-08-11" },
      RETRIEVED_AT,
    );
    expect(patent.assignee).toEqual({ name: null, tickers: [] });
    expect(patent.assigneeCount).toBe(0);
    expect(patent.cpcClass).toBeNull();
    expect(patent.kind).toBeNull();
  });

  it("takes the first present CPC class id and uppercases it", () => {
    const patent = normalizePatentRow(
      {
        patent_id: "4",
        patent_title: "Example",
        patent_date: "2026-08-11",
        cpc_current: [{ cpc_class_id: null }, { cpc_class_id: "g06" }],
      },
      RETRIEVED_AT,
    );
    expect(patent.cpcClass).toBe("G06");
  });

  it("builds provenance from the USPTO document URL, with confidence 1", () => {
    const patent = normalizePatentRow(
      { patent_id: "11800001", patent_title: "Example", patent_date: "2026-08-11" },
      RETRIEVED_AT,
    );
    expect(patent.provenance).toEqual({
      source: "patentsview",
      sourceUrl: "https://ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11800001",
      retrievedAt: RETRIEVED_AT,
      parser: "patentsview-api@1",
      confidence: 1,
      needsReview: false,
    });
  });

  it("throws on a missing title or an unparseable grant date", () => {
    expect(() =>
      normalizePatentRow(
        { patent_id: "5", patent_title: "", patent_date: "2026-08-11" },
        RETRIEVED_AT,
      ),
    ).toThrow();
    expect(() =>
      normalizePatentRow(
        { patent_id: "6", patent_title: "Example", patent_date: "not-a-date" },
        RETRIEVED_AT,
      ),
    ).toThrow();
  });
});

describe("buildPatentDateRangeQuery", () => {
  it("builds an inclusive _gte/_lte range on patent_date", () => {
    expect(buildPatentDateRangeQuery("2026-08-01", "2026-08-18")).toEqual({
      _and: [{ _gte: { patent_date: "2026-08-01" } }, { _lte: { patent_date: "2026-08-18" } }],
    });
  });
});
