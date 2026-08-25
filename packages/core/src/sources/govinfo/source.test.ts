import { describe, expect, it } from "vitest";
import {
  govinfoSource,
  currentCongress,
  billstatusListingUrl,
  billstatusXmlUrl,
  congressBillPageUrl,
  ordinal,
} from "./source.js";
import { BILL_TYPES } from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { Bill } from "../../schema/bill.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network, against the congress-119
 * `hr`+`s` fixture (the other 6 bill types dispatch to an empty listing).
 * Covers the full window/limit/watermark machinery: `hr` has one file
 * that fails to parse (no `<title>`), so its watermark never advances
 * while `s`'s does — exercising per-type independence the same way
 * usaspending's two award universes do.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const CONGRESS = 119;
const EMPTY_LISTING = JSON.stringify({ files: [] });
const CASE = ["govinfo", "case-billstatus-hr-and-s"];

function mockFetch(captured: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    captured.push(url);

    if (url === billstatusListingUrl(CONGRESS, "hr")) {
      return new Response(readFixture(...CASE, "listing-hr.json"), { status: 200 });
    }
    if (url === billstatusListingUrl(CONGRESS, "s")) {
      return new Response(readFixture(...CASE, "listing-s.json"), { status: 200 });
    }
    if (BILL_TYPES.some((type) => url === billstatusListingUrl(CONGRESS, type))) {
      return new Response(EMPTY_LISTING, { status: 200 });
    }
    if (url === billstatusXmlUrl(CONGRESS, "hr", 1234)) {
      return new Response(readFixture(...CASE, "BILLSTATUS-119hr1234.xml"), { status: 200 });
    }
    if (url === billstatusXmlUrl(CONGRESS, "hr", 5678)) {
      return new Response(readFixture(...CASE, "BILLSTATUS-119hr5678.xml"), { status: 200 });
    }
    if (url === billstatusXmlUrl(CONGRESS, "hr", 9999)) {
      return new Response(readFixture(...CASE, "BILLSTATUS-119hr9999.xml"), { status: 200 });
    }
    if (url === billstatusXmlUrl(CONGRESS, "s", 200)) {
      return new Response(readFixture(...CASE, "BILLSTATUS-119s200.xml"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: AltDataStore; captured: string[] }> {
  const store = await AltDataStore.open(":memory:");
  const captured: string[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

const HR_WATERMARK = "billstatus.119.hr.lastModified";
const S_WATERMARK = "billstatus.119.s.lastModified";

describe("govinfoSource.sync", () => {
  it("walks hr and s, skip-and-counts the one file with no <title>, and stores the rest", async () => {
    const { ctx, store, captured } = await makeCtx();

    const result = await govinfoSource.sync(ctx);
    expect(result.rowsUpserted).toBe(3);
    expect(result.perDataset.bills).toBe(3);
    expect(result.parse).toEqual({ attempted: 4, succeeded: 3 });
    expect(result.notes).toEqual([]);
    expect(await store.count("bills")).toBe(3);

    // One listing request per bill type (8), plus 4 real BILLSTATUS XML
    // fetches — the folder entry and the non-BILLSTATUS file name are
    // never fetched at all.
    expect(captured).toHaveLength(12);
    for (const type of BILL_TYPES) {
      expect(captured).toContain(billstatusListingUrl(CONGRESS, type));
    }
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "hr", 42));

    const rows: Bill[] = [];
    for await (const row of store.iterate(DATASETS.bills)) rows.push(row);
    expect(rows).toEqual(readFixtureJson<Bill[]>(...CASE, "expected.json"));

    // hr's walk was incomplete (BILLSTATUS-119hr9999.xml failed), so its
    // watermark must stay unset; s's walk completed, so it advances.
    expect(await store.getWatermark("govinfo", HR_WATERMARK)).toBeNull();
    expect(await store.getWatermark("govinfo", S_WATERMARK)).toBe("2026-08-01T12:00:00.000Z");
    expect(await store.getFingerprint("govinfo", "govinfo.listing-fields")).toBeTruthy();

    await store.close();
  });

  it("re-running is idempotent and keeps re-trying the file that still fails", async () => {
    const { ctx, store, captured } = await makeCtx();
    await govinfoSource.sync(ctx);
    captured.length = 0;

    const second = await govinfoSource.sync(ctx);
    // s's watermark now excludes BILLSTATUS-119s200.xml (already at the
    // watermark); hr's stayed unset, so all 3 hr files are attempted again.
    expect(second.rowsUpserted).toBe(2);
    expect(second.parse).toEqual({ attempted: 3, succeeded: 2 });
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "s", 200));
    expect(await store.count("bills")).toBe(3);

    await store.close();
  });

  it("only re-fetches hr files newer than a seeded watermark", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("govinfo", HR_WATERMARK, "2026-08-12T14:00:00.000Z");

    await govinfoSource.sync(ctx);
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "hr", 1234));
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "hr", 5678));
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "hr", 9999));

    await store.close();
  });

  it("--since overrides the watermark as an inclusive floor", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoSource.sync(ctx, { since: "2026-08-15" });

    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "hr", 1234)); // 08-12, too old
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "s", 200)); // 08-01, too old
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "hr", 5678)); // 08-20
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "hr", 9999)); // 08-22
    expect(result.parse).toEqual({ attempted: 2, succeeded: 1 });

    await store.close();
  });

  it("--until bounds the window inclusively at the end of that day", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoSource.sync(ctx, { until: "2026-08-12" });

    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "hr", 1234)); // 08-12, included
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "s", 200)); // 08-01, included
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "hr", 5678)); // 08-20, too new
    expect(captured).not.toContain(billstatusXmlUrl(CONGRESS, "hr", 9999)); // 08-22, too new
    expect(result.rowsUpserted).toBe(2);

    await store.close();
  });

  it("--full re-walks a type even past its stored watermark", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("govinfo", S_WATERMARK, "2026-08-01T12:00:00.000Z");

    await govinfoSource.sync(ctx, { full: true });
    expect(captured).toContain(billstatusXmlUrl(CONGRESS, "s", 200));

    await store.close();
  });

  it("honors a shared --limit across bill types and notes the stop", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoSource.sync(ctx, { limit: 2 });

    expect(result.rowsUpserted).toBe(2);
    expect(result.notes.join(" ")).toContain("--limit");
    // The budget is exhausted inside hr; s's listing is never even requested.
    expect(captured).not.toContain(billstatusListingUrl(CONGRESS, "s"));
    expect(await store.getWatermark("govinfo", HR_WATERMARK)).toBeNull();

    await store.close();
  });

  it("respects the datasets filter as a full no-op", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await govinfoSource.sync(ctx, { datasets: ["gov-contracts"] });

    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);

    await store.close();
  });
});

describe("govinfoSource.canary", () => {
  it("probes the hr listing and records a fingerprint baseline", async () => {
    const { ctx, store } = await makeCtx();

    const outcome = await govinfoSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-listing"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.note).toBe("baseline recorded");
    expect(byName["freshness-bills"]?.ok).toBe(false);
    expect(byName["freshness-bills"]?.note).toBe("no rows ingested yet");

    await store.close();
  });

  it("hard-fails the fingerprint check when the listing's field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("govinfo", "govinfo.listing-fields", "somethingelse");

    const outcome = await govinfoSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");

    await store.close();
  });

  it("hard-fails the listing probe when the request errors", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("boom", { status: 400 })) as typeof fetch;

    const outcome = await govinfoSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-listing");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");

    await store.close();
  });

  it("scores parse-success-rate from the last recorded sync run, not a live re-probe", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("govinfo");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 10,
      parseAttempted: 10,
      parseSucceeded: 10,
    });

    const outcome = await govinfoSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(true);
    expect(rate?.severity).toBe("hard");

    await store.close();
  });

  it("hard-fails parse-success-rate when the last sync's rate was under 99%", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("govinfo");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 5,
      parseAttempted: 10,
      parseSucceeded: 5,
    });

    const outcome = await govinfoSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(false);
    expect(rate?.severity).toBe("hard");

    await store.close();
  });

  it("goes freshness-green once bills have actually been ingested", async () => {
    const { ctx, store } = await makeCtx();
    await govinfoSource.sync(ctx);

    const outcome = await govinfoSource.canary(ctx);
    const freshness = outcome.checks.find((c) => c.name === "freshness-bills");
    expect(freshness?.ok).toBe(true);
    expect(freshness?.severity).toBe("soft");

    await store.close();
  });
});

describe("currentCongress", () => {
  it("derives the congress in session from the calendar year", () => {
    expect(currentCongress(new Date("2025-01-15T00:00:00Z"))).toBe(119);
    expect(currentCongress(new Date("2026-08-24T00:00:00Z"))).toBe(119);
    expect(currentCongress(new Date("2027-03-01T00:00:00Z"))).toBe(120);
  });
});

describe("ordinal", () => {
  it("suffixes st/nd/rd/th correctly, including the 11-13 exception", () => {
    expect(ordinal(119)).toBe("119th");
    expect(ordinal(121)).toBe("121st");
    expect(ordinal(122)).toBe("122nd");
    expect(ordinal(123)).toBe("123rd");
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(112)).toBe("112th");
    expect(ordinal(113)).toBe("113th");
    expect(ordinal(101)).toBe("101st");
  });
});

describe("congressBillPageUrl", () => {
  it("builds the congress.gov deep link per bill type", () => {
    expect(congressBillPageUrl(119, "hr", 1234)).toBe(
      "https://www.congress.gov/bill/119th-congress/house-bill/1234",
    );
    expect(congressBillPageUrl(119, "s", 567)).toBe(
      "https://www.congress.gov/bill/119th-congress/senate-bill/567",
    );
    expect(congressBillPageUrl(119, "hjres", 45)).toBe(
      "https://www.congress.gov/bill/119th-congress/house-joint-resolution/45",
    );
    expect(congressBillPageUrl(119, "sconres", 7)).toBe(
      "https://www.congress.gov/bill/119th-congress/senate-concurrent-resolution/7",
    );
    expect(congressBillPageUrl(121, "sres", 9)).toBe(
      "https://www.congress.gov/bill/121st-congress/senate-resolution/9",
    );
  });

  it("throws on an unknown bill type", () => {
    expect(() => congressBillPageUrl(119, "zzz", 1)).toThrow(/unknown bill type/);
  });
});
