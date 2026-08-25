import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { DATASETS } from "../schema/datasets.js";
import { AltDataStore } from "./store.js";
import {
  freshnessReport,
  insiderSummary,
  queryCongressMembers,
  queryCongressTrades,
  queryGovContracts,
  queryInsiderTransactions,
  queryLobbying,
  queryShortVolume,
  queryThirteenfHolders,
  queryThirteenfManager,
  searchEntities,
} from "./queries.js";
import {
  makeCongressTrade,
  makeGovContractAward,
  makeInsiderTransaction,
  makeLobbyingFiling,
  makeShortVolumeDay,
  makeThirteenfHolding,
} from "../test-helpers.js";

let store: AltDataStore;

beforeAll(async () => {
  store = await AltDataStore.open(":memory:");

  await store.upsert(DATASETS["congress-trades"], [
    makeCongressTrade({ id: "senate:doc-1:0", transactedAt: "2026-08-18", side: "buy" }),
    makeCongressTrade({
      id: "senate:doc-1:1",
      rowIndex: 1,
      transactedAt: "2026-08-10",
      side: "sell",
      ticker: "OTHR",
      assetDescription: "OtherCo",
    }),
    makeCongressTrade({
      id: "house:doc-9:0",
      chamber: "house",
      docId: "doc-9",
      member: { name: "John Sample", bioguideId: "S000123", party: "R", state: "TX" },
      transactedAt: "2026-07-01",
      side: "buy",
    }),
  ]);

  await store.upsert(DATASETS["insider-transactions"], [
    makeInsiderTransaction({
      id: "acc1:nd:0",
      code: "P",
      acquiredDisposed: "A",
      shares: 1_000,
      pricePerShare: 10,
      transactedAt: "2026-08-19",
    }),
    makeInsiderTransaction({
      id: "acc1:nd:1",
      code: "S",
      acquiredDisposed: "D",
      shares: 400,
      pricePerShare: 12,
      transactedAt: "2026-08-15",
    }),
    makeInsiderTransaction({
      id: "acc2:nd:0",
      code: "S",
      shares: 50_000,
      pricePerShare: 11,
      transactedAt: "2026-08-01",
      insider: {
        name: "Big Seller",
        cik: "0002222222",
        title: "CEO",
        isDirector: false,
        isOfficer: true,
        isTenPctOwner: false,
      },
    }),
    makeInsiderTransaction({
      id: "acc3:d:0",
      isDerivative: true,
      code: "M",
      shares: 5_000,
      pricePerShare: 0,
      transactedAt: "2026-08-19",
    }),
  ]);

  await store.upsert(DATASETS["thirteenf-holdings"], [
    makeThirteenfHolding({
      id: "q2:0",
      periodEnd: "2026-06-30",
      shares: 2_500_000,
      valueUsd: 104_650_000,
    }),
    makeThirteenfHolding({
      id: "q1:0",
      periodEnd: "2026-03-31",
      shares: 2_000_000,
      valueUsd: 90_000_000,
      accessionNumber: "0009876543-26-000001",
    }),
    makeThirteenfHolding({
      id: "q2:other:0",
      periodEnd: "2026-06-30",
      managerCik: "0001111111",
      managerName: "SAMPLE ADVISORS LLC",
      shares: 100_000,
      valueUsd: 4_186_000,
      accessionNumber: "0001111111-26-000002",
    }),
  ]);

  await store.upsert(DATASETS["gov-contracts"], [makeGovContractAward()]);
  await store.upsert(DATASETS["lobbying-filings"], [makeLobbyingFiling()]);

  await store.upsert(DATASETS["short-volume"], [
    makeShortVolumeDay({ id: "2026-08-20:EXCO:CNMS", date: "2026-08-20" }),
    makeShortVolumeDay({
      id: "2026-08-21:EXCO:CNMS",
      date: "2026-08-21",
      shortVolume: 900_000,
      shortRatio: 0.6,
    }),
  ]);

  await store.replaceCikTickers([{ cik: "0000123456", ticker: "EXCO", name: "EXAMPLECORP INC" }]);
});

afterAll(async () => {
  await store.close();
});

describe("queryCongressTrades", () => {
  it("filters by ticker, side, chamber, member, and date range", async () => {
    expect(await queryCongressTrades(store, { ticker: "exco" })).toHaveLength(2);
    expect(await queryCongressTrades(store, { side: "sell" })).toHaveLength(1);
    expect(await queryCongressTrades(store, { chamber: "house" })).toHaveLength(1);
    expect(await queryCongressTrades(store, { member: "sample" })).toHaveLength(1);
    expect(
      await queryCongressTrades(store, { since: "2026-08-01", until: "2026-08-31" }),
    ).toHaveLength(2);
  });

  it("orders newest transaction first", async () => {
    const rows = await queryCongressTrades(store);
    expect(rows[0]?.transactedAt).toBe("2026-08-18");
  });
});

describe("queryCongressMembers", () => {
  it("aggregates trade counts per member", async () => {
    const members = await queryCongressMembers(store);
    expect(members[0]?.name).toBe("Jane Example");
    expect(members[0]?.tradeCount).toBe(2);
    const filtered = await queryCongressMembers(store, "john");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.bioguideId).toBe("S000123");
  });
});

describe("queryInsiderTransactions", () => {
  it("filters by codes, minValue, derivative flag", async () => {
    expect(await queryInsiderTransactions(store, { codes: ["p"] })).toHaveLength(1);
    expect(await queryInsiderTransactions(store, { minValue: 100_000 })).toHaveLength(1);
    expect(await queryInsiderTransactions(store, { isDerivative: true })).toHaveLength(1);
    expect(await queryInsiderTransactions(store, { insiderName: "big seller" })).toHaveLength(1);
  });
});

describe("insiderSummary", () => {
  it("summarizes open-market buys vs sells without inventing signals", async () => {
    const summary = await insiderSummary(store, "EXCO", "2026-07-01");
    expect(summary.openMarket.buys).toBe(1);
    expect(summary.openMarket.sells).toBe(2);
    expect(summary.openMarket.netShares).toBe(1_000 - 50_400);
    expect(summary.notableInsiders[0]?.name).toBe("Big Seller");
  });
});

describe("queryThirteenfHolders", () => {
  it("returns latest period with share changes vs prior period", async () => {
    const result = await queryThirteenfHolders(store, { ticker: "EXCO" });
    expect(result.periodEnd).toBe("2026-06-30");
    expect(result.priorPeriodEnd).toBe("2026-03-31");
    const example = result.holders.find((h) => h.managerCik === "0009876543");
    expect(example?.shares).toBe(2_500_000);
    expect(example?.sharesPriorPeriod).toBe(2_000_000);
    expect(example?.sharesChange).toBe(500_000);
    const newcomer = result.holders.find((h) => h.managerCik === "0001111111");
    expect(newcomer?.sharesPriorPeriod).toBeNull();
  });
});

describe("queryThirteenfManager", () => {
  it("resolves a manager by name query and returns latest holdings", async () => {
    const result = await queryThirteenfManager(store, { q: "example capital" });
    expect(result.managerCik).toBe("0009876543");
    expect(result.periodEnd).toBe("2026-06-30");
    expect(result.holdings).toHaveLength(1);
  });
});

describe("contracts, lobbying, short volume", () => {
  it("queries contracts by ticker (JSON containment) and agency", async () => {
    expect(await queryGovContracts(store, { ticker: "exco" })).toHaveLength(1);
    expect(await queryGovContracts(store, { agency: "defense" })).toHaveLength(1);
    expect(await queryGovContracts(store, { minAmount: 99_999_999 })).toHaveLength(0);
  });

  it("queries lobbying by ticker and year", async () => {
    expect(await queryLobbying(store, { ticker: "EXCO" })).toHaveLength(1);
    expect(await queryLobbying(store, { sinceYear: 2027 })).toHaveLength(0);
  });

  it("returns short-volume series in ascending date order", async () => {
    const series = await queryShortVolume(store, "EXCO", "2026-08-01", "2026-08-31");
    expect(series.map((r) => r.date)).toEqual(["2026-08-20", "2026-08-21"]);
  });
});

describe("searchEntities", () => {
  it("finds tickers, members, managers, and insiders in one query", async () => {
    const results = await searchEntities(store, "example");
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has("ticker")).toBe(true);
    expect(kinds.has("member")).toBe(true);
    expect(kinds.has("manager")).toBe(true);
  });
});

describe("freshnessReport", () => {
  it("reports per-dataset ages against their freshness windows", async () => {
    const report = await freshnessReport(store, new Date("2026-08-24T12:30:00Z"));
    const shortVolume = report.datasets.find((d) => d.dataset === "short-volume");
    expect(shortVolume?.rowCount).toBe(2);
    expect(shortVolume?.lastIngestedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(shortVolume?.stale).toBe(false);
    expect(report.sources).toHaveLength(14);
    expect(report.datasets).toHaveLength(16);
  });
});
