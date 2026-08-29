import { describe, expect, it } from "vitest";
import { edgarSource, indexFingerprintLines, THIRTEENF_XML_SINCE } from "./source.js";
import { COMPANY_TICKERS_URL } from "./client.js";
import { TrackerStore } from "../../store/store.js";
import { DATASETS } from "../../schema/datasets.js";
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
): Promise<{ ctx: SourceContext; store: TrackerStore }> {
  const store = await TrackerStore.open(":memory:");
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

    // The cached CUSIP resolved; the uncached one is what `market-trackers resolve cusips` would pick up.
    expect(await store.distinctUnresolvedCusips()).toEqual(["79589L106"]);

    // Idempotent re-walk: same rows, no dupes.
    const again = await edgarSource.sync(ctx, { since: FIXTURE_DAY });
    expect(again.rowsUpserted).toBe(7);
    expect(await store.count("insider-transactions")).toBe(4);
    expect(await store.count("thirteenf-holdings")).toBe(3);
    await store.close();
  });

  it("honors --until: never requests a day past it, even though today is later", async () => {
    const { fetchImpl, requests } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl); // "today" is pinned to 2026-08-21

    const result = await edgarSource.sync(ctx, { since: FIXTURE_DAY, until: FIXTURE_DAY });
    expect(result.rowsUpserted).toBe(7);
    // Today's index (2026-08-21) is never requested — the walk stopped at --until.
    expect(requests.some((r) => r.url.includes("master.20260821.idx"))).toBe(false);
    expect(await store.getWatermark("edgar", "daily-index.lastCompletedDay")).toBe(FIXTURE_DAY);
    await store.close();
  });

  // Regression for the 2004-era zero-ingest shift: the old index format's
  // YYYYMMDD dates must land on rows as dashed filedAt (or every filing
  // fails schema validation), and pre-XML 13F filings must be skipped
  // without a fetch instead of burning budget on guaranteed parse failures.
  it("ingests an old-era (2004) day: dates normalized, pre-XML 13F skipped unfetched", async () => {
    const OLD_DAY_INDEX = [
      "Description:           Master Index of EDGAR Dissemination Feed",
      "-------------------",
      "123456|EXAMPLECORP INC|4|20040211|edgar/data/123456/0001127602-26-019876.txt",
      "9876543|EXAMPLE FUND MGMT|13F-HR|20040211|edgar/data/9876543/0009876543-04-000002.txt",
    ].join("\n");
    const requests: string[] = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      const key = String(url);
      requests.push(key);
      if (key.endsWith("/2004/QTR1/master.20040211.idx")) {
        return new Response(OLD_DAY_INDEX, { status: 200 });
      }
      if (key === COMPANY_TICKERS_URL) {
        return new Response(COMPANY_TICKERS_BODY, { status: 200 });
      }
      if (key.endsWith("0001127602-26-019876.txt")) {
        return new Response(
          readFixture("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const { ctx, store } = await makeCtx(fetchImpl);

    const result = await edgarSource.sync(ctx, { since: "2004-02-11", until: "2004-02-11" });

    // The ownership filing parses and its rows carry the normalized date.
    expect(result.parse).toEqual({ attempted: 1, succeeded: 1 });
    expect(result.perDataset["insider-transactions"]).toBe(3);
    const anyRow = (await store.count("insider-transactions")) > 0;
    expect(anyRow).toBe(true);
    for await (const row of store.iterate(DATASETS["insider-transactions"])) {
      expect(row.filedAt).toBe("2004-02-11");
    }

    // The pre-XML 13F was never even requested, and the run says why.
    expect(requests.some((u) => u.includes("0009876543-04-000002"))).toBe(false);
    expect(result.notes.some((n) => n.includes(`pre-${THIRTEENF_XML_SINCE} 13F`))).toBe(true);
    await store.close();
  });

  // Regression for the hard-cap deaths: the walk must stop ITSELF at
  // opts.deadlineMs — between days and between filings — reporting the last
  // day it fully covered, so the backfill engine banks day-granular progress
  // and the CI job's kill margin is never overrun by one heavy chunk.
  it("stops cleanly at the deadline mid-walk: prior day banked, current day's filings left unfetched", async () => {
    const T0 = Date.parse("2004-02-13T00:00:00Z");
    const DEADLINE = T0 + 60_000;
    let clock = T0;
    const indexFor = (yyyymmdd: string, accession: string) =>
      [
        "Description:           Master Index of EDGAR Dissemination Feed",
        "-------------------",
        `123456|EXAMPLECORP INC|4|${yyyymmdd}|edgar/data/123456/${accession}.txt`,
      ].join("\n");
    const requests: string[] = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      const key = String(url);
      requests.push(key);
      if (key === COMPANY_TICKERS_URL) return new Response(COMPANY_TICKERS_BODY, { status: 200 });
      if (key.endsWith("/2004/QTR1/master.20040211.idx")) {
        return new Response(indexFor("20040211", "0001127602-26-019876"), { status: 200 });
      }
      if (key.endsWith("/2004/QTR1/master.20040212.idx")) {
        // Day 2's index arrives AFTER the budget ran out.
        clock = DEADLINE + 1;
        return new Response(indexFor("20040212", "0001127602-26-019877"), { status: 200 });
      }
      if (key.endsWith("0001127602-26-019876.txt")) {
        return new Response(
          readFixture("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const { ctx, store } = await makeCtx(fetchImpl);
    ctx.now = () => new Date(clock);

    const result = await edgarSource.sync(ctx, {
      since: "2004-02-11",
      until: "2004-02-12",
      deadlineMs: DEADLINE,
    });

    expect(result.stoppedEarly).toBe("deadline");
    expect(result.completedThrough).toBe("2004-02-11");
    expect(result.notes.some((n) => n.includes("time budget"))).toBe(true);
    // Day 1 landed in full; day 2's filing was never even requested.
    expect(result.perDataset["insider-transactions"]).toBe(3);
    expect(requests.some((u) => u.includes("master.20040212.idx"))).toBe(true);
    expect(requests.some((u) => u.includes("0001127602-26-019877"))).toBe(false);
    await store.close();
  });

  it("reports a mid-day --limit stop as stoppedEarly, not as covered ground", async () => {
    const { fetchImpl } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl);

    // The fixture day has 3 filings; a limit of 1 stops inside the day.
    const result = await edgarSource.sync(ctx, {
      since: FIXTURE_DAY,
      until: FIXTURE_DAY,
      limit: 1,
    });

    expect(result.stoppedEarly).toBe("limit");
    expect(result.completedThrough).toBeNull();
    expect(result.notes.some((n) => n.includes("--limit"))).toBe(true);
    await store.close();
  });

  // Regression for the burned publish-store days: a parser bug made every
  // filing on a day fail validation, and the walk still advanced the live
  // watermark past those days — silently disowning them forever.
  it("trips the zero-parse guard instead of advancing past a day of all-failing parses", async () => {
    const entries = Array.from(
      { length: 12 },
      (_, i) =>
        `123456|EXAMPLECORP INC|4|20040211|edgar/data/123456/0001127602-04-${String(100 + i)}000.txt`,
    );
    const OLD_DAY_INDEX = [
      "Description:           Master Index of EDGAR Dissemination Feed",
      "-------------------",
      ...entries,
    ].join("\n");
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      const key = String(url);
      if (key.endsWith("/2004/QTR1/master.20040211.idx")) {
        return new Response(OLD_DAY_INDEX, { status: 200 });
      }
      if (key === COMPANY_TICKERS_URL) {
        return new Response(COMPANY_TICKERS_BODY, { status: 200 });
      }
      if (key.endsWith(".txt")) {
        return new Response("not a filing at all", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const { ctx, store } = await makeCtx(fetchImpl);

    await expect(
      edgarSource.sync(ctx, { since: "2004-02-11", until: "2004-02-11" }),
    ).rejects.toThrow(/format-drift tripwire/);
    expect(await store.getWatermark("edgar", "daily-index.lastCompletedDay")).toBeNull();
    await store.close();
  });

  it("a bounded backfill chunk over old ground never regresses an already-advanced watermark", async () => {
    const { fetchImpl } = mockEdgarFetch();
    const { ctx, store } = await makeCtx(fetchImpl);
    // Simulate a live watermark that has already moved well past the fixture
    // day (as it would after months of regular incremental syncs).
    await store.setWatermark("edgar", "daily-index.lastCompletedDay", "2026-08-25");

    await edgarSource.sync(ctx, { since: FIXTURE_DAY, until: FIXTURE_DAY });
    expect(await store.getWatermark("edgar", "daily-index.lastCompletedDay")).toBe("2026-08-25");
    await store.close();
  });
});

describe("indexFingerprintLines", () => {
  // Regression: the preamble's "Last Data Received: <date>" line changes
  // every day; fingerprinting it made the drift canary permanently red.
  it("is stable across days but still catches real format drift", () => {
    const monday = [
      "Description:           Daily Index of the EDGAR Dissemination Feed",
      "Last Data Received:    August 25, 2026",
      "Comments:              webmaster@sec.gov",
      "CIK|Company Name|Form Type|Date Filed|File Name",
    ];
    const tuesday = [...monday];
    tuesday[1] = "Last Data Received:    August 26, 2026";
    expect(indexFingerprintLines(monday)).toEqual(indexFingerprintLines(tuesday));

    const drifted = [...monday];
    drifted[3] = "CIK|Company Name|Form Type|Date Filed|Accession Number|File Name";
    expect(indexFingerprintLines(drifted)).not.toEqual(indexFingerprintLines(monday));
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
