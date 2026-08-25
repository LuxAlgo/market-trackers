import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DATASETS, DocketStore } from "@luxalgo/docket-core";
import type {
  CongressTrade,
  InsiderTransaction,
  Provenance,
  ShortVolumeDay,
  ThirteenfHolding,
} from "@luxalgo/docket-core";
import { createDocketMcpServer } from "./server.js";

/**
 * Full-stack MCP test: a real client and server over a linked in-memory
 * transport, backed by a seeded store — the same wiring stdio and HTTP use.
 */

let store: DocketStore;
let client: Client;

function prov(source: Provenance["source"], url: string): Provenance {
  return {
    source,
    sourceUrl: url,
    retrievedAt: "2026-08-24T12:00:00.000Z",
    parser: "test@1",
    confidence: 1,
    needsReview: false,
  };
}

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as { type: string; text: string }[])[0];
  if (!content) throw new Error(`No content from ${name}`);
  return JSON.parse(content.text) as T;
}

beforeAll(async () => {
  store = await DocketStore.open(":memory:");

  const trade: CongressTrade = {
    id: "senate:doc-1:0",
    chamber: "senate",
    docId: "doc-1",
    rowIndex: 0,
    member: { name: "Jane Example", bioguideId: "E000001", party: "I", state: "VT" },
    filedAt: "2026-08-20",
    transactedAt: "2026-08-18",
    ticker: "EXCO",
    assetDescription: "ExampleCorp Inc — Common Stock",
    assetType: "stock",
    side: "buy",
    amountRange: { min: 1_001, max: 15_000, text: "$1,001 - $15,000" },
    owner: "self",
    provenance: prov("senate-efd", "https://efdsearch.senate.gov/search/view/ptr/doc-1/"),
  };
  await store.upsert(DATASETS["congress-trades"], [trade]);

  const insider: InsiderTransaction = {
    id: "0001-26-000001:nd:0",
    accessionNumber: "0001-26-000001",
    formType: "4",
    ticker: "EXCO",
    issuerCik: "0000123456",
    issuerName: "EXAMPLECORP INC",
    insider: {
      name: "Doe Jane A",
      cik: "0001234567",
      title: "CFO",
      isDirector: false,
      isOfficer: true,
      isTenPctOwner: false,
    },
    transactedAt: "2026-08-19",
    filedAt: "2026-08-20",
    code: "P",
    acquiredDisposed: "A",
    securityTitle: "Common Stock",
    shares: 1_000,
    pricePerShare: 10,
    sharesOwnedAfter: 10_000,
    ownership: "direct",
    isDerivative: false,
    provenance: prov(
      "edgar",
      "https://www.sec.gov/Archives/edgar/data/123456/0001-26-000001-index.htm",
    ),
  };
  await store.upsert(DATASETS["insider-transactions"], [insider]);

  const holding: ThirteenfHolding = {
    id: "0009-26-000002:0",
    accessionNumber: "0009-26-000002",
    managerCik: "0009876543",
    managerName: "EXAMPLE CAPITAL MANAGEMENT LP",
    periodEnd: "2026-06-30",
    filedAt: "2026-08-14",
    cusip: "30303M102",
    ticker: "EXCO",
    issuerName: "EXAMPLECORP INC",
    shareType: "SH",
    shares: 2_500_000,
    valueUsd: 104_650_000,
    putCall: null,
    provenance: prov(
      "edgar",
      "https://www.sec.gov/Archives/edgar/data/9876543/0009-26-000002-index.htm",
    ),
  };
  await store.upsert(DATASETS["thirteenf-holdings"], [holding]);

  const shortVol: ShortVolumeDay = {
    id: "2026-08-21:EXCO:CNMS",
    date: "2026-08-21",
    ticker: "EXCO",
    market: "CNMS",
    shortVolume: 750_000,
    shortExemptVolume: 1_200,
    totalVolume: 1_500_000,
    shortRatio: 0.5,
    provenance: prov("finra", "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260821.txt"),
  };
  await store.upsert(DATASETS["short-volume"], [shortVol]);

  await store.replaceCikTickers([{ cik: "0000123456", ticker: "EXCO", name: "EXAMPLECORP INC" }]);

  await store.upsert(DATASETS["committee-assignments"], [
    {
      id: "E000001:SSAS",
      bioguideId: "E000001",
      memberName: "Jane Example",
      chamber: "senate" as const,
      committee: {
        thomasId: "SSAS",
        name: "Senate Committee on Armed Services",
        type: "senate" as const,
      },
      subcommittee: null,
      rank: 3,
      title: null,
      provenance: prov(
        "congress-legislators",
        "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.yaml",
      ),
    },
    {
      id: "E000001:SSAS:14",
      bioguideId: "E000001",
      memberName: "Jane Example",
      chamber: "senate" as const,
      committee: {
        thomasId: "SSAS",
        name: "Senate Committee on Armed Services",
        type: "senate" as const,
      },
      subcommittee: { thomasId: "14", name: "Airland" },
      rank: 2,
      title: null,
      provenance: prov(
        "congress-legislators",
        "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.yaml",
      ),
    },
  ]);

  await store.upsert(DATASETS["cot-reports"], [
    {
      id: "2026-08-18:067651",
      reportDate: "2026-08-18",
      contractCode: "067651",
      marketName: "CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE",
      openInterest: 1_500_000,
      commercialLong: 600_000,
      commercialShort: 700_000,
      nonCommercialLong: 500_000,
      nonCommercialShort: 380_000,
      nonReportableLong: 90_000,
      nonReportableShort: 110_000,
      provenance: prov("cftc", "https://publicreporting.cftc.gov/resource/6dca-aqww.json"),
    },
  ]);

  await store.upsert(DATASETS["gov-grants"], [
    {
      id: "ASST_NON_EXAMPLE_0001",
      awardId: "R01EX000001",
      awardType: "grant",
      agency: "Department of Health and Human Services",
      subAgency: "National Institutes of Health",
      recipient: { name: "EXAMPLECORP INC", uei: "EXAMPLEUEI01", tickers: ["EXCO"] },
      amountUsd: 2_400_000,
      actionDate: "2026-08-10",
      description: "Example research grant",
      naicsCode: null,
      naicsDescription: null,
      provenance: prov("usaspending", "https://www.usaspending.gov/award/ASST_NON_EXAMPLE_0001"),
    },
  ]);

  const server = createDocketMcpServer(store);
  client = new Client({ name: "docket-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await store.close();
});

describe("docket-mcp tool surface", () => {
  it("registers all 18 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "docket_13f_holders",
      "docket_13f_manager",
      "docket_clinical_trials",
      "docket_committees",
      "docket_congress_members",
      "docket_congress_trades",
      "docket_cot",
      "docket_fda_approvals",
      "docket_freshness",
      "docket_gov_contracts",
      "docket_gov_grants",
      "docket_insider_summary",
      "docket_insider_trades",
      "docket_lobbying",
      "docket_member_profile",
      "docket_patents",
      "docket_search",
      "docket_short_volume",
    ]);
    // Agent-facing descriptions are substantial, not one-liners.
    for (const tool of tools) {
      expect((tool.description ?? "").length).toBeGreaterThan(100);
    }
  });

  it("docket_congress_trades returns rows with citations and range amounts", async () => {
    const payload = await callTool<{
      count: number;
      rows: (CongressTrade & { citation: string })[];
    }>("docket_congress_trades", { ticker: "exco" });
    expect(payload.count).toBe(1);
    expect(payload.rows[0]?.citation).toBe("https://efdsearch.senate.gov/search/view/ptr/doc-1/");
    expect(payload.rows[0]?.amountRange).toEqual({
      min: 1_001,
      max: 15_000,
      text: "$1,001 - $15,000",
    });
  });

  it("docket_congress_members aggregates activity", async () => {
    const payload = await callTool<{ members: { name: string; tradeCount: number }[] }>(
      "docket_congress_members",
      { q: "example" },
    );
    expect(payload.members[0]?.tradeCount).toBe(1);
  });

  it("docket_insider_trades ships a code legend for the codes it returns", async () => {
    const payload = await callTool<{
      count: number;
      code_legend: Record<string, string>;
      rows: { citation: string }[];
    }>("docket_insider_trades", { ticker: "EXCO", codes: ["P"] });
    expect(payload.count).toBe(1);
    expect(payload.code_legend.P).toMatch(/purchase/i);
    expect(payload.rows[0]?.citation).toContain("sec.gov");
  });

  it("docket_insider_summary aggregates without inventing signals", async () => {
    const payload = await callTool<{
      openMarket: { buys: number; sells: number; netShares: number };
    }>("docket_insider_summary", { ticker: "EXCO", window_days: 3650 });
    expect(payload.openMarket.buys).toBe(1);
    expect(payload.openMarket.sells).toBe(0);
  });

  it("docket_13f_holders returns holders for the latest period", async () => {
    const payload = await callTool<{
      period_end: string;
      holders: { managerName: string; citation: string }[];
    }>("docket_13f_holders", { ticker: "EXCO" });
    expect(payload.period_end).toBe("2026-06-30");
    expect(payload.holders[0]?.managerName).toBe("EXAMPLE CAPITAL MANAGEMENT LP");
  });

  it("docket_13f_manager resolves a manager by name", async () => {
    const payload = await callTool<{ manager_cik: string; holdings: unknown[] }>(
      "docket_13f_manager",
      { q: "example capital" },
    );
    expect(payload.manager_cik).toBe("0009876543");
    expect(payload.holdings).toHaveLength(1);
  });

  it("docket_13f_holders errors cleanly without ticker or cusip", async () => {
    const result = await client.callTool({ name: "docket_13f_holders", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("docket_short_volume returns the series with data notes", async () => {
    const payload = await callTool<{ count: number; data_notes: string }>("docket_short_volume", {
      ticker: "EXCO",
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(payload.count).toBe(1);
    expect(payload.data_notes).toMatch(/not short interest/);
  });

  it("docket_gov_contracts and docket_lobbying answer with empty stores", async () => {
    const contracts = await callTool<{ count: number }>("docket_gov_contracts", { ticker: "EXCO" });
    expect(contracts.count).toBe(0);
    const lobbying = await callTool<{ count: number }>("docket_lobbying", { ticker: "EXCO" });
    expect(lobbying.count).toBe(0);
  });

  it("docket_search finds entities across datasets", async () => {
    const payload = await callTool<{ results: { kind: string }[] }>("docket_search", {
      q: "example",
    });
    const kinds = new Set(payload.results.map((r) => r.kind));
    expect(kinds.has("ticker")).toBe(true);
    expect(kinds.has("member")).toBe(true);
    expect(kinds.has("manager")).toBe(true);
  });

  it("docket_member_profile joins identity, committee seats, and trades", async () => {
    const payload = await callTool<{
      member: { name: string; bioguideId: string };
      committees: { thomasId: string; subcommittees: string[] }[];
      trades: { total: number; buys: number; topTickers: { ticker: string }[]; recent: unknown[] };
    }>("docket_member_profile", { q: "jane example" });
    expect(payload.member.bioguideId).toBe("E000001");
    expect(payload.committees).toHaveLength(1);
    expect(payload.committees[0]?.thomasId).toBe("SSAS");
    expect(payload.committees[0]?.subcommittees).toContain("Airland");
    expect(payload.trades.total).toBe(1);
    expect(payload.trades.buys).toBe(1);
    expect(payload.trades.topTickers[0]?.ticker).toBe("EXCO");
    expect(payload.trades.recent).toHaveLength(1);
  });

  it("docket_committees returns the roster with trade activity", async () => {
    const payload = await callTool<{
      committee: { thomasId: string };
      members: { name: string; tradeCount: number; subcommittees: string[] }[];
    }>("docket_committees", { q: "armed services" });
    expect(payload.committee.thomasId).toBe("SSAS");
    expect(payload.members[0]?.name).toBe("Jane Example");
    expect(payload.members[0]?.tradeCount).toBe(1);
    expect(payload.members[0]?.subcommittees).toContain("Airland");
  });

  it("docket_gov_grants queries the grant universe separately from contracts", async () => {
    const grants = await callTool<{ count: number; rows: { citation: string }[] }>(
      "docket_gov_grants",
      { ticker: "EXCO" },
    );
    expect(grants.count).toBe(1);
    expect(grants.rows[0]?.citation).toContain("usaspending.gov");
    const contracts = await callTool<{ count: number }>("docket_gov_contracts", {
      ticker: "EXCO",
    });
    expect(contracts.count).toBe(0);
  });

  it("docket_cot returns positioning verbatim", async () => {
    const payload = await callTool<{
      count: number;
      rows: { commercialLong: number; citation: string }[];
    }>("docket_cot", { market: "crude oil" });
    expect(payload.count).toBe(1);
    expect(payload.rows[0]?.commercialLong).toBe(600_000);
    expect(payload.rows[0]?.citation).toContain("cftc.gov");
  });

  it("patents / clinical trials / fda tools answer cleanly on empty stores", async () => {
    expect((await callTool<{ count: number }>("docket_patents", { ticker: "EXCO" })).count).toBe(0);
    expect(
      (await callTool<{ count: number }>("docket_clinical_trials", { ticker: "EXCO" })).count,
    ).toBe(0);
    expect(
      (await callTool<{ count: number }>("docket_fda_approvals", { ticker: "EXCO" })).count,
    ).toBe(0);
  });

  it("docket_member_profile errors cleanly on no match", async () => {
    const result = await client.callTool({
      name: "docket_member_profile",
      arguments: { q: "zzz-nobody" },
    });
    expect(result.isError).toBe(true);
  });

  it("docket_freshness reports staleness per dataset and health per source", async () => {
    const payload = await callTool<{
      datasets: { dataset: string; rowCount: number; stale: boolean }[];
      sources: { source: string }[];
    }>("docket_freshness");
    expect(payload.datasets).toHaveLength(12);
    expect(payload.sources).toHaveLength(11);
    const congress = payload.datasets.find((d) => d.dataset === "congress-trades");
    expect(congress?.rowCount).toBe(1);
    const contracts = payload.datasets.find((d) => d.dataset === "gov-contracts");
    expect(contracts?.rowCount).toBe(0);
    expect(contracts?.stale).toBe(true);
  });
});
