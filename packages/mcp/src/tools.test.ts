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
  it("registers all 11 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "docket_13f_holders",
      "docket_13f_manager",
      "docket_congress_members",
      "docket_congress_trades",
      "docket_freshness",
      "docket_gov_contracts",
      "docket_insider_summary",
      "docket_insider_trades",
      "docket_lobbying",
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

  it("docket_freshness reports staleness per dataset and health per source", async () => {
    const payload = await callTool<{
      datasets: { dataset: string; rowCount: number; stale: boolean }[];
      sources: { source: string }[];
    }>("docket_freshness");
    expect(payload.datasets).toHaveLength(6);
    expect(payload.sources).toHaveLength(6);
    const congress = payload.datasets.find((d) => d.dataset === "congress-trades");
    expect(congress?.rowCount).toBe(1);
    const contracts = payload.datasets.find((d) => d.dataset === "gov-contracts");
    expect(contracts?.rowCount).toBe(0);
    expect(contracts?.stale).toBe(true);
  });
});
