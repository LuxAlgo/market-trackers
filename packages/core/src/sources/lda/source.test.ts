import { describe, expect, it } from "vitest";
import { ldaSource, ldaFilingYears, BACKFILL_CURSOR_KEY, LDA_FILINGS_URL } from "./source.js";
import { parseLdaAmount } from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { LobbyingFiling } from "../../schema/lobbying-filing.js";
import { TrackerStore } from "../../store/store.js";
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
): Promise<{ ctx: SourceContext; store: TrackerStore; captured: CapturedRequest[] }> {
  const store = await TrackerStore.open(":memory:");
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
  it("resolves a client through the SEC-name fallback, seeded in cik_tickers before the sync", async () => {
    const { ctx, store } = await makeCtx();
    // "Riverbend Water Utilities Association" has no curated-map entry; only
    // the SEC tier, seeded directly into this store, can resolve it.
    await store.replaceCikTickers([
      { cik: "0000000456", ticker: "RWUA", name: "Riverbend Water Utilities Association" },
    ]);

    await ldaSource.sync(ctx);
    const rows: LobbyingFiling[] = [];
    for await (const row of store.iterate(DATASETS["lobbying-filings"])) rows.push(row);
    expect(
      rows.find((r) => r.client.name === "Riverbend Water Utilities Association")?.client.tickers,
    ).toEqual(["RWUA"]);
    // Curated-map hits are unaffected, and unmapped clients still store [].
    expect(
      rows.find((r) => r.client.name === "Lockheed Martin Corporation")?.client.tickers,
    ).toEqual(["LMT"]);
    expect(
      rows.find((r) => r.client.name === "Prairie Community Health Alliance")?.client.tickers,
    ).toEqual([]);
    await store.close();
  });

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

/**
 * Backfill-path tests: `opts.until` routes to the year walker. The mock
 * serves synthetic pages keyed by `${filing_year}:${page}`; a year's last
 * page answers `next: null`. Requests for unmapped keys return HTTP 400 —
 * not a retry status, so the polite fetch surfaces it immediately, which
 * both keeps tests instant and doubles as the upstream-failure fixture.
 */
function backfillRow(year: number, uuid: string, posted: string): Record<string, unknown> {
  return {
    filing_uuid: uuid,
    filing_year: year,
    filing_period: "year_end",
    filing_type: "YE",
    income: "10000.00",
    expenses: null,
    registrant: { name: `Registrant ${uuid}` },
    client: { name: `Client ${uuid}` },
    lobbying_activities: [],
    filing_document_url: `https://example.test/${uuid}.pdf`,
    dt_posted: `${posted}T12:00:00-04:00`,
  };
}

function backfillPage(rows: Record<string, unknown>[], last: boolean): string {
  return JSON.stringify({
    count: rows.length,
    next: last ? null : "https://lda.senate.gov/api/v1/filings/?page=next",
    previous: null,
    results: rows,
  });
}

function mockBackfillFetch(
  pages: Record<string, string>,
  captured: string[],
  onFetch?: () => void,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    const key = `${url.searchParams.get("filing_year")}:${url.searchParams.get("page")}`;
    captured.push(key);
    onFetch?.();
    const body = pages[key];
    if (body === undefined) return new Response("bad request", { status: 400 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe("ldaSource.sync (backfill)", () => {
  it("walks the window's filing years, not the current one, and banks year-granular progress", async () => {
    const { ctx, store } = await makeCtx();
    const captured: string[] = [];
    ctx.fetchImpl = mockBackfillFetch(
      {
        "2003:1": backfillPage(
          [backfillRow(2003, "a-1", "2003-02-14"), backfillRow(2003, "a-2", "2003-02-15")],
          false,
        ),
        "2003:2": backfillPage([backfillRow(2003, "a-3", "2003-03-01")], true),
      },
      captured,
    );

    const result = await ldaSource.sync(ctx, { since: "2003-01-10", until: "2003-02-08" });

    // Only the chunk's year is fetched — never the clock's year (2026).
    expect(captured).toEqual(["2003:1", "2003:2"]);
    expect(result.rowsUpserted).toBe(3);
    expect(result.stoppedEarly).toBeUndefined();
    // The whole filing year is covered, reported past the chunk's end.
    expect(result.completedThrough).toBe("2003-12-31");
    expect(await store.getWatermark("lda", BACKFILL_CURSOR_KEY)).toBe(
      JSON.stringify({ year: 2004, page: 1 }),
    );
    // The daily posted-date watermark is untouched by historical walks.
    expect(await store.getWatermark("lda", "lda.lastPostedDate")).toBeNull();
    await store.close();
  });

  it("walks multiple years ascending and caps the current year at today", async () => {
    const { ctx, store } = await makeCtx(); // NOW is 2026-08-24
    const captured: string[] = [];
    ctx.fetchImpl = mockBackfillFetch(
      {
        "2025:1": backfillPage([backfillRow(2025, "b-1", "2025-04-21")], true),
        "2026:1": backfillPage([backfillRow(2026, "b-2", "2026-04-20")], true),
      },
      captured,
    );

    const result = await ldaSource.sync(ctx, { since: "2025-01-01", until: "2026-08-24" });

    expect(captured).toEqual(["2025:1", "2026:1"]);
    expect(result.stoppedEarly).toBeUndefined();
    // The current year keeps posting — coverage is claimed only through today.
    expect(result.completedThrough).toBe("2026-08-24");
    await store.close();
  });

  it("stops at the deadline between years, banking completed years and the cursor", async () => {
    const { ctx, store } = await makeCtx();
    let nowMs = Date.parse(NOW);
    ctx.now = () => new Date(nowMs);
    const captured: string[] = [];
    ctx.fetchImpl = mockBackfillFetch(
      { "1999:1": backfillPage([backfillRow(1999, "c-1", "1999-08-02")], true) },
      captured,
      () => {
        nowMs += 10 * 60_000; // each fetch burns ten minutes
      },
    );

    const result = await ldaSource.sync(ctx, {
      since: "1999-01-01",
      until: "2001-12-31",
      deadlineMs: Date.parse(NOW) + 60_000,
    });

    expect(captured).toEqual(["1999:1"]);
    expect(result.stoppedEarly).toBe("deadline");
    expect(result.completedThrough).toBe("1999-12-31");
    expect(result.notes.join(" ")).toContain("filing year 2000");
    expect(await store.getWatermark("lda", BACKFILL_CURSOR_KEY)).toBe(
      JSON.stringify({ year: 2000, page: 1 }),
    );
    await store.close();
  });

  it("stops on exhausted upstream retries with the cursor still naming the failed page", async () => {
    const { ctx, store } = await makeCtx();
    const captured: string[] = [];
    // 1999 walks clean; 2000 page 1 is unmapped and answers 400.
    ctx.fetchImpl = mockBackfillFetch(
      { "1999:1": backfillPage([backfillRow(1999, "d-1", "1999-08-02")], true) },
      captured,
    );

    const result = await ldaSource.sync(ctx, { since: "1999-01-01", until: "2000-12-31" });

    expect(captured).toEqual(["1999:1", "2000:1"]);
    expect(result.stoppedEarly).toBe("upstream");
    expect(result.completedThrough).toBe("1999-12-31");
    expect(result.notes.join(" ")).toContain("400");
    expect(await store.getWatermark("lda", BACKFILL_CURSOR_KEY)).toBe(
      JSON.stringify({ year: 2000, page: 1 }),
    );
    await store.close();
  });

  it("resumes mid-year from the persisted cursor, skipping covered years and pages", async () => {
    const { ctx, store } = await makeCtx();
    await store.setWatermark("lda", BACKFILL_CURSOR_KEY, JSON.stringify({ year: 2000, page: 2 }));
    const captured: string[] = [];
    ctx.fetchImpl = mockBackfillFetch(
      { "2000:2": backfillPage([backfillRow(2000, "e-1", "2000-08-02")], true) },
      captured,
    );

    const result = await ldaSource.sync(ctx, { since: "1999-01-01", until: "2000-12-31" });

    expect(captured).toEqual(["2000:2"]);
    expect(result.notes.join(" ")).toContain("resumed filing year 2000 at page 2");
    // Years behind the cursor count as covered ground.
    expect(result.completedThrough).toBe("2000-12-31");
    await store.close();
  });

  it("honors --limit with a structured stop and a resumable cursor", async () => {
    const { ctx, store } = await makeCtx();
    const captured: string[] = [];
    ctx.fetchImpl = mockBackfillFetch(
      {
        "2003:1": backfillPage(
          [backfillRow(2003, "f-1", "2003-02-14"), backfillRow(2003, "f-2", "2003-02-15")],
          false,
        ),
        "2003:2": backfillPage(
          [backfillRow(2003, "f-3", "2003-03-01"), backfillRow(2003, "f-4", "2003-03-02")],
          false,
        ),
        "2003:3": backfillPage([backfillRow(2003, "f-5", "2003-03-03")], true),
      },
      captured,
    );

    const result = await ldaSource.sync(ctx, {
      since: "2003-01-01",
      until: "2003-12-31",
      limit: 3,
    });

    expect(captured).toEqual(["2003:1", "2003:2"]);
    expect(result.stoppedEarly).toBe("limit");
    // No year completed, so no date is claimed; the cursor carries the resume.
    expect(result.completedThrough).toBeNull();
    expect(await store.getWatermark("lda", BACKFILL_CURSOR_KEY)).toBe(
      JSON.stringify({ year: 2003, page: 3 }),
    );
    await store.close();
  });

  it("trips the format-drift tripwire on an all-failing era instead of skipping it", async () => {
    const { ctx, store } = await makeCtx();
    const rows = Array.from({ length: 120 }, (_, i) => ({
      ...backfillRow(2003, `g-${i}`, "2003-02-14"),
      registrant: { name: "" }, // fails the schema's non-empty requirement
    }));
    ctx.fetchImpl = mockBackfillFetch({ "2003:1": backfillPage(rows, true) }, []);

    await expect(
      ldaSource.sync(ctx, { since: "2003-01-01", until: "2003-12-31" }),
    ).rejects.toThrow(/format-drift tripwire/);
    // Thrown before the cursor advanced — the ground is re-walked, loudly.
    expect(await store.getWatermark("lda", BACKFILL_CURSOR_KEY)).toBeNull();
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
