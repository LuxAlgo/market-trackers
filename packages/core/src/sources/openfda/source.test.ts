import { describe, expect, it } from "vitest";
import { openfdaSource, OPENFDA_DRUGSFDA_URL } from "./source.js";
import { OPENFDA_SKIP_CEILING, splitDateWindow, statusDateRangeSearch } from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { FdaApproval } from "../../schema/fda-approval.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network. The mock slices the fixture
 * applications by the requested `skip`/`limit` (real paging behavior) but,
 * like the live nested-field search it stands in for, does not itself
 * filter applications by the `search` window — every returned application
 * can carry submissions outside the window that was searched, so the sync's
 * own per-submission window check is what the tests are really exercising.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const FIXTURE = readFixtureJson<{ results: Record<string, unknown>[] }>(
  "openfda",
  "case-drugsfda-page",
  "input.json",
);
const ALL_APPS = FIXTURE.results;

interface CapturedRequest {
  search: string | null;
  skip: string | null;
  limit: string | null;
  apiKey: string | null;
}

function mockFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== OPENFDA_DRUGSFDA_URL) {
      return new Response("not found", { status: 404 });
    }
    captured.push({
      search: url.searchParams.get("search"),
      skip: url.searchParams.get("skip"),
      limit: url.searchParams.get("limit"),
      apiKey: url.searchParams.get("api_key"),
    });
    const skip = Number(url.searchParams.get("skip") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const page = ALL_APPS.slice(skip, skip + limit);
    const body = {
      meta: { results: { skip, limit, total: ALL_APPS.length } },
      results: page,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
): Promise<{ ctx: SourceContext; store: TrackerStore; captured: CapturedRequest[] }> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(NOW),
  };
  return { ctx, store, captured };
}

describe("openfdaSource.sync", () => {
  it("normalizes in-window submissions, skips out-of-window siblings, fails a missing status date, sets the watermark, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await openfdaSource.sync(ctx, { since: "2026-08-01" });
    expect(first.parse).toEqual({ attempted: 6, succeeded: 5 });
    expect(first.rowsUpserted).toBe(5);
    expect(first.perDataset["fda-approvals"]).toBe(5);
    expect(await store.count("fda-approvals")).toBe(5);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      search: "submissions.submission_status_date:[20260801 TO 20260824]",
      skip: "0",
      limit: "100",
      apiKey: null,
    });

    // Stored rows match the hand-verified expected output exactly (id order).
    const rows: FdaApproval[] = [];
    for await (const row of store.iterate(DATASETS["fda-approvals"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<FdaApproval[]>("openfda", "case-drugsfda-page", "expected.json"),
    );

    // Watermark lands on the max status date across succeeded rows; fingerprint recorded.
    expect(await store.getWatermark("openfda", "openfda.lastStatusDate")).toBe("2026-08-20");
    expect(await store.getFingerprint("openfda", "openfda.application-row-fields")).toBeTruthy();

    // Re-running the same window duplicates nothing.
    const second = await openfdaSource.sync(ctx, { since: "2026-08-01" });
    expect(second.rowsUpserted).toBe(5);
    expect(await store.count("fda-approvals")).toBe(5);

    await store.close();
  });

  it("honors the until bound: a later sibling submission is excluded and the watermark is capped", async () => {
    const { ctx, store, captured } = await makeCtx();

    const result = await openfdaSource.sync(ctx, { since: "2026-08-01", until: "2026-08-15" });
    // NDA099887:SUPPL:3 (2026-08-20) falls after `until` and is dropped; its
    // sibling missing a status date still fails regardless of the bound.
    expect(result.parse).toEqual({ attempted: 5, succeeded: 4 });
    expect(result.rowsUpserted).toBe(4);
    expect(captured[0]?.search).toBe("submissions.submission_status_date:[20260801 TO 20260815]");

    const rows: FdaApproval[] = [];
    for await (const row of store.iterate(DATASETS["fda-approvals"])) rows.push(row);
    expect(rows.map((r) => r.id)).not.toContain("NDA099887:SUPPL:3");

    expect(await store.getWatermark("openfda", "openfda.lastStatusDate")).toBe("2026-08-08");

    await store.close();
  });

  it("attaches api_key as a query param when configured", async () => {
    const { ctx, captured, store } = await makeCtx({ openfdaApiKey: "test-key-123" });
    await openfdaSource.sync(ctx, { since: "2026-08-01" });
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.apiKey).toBe("test-key-123");
    }
    await store.close();
  });

  it("honors --limit (applications fetched) without advancing the watermark", async () => {
    const { ctx, store } = await makeCtx();
    // Two applications: NDA021436 (1 in-window row) and NDA021555 (1
    // in-window row; its 2025 submission is silently out-of-window).
    const result = await openfdaSource.sync(ctx, { since: "2026-08-01", limit: 2 });
    expect(result.rowsUpserted).toBe(2);
    expect(result.parse).toEqual({ attempted: 2, succeeded: 2 });
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.getWatermark("openfda", "openfda.lastStatusDate")).toBeNull();
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await openfdaSource.sync(ctx, {
      since: "2026-08-01",
      datasets: ["cot-reports"],
    });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });

  it("resolves a sponsor through the SEC-name fallback, seeded in cik_tickers before the sync runs", async () => {
    const { ctx, store } = await makeCtx();
    // A name the curated map has no entry for at all — only the SEC tier,
    // seeded directly into this store, can resolve it.
    await store.replaceCikTickers([
      { cik: "0000000987", ticker: "HVBI", name: "Harborview Biotherapeutics Inc" },
    ]);
    ctx.fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          meta: { results: { skip: 0, limit: 100, total: 1 } },
          results: [
            {
              application_number: "NDA555001",
              sponsor_name: "HARBORVIEW BIOTHERAPEUTICS, INC.",
              submissions: [
                {
                  submission_type: "ORIG",
                  submission_number: "1",
                  submission_status: "AP",
                  submission_status_date: "20260805",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const result = await openfdaSource.sync(ctx, { since: "2026-08-01" });
    expect(result.rowsUpserted).toBe(1);
    const rows: FdaApproval[] = [];
    for await (const row of store.iterate(DATASETS["fda-approvals"])) rows.push(row);
    expect(rows[0]?.sponsor).toEqual({
      name: "HARBORVIEW BIOTHERAPEUTICS, INC.",
      tickers: ["HVBI"],
    });
    await store.close();
  });
});

describe("openfdaSource.sync — skip-ceiling narrowing", () => {
  it("bisects a date window whose total exceeds the ceiling instead of paging past it", async () => {
    const WIDE_START = "2026-01-01";
    const WIDE_END = "2026-01-10";
    const halves = splitDateWindow(WIDE_START, WIDE_END);
    expect(halves).not.toBeNull();
    const [[leftStart, leftEnd], [rightStart, rightEnd]] = halves as [
      [string, string],
      [string, string],
    ];

    const minimalApp = (applicationNumber: string, statusDate: string) => ({
      application_number: applicationNumber,
      sponsor_name: "EXAMPLE BIOSCIENCES INC",
      submissions: [
        {
          submission_type: "ORIG",
          submission_number: "1",
          submission_status: "AP",
          submission_status_date: statusDate.replaceAll("-", ""),
        },
      ],
    });

    const requestedSearches: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const search = url.searchParams.get("search") ?? "";
      requestedSearches.push(search);
      if (search === statusDateRangeSearch(WIDE_START, WIDE_END)) {
        return new Response(
          JSON.stringify({
            meta: { results: { skip: 0, limit: 100, total: OPENFDA_SKIP_CEILING + 1 } },
            results: [minimalApp("NDA000001", WIDE_START)],
          }),
          { status: 200 },
        );
      }
      if (search === statusDateRangeSearch(leftStart, leftEnd)) {
        return new Response(
          JSON.stringify({
            meta: { results: { skip: 0, limit: 100, total: 1 } },
            results: [minimalApp("NDA000002", leftEnd)],
          }),
          { status: 200 },
        );
      }
      if (search === statusDateRangeSearch(rightStart, rightEnd)) {
        return new Response(
          JSON.stringify({
            meta: { results: { skip: 0, limit: 100, total: 1 } },
            results: [minimalApp("NDA000003", rightStart)],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const store = await TrackerStore.open(":memory:");
    const ctx: SourceContext = {
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
      fetchImpl,
      now: () => new Date(NOW),
    };

    const result = await openfdaSource.sync(ctx, { since: WIDE_START, until: WIDE_END });

    // The wide window is never paged past skip=0 — its over-ceiling total
    // sends the walk straight to the two halves, oldest first.
    expect(requestedSearches).toEqual([
      statusDateRangeSearch(WIDE_START, WIDE_END),
      statusDateRangeSearch(leftStart, leftEnd),
      statusDateRangeSearch(rightStart, rightEnd),
    ]);
    expect(result.rowsUpserted).toBe(2);
    expect(await store.count("fda-approvals")).toBe(2);

    await store.close();
  });
});

describe("splitDateWindow", () => {
  it("bisects a multi-day window into two non-overlapping halves", () => {
    expect(splitDateWindow("2026-01-01", "2026-01-10")).toEqual([
      ["2026-01-01", "2026-01-04"],
      ["2026-01-05", "2026-01-10"],
    ]);
  });

  it("refuses to split a window with no room (0 or 1 day of span)", () => {
    expect(splitDateWindow("2026-01-01", "2026-01-01")).toBeNull();
    expect(splitDateWindow("2026-01-01", "2026-01-02")).toBeNull();
  });
});

describe("openfdaSource.canary", () => {
  it("goes green when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await openfdaSource.sync(ctx, { since: "2026-08-01" });

    const outcome = await openfdaSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-drugsfda"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-fda-approvals"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when result-row field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("openfda", "openfda.application-row-fields", "somethingelse");
    const outcome = await openfdaSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await openfdaSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-drugsfda");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });
});

describe("readFixture sanity", () => {
  it("input.json and expected.json line up with the documented stats", () => {
    const meta = readFixtureJson<{ expectedStats: { attempted: number; succeeded: number } }>(
      "openfda",
      "case-drugsfda-page",
      "meta.json",
    );
    expect(meta.expectedStats).toEqual({ attempted: 6, succeeded: 5 });
    expect(ALL_APPS).toHaveLength(4);
    expect(readFixture("openfda", "case-drugsfda-page", "expected.json")).toBeTruthy();
  });
});
