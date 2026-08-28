import { describe, expect, it } from "vitest";
import { cftcSource, CFTC_COT_LEGACY_FUTURES_URL } from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { CotReport } from "../../schema/cot-report.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network. The mock behaves like the
 * real Socrata resource: it filters the fixture rows by the `$where`
 * report-date bounds and slices by `$limit`/`$offset`, so the sync's
 * pagination and `--until` handling are exercised against realistic
 * server behavior rather than a single canned response.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const FIXTURE_ROWS = readFixtureJson<Record<string, unknown>[]>(
  "cftc",
  "case-legacy-futures-page",
  "input.json",
);

interface CapturedRequest {
  where: string | null;
  order: string | null;
  limit: string | null;
  offset: string | null;
}

function mockFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== CFTC_COT_LEGACY_FUTURES_URL) {
      return new Response("not found", { status: 404 });
    }
    const where = url.searchParams.get("$where");
    captured.push({
      where,
      order: url.searchParams.get("$order"),
      limit: url.searchParams.get("$limit"),
      offset: url.searchParams.get("$offset"),
    });

    const startMatch = where?.match(/>=\s*'(\d{4}-\d{2}-\d{2})T/);
    const endMatch = where?.match(/<=\s*'(\d{4}-\d{2}-\d{2})T/);
    const start = startMatch?.[1] ?? "0000-01-01";
    const end = endMatch?.[1] ?? "9999-12-31";
    const filtered = FIXTURE_ROWS.filter((row) => {
      const date = String(row.report_date_as_yyyy_mm_dd).slice(0, 10);
      return date >= start && date <= end;
    });

    const offset = Number(url.searchParams.get("$offset") ?? "0");
    const limit = Number(url.searchParams.get("$limit") ?? String(filtered.length));
    const page = filtered.slice(offset, offset + limit);
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{
  ctx: SourceContext;
  store: TrackerStore;
  captured: CapturedRequest[];
}> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(NOW),
  };
  return { ctx, store, captured };
}

describe("cftcSource.sync", () => {
  it("normalizes valid rows, fails the malformed row as a whole, sets the watermark, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await cftcSource.sync(ctx, { since: "2026-08-01" });
    expect(first.parse).toEqual({ attempted: 4, succeeded: 3 });
    expect(first.rowsUpserted).toBe(3);
    expect(first.perDataset["cot-reports"]).toBe(3);
    expect(await store.count("cot-reports")).toBe(3);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.order).toBe("report_date_as_yyyy_mm_dd");
    expect(captured[0]?.limit).toBe("1000");
    expect(captured[0]?.offset).toBe("0");
    expect(captured[0]?.where).toBe(
      "report_date_as_yyyy_mm_dd >= '2026-08-01T00:00:00' AND report_date_as_yyyy_mm_dd <= '2026-08-24T00:00:00'",
    );

    // Stored rows match the hand-verified expected output exactly (the
    // malformed Silver row is absent).
    const rows: CotReport[] = [];
    for await (const row of store.iterate(DATASETS["cot-reports"])) rows.push(row);
    expect(rows).toEqual(
      readFixtureJson<CotReport[]>("cftc", "case-legacy-futures-page", "expected.json"),
    );

    // Watermark lands on the max report date across succeeded rows; fingerprint recorded.
    expect(await store.getWatermark("cftc", "cot.lastReportDate")).toBe("2026-08-12");
    expect(await store.getFingerprint("cftc", "cot.row-fields")).toBeTruthy();

    // Re-running the same window duplicates nothing.
    const second = await cftcSource.sync(ctx, { since: "2026-08-01" });
    expect(second.rowsUpserted).toBe(3);
    expect(await store.count("cot-reports")).toBe(3);

    await store.close();
  });

  it("honors the until bound: later report dates never enter the run, and the watermark is capped", async () => {
    const { ctx, store, captured } = await makeCtx();

    const result = await cftcSource.sync(ctx, { since: "2026-08-01", until: "2026-08-08" });
    // Only the 2026-08-05 report date (Crude Oil + Natural Gas) is in bounds;
    // Gold and the malformed Silver row (2026-08-12) never reach the run.
    expect(result.parse).toEqual({ attempted: 2, succeeded: 2 });
    expect(result.rowsUpserted).toBe(2);
    expect(captured[0]?.where).toBe(
      "report_date_as_yyyy_mm_dd >= '2026-08-01T00:00:00' AND report_date_as_yyyy_mm_dd <= '2026-08-08T00:00:00'",
    );
    expect(await store.getWatermark("cftc", "cot.lastReportDate")).toBe("2026-08-05");

    await store.close();
  });

  it("honors --limit without advancing the watermark", async () => {
    const { ctx, store } = await makeCtx();
    const result = await cftcSource.sync(ctx, { since: "2026-08-01", limit: 2 });
    expect(result.rowsUpserted).toBe(2);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.getWatermark("cftc", "cot.lastReportDate")).toBeNull();
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await cftcSource.sync(ctx, {
      since: "2026-08-01",
      datasets: ["fda-approvals"],
    });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });
});

describe("cftcSource.canary", () => {
  it("goes green when the probe fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await cftcSource.sync(ctx, { since: "2026-08-01" });

    const outcome = await cftcSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-cot"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-cot-reports"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when result-row field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("cftc", "cot.row-fields", "somethingelse");
    const outcome = await cftcSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await cftcSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-cot");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });
});

describe("readFixture sanity", () => {
  it("input.json and expected.json line up with the documented stats", () => {
    const meta = readFixtureJson<{ expectedStats: { attempted: number; succeeded: number } }>(
      "cftc",
      "case-legacy-futures-page",
      "meta.json",
    );
    expect(meta.expectedStats).toEqual({ attempted: 4, succeeded: 3 });
    expect(FIXTURE_ROWS).toHaveLength(4);
    expect(readFixture("cftc", "case-legacy-futures-page", "expected.json")).toBeTruthy();
  });
});
