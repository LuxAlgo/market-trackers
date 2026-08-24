import { describe, expect, it } from "vitest";
import { edgarSource } from "./source.js";
import { COMPANY_TICKERS_URL } from "./client.js";
import { DocketStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end EDGAR source tests with a fully mocked network. The daily-index
 * fixture references the ownership/13F fixture accessions, so one synthetic
 * EDGAR day round-trips: index walk → full-submission fetches → parsers →
 * store, plus the canary probes.
 */

const FIXTURE_DAY = "2026-08-20";
const COMPANY_TICKERS_BODY = JSON.stringify({
  "0": { cik_str: 123456, ticker: "EXCO", title: "EXAMPLECORP INC" },
});

/** Serves the fixture EDGAR day; everything unknown 404s. */
function mockEdgarFetch(options: { companyTickersStatus?: number } = {}): {
  fetchImpl: typeof fetch;
  requests: { url: string; method: string }[];
} {
  const requests: { url: string; method: string }[] = [];
  const byUrl: Record<string, () => Response> = {
    [`https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/master.20260820.idx`]: () =>
      new Response(readFixture("edgar-daily-index", "master-sample.idx"), { status: 200 }),
    [`https://www.sec.gov/Archives/edgar/data/123456/0001127602-26-019876.txt`]: () =>
      new Response(
        readFixture("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
      ),
    [`https://www.sec.gov/Archives/edgar/data/123456/0000123456-26-000031.txt`]: () =>
      new Response(readFixture("edgar-form-ownership", "case-form3-initial-holdings", "input.txt")),
    [`https://www.sec.gov/Archives/edgar/data/9876543/0009876543-26-000002.txt`]: () =>
      new Response(readFixture("edgar-thirteenf", "case-13f-2026", "input.txt")),
  };
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const key = String(url);
    requests.push({ url: key, method: init?.method ?? "GET" });
    if (key === COMPANY_TICKERS_URL) {
      const status = options.companyTickersStatus ?? 200;
      if (status !== 200) return new Response("blocked", { status });
      return new Response(COMPANY_TICKERS_BODY, {
        status: 200,
        headers: { etag: '"tickers-v1"' },
      });
    }
    const hit = byUrl[key];
    return hit ? hit() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function makeCtx(
  fetchImpl: typeof fetch,
  overrides: { contactEmail?: string } = { contactEmail: "test@example.com" },
): Promise<{ ctx: SourceContext; store: DocketStore }> {
  const store = await DocketStore.open(":memory:");
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl,
    // The day after the fixture day: today's index is probed but 404s.
    now: () => new Date("2026-08-21T12:00:00Z"),
  };
  return { ctx, store };
}

describe("edgarSource.sync", () => {
  it("walks the day, ingests ownership + 13F filings, fills tickers from caches, and sets the watermark", async () => {
    const { fetchImpl } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl);
    // Pre-resolved CUSIP: 13F rows for it must come out ticker-filled.
    await store.putCusips([
      { cusip: "30303M102", ticker: "EXCO", figi: "BBG000TEST01", name: "X", mapSource: "test" },
    ]);

    const result = await edgarSource.sync(ctx, { since: FIXTURE_DAY });
    expect(result.parse).toEqual({ attempted: 3, succeeded: 3 });
    expect(result.perDataset["insider-transactions"]).toBe(4); // form4 ×3 rows + form3 ×1
    expect(result.perDataset["thirteenf-holdings"]).toBe(3);
    expect(result.rowsUpserted).toBe(7);

    // Watermark stops at the fixture day — today's index 404s and never advances it.
    expect(await store.getWatermark("edgar", "daily-index.lastCompletedDay")).toBe(FIXTURE_DAY);

    // Conditional-GET plumbing captured the validator for the ticker map.
    expect((await store.getFetchCache(COMPANY_TICKERS_URL))?.etag).toBe('"tickers-v1"');

    // The cached CUSIP resolved; the uncached one is what `docket resolve cusips` would pick up.
    expect(await store.distinctUnresolvedCusips()).toEqual(["79589L106"]);

    // Idempotent re-walk: same rows, no dupes.
    const again = await edgarSource.sync(ctx, { since: FIXTURE_DAY });
    expect(again.rowsUpserted).toBe(7);
    expect(await store.count("insider-transactions")).toBe(4);
    expect(await store.count("thirteenf-holdings")).toBe(3);
    await store.close();
  });
});

describe("edgarSource.canary", () => {
  it("probes the daily index and the company↔ticker map (green path)", async () => {
    const { fetchImpl, requests } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl);
    // Pin "now" to the fixture day so the walk-back finds the published index.
    ctx.now = () => new Date("2026-08-20T18:00:00Z");

    const outcome = await edgarSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fetch-daily-index"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["fetch-company-tickers"]?.ok).toBe(true);
    expect(byName["fetch-company-tickers"]?.severity).toBe("hard");
    expect(requests.some((r) => r.url === COMPANY_TICKERS_URL && r.method === "HEAD")).toBe(true);
    await store.close();
  });

  it("hard-fails fetch-company-tickers when the map endpoint breaks", async () => {
    const { fetchImpl } = mockEdgarFetch({ companyTickersStatus: 404 });
    const { ctx, store } = await makeCtx(fetchImpl);
    ctx.now = () => new Date("2026-08-20T18:00:00Z");

    const outcome = await edgarSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "fetch-company-tickers");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("hard");
    expect(check?.note).toContain("404");
    await store.close();
  });

  it("without a contact email skips the fetch probes instead of hammering the SEC anonymously", async () => {
    const { fetchImpl, requests } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl, {});

    const outcome = await edgarSource.canary(ctx);
    expect(outcome.checks.some((c) => c.name === "fetch-company-tickers")).toBe(false);
    const daily = outcome.checks.find((c) => c.name === "fetch-daily-index");
    expect(daily?.ok).toBe(false);
    expect(daily?.severity).toBe("soft");
    expect(requests).toHaveLength(0);
    await store.close();
  });
});
