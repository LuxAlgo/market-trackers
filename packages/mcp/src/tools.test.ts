import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DATASETS, TrackerStore } from "@luxalgo/market-trackers-core";
import type {
  CongressTrade,
  InsiderTransaction,
  Provenance,
  ShortVolumeDay,
  ThirteenfHolding,
} from "@luxalgo/market-trackers-core";
import { createTrackerMcpServer } from "./server.js";

/**
 * Full-stack MCP test: a real client and server over a linked in-memory
 * transport, backed by a seeded store — the same wiring stdio and HTTP use.
 */

let store: TrackerStore;
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
  store = await TrackerStore.open(":memory:");

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

  await store.upsert(DATASETS["congress-hearings"], [
    {
      id: "CHRG-119hhrg90001",
      packageId: "CHRG-119hhrg90001",
      title: "OVERSIGHT OF THE EXAMPLE DATA BUREAU",
      chamber: "house" as const,
      docClass: "HHRG",
      congress: 119,
      session: 1,
      heldDate: "2026-06-10",
      citation: "Serial No. 119-42",
      committees: [{ name: "Committee on Example Matters", authorityId: "hsex00" }],
      witnesses: ["Jane Q. Witness, Director, Example Data Bureau"],
      memberBioguideIds: ["E000001"],
      detailUrl: "https://www.govinfo.gov/app/details/CHRG-119hhrg90001",
      htmlUrl: "https://www.govinfo.gov/content/pkg/CHRG-119hhrg90001/html/CHRG-119hhrg90001.htm",
      pdfUrl: "https://www.govinfo.gov/content/pkg/CHRG-119hhrg90001/pdf/CHRG-119hhrg90001.pdf",
      provenance: prov(
        "govinfo-hearings",
        "https://www.govinfo.gov/metadata/pkg/CHRG-119hhrg90001/mods.xml",
      ),
    },
  ]);

  await store.upsert(DATASETS["fed-communications"], [
    {
      id: "speech/example20260805a",
      type: "speech" as const,
      date: "2026-08-05",
      title: "Outlook for the Example Economy",
      speaker: "Governor Jane Example",
      venue: "At the Example Economic Luncheon",
      url: "https://www.federalreserve.gov/newsevents/speech/example20260805a.htm",
      videoUrl: null,
      note: null,
      provenance: prov("federalreserve", "https://www.federalreserve.gov/json/ne-speeches.json"),
    },
    {
      id: "pressreleases/monetary20260810a",
      type: "statement" as const,
      date: "2026-08-10",
      title: "Federal Reserve issues FOMC statement",
      speaker: null,
      venue: null,
      url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260810a.htm",
      videoUrl: null,
      note: null,
      provenance: prov("federalreserve", "https://www.federalreserve.gov/json/ne-press.json"),
    },
  ]);

  const server = createTrackerMcpServer(store);
  client = new Client({ name: "market-trackers-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await store.close();
});

describe("market-trackers-mcp tool surface", () => {
  it("registers all 24 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "tracker_13f_holders",
      "tracker_13f_manager",
      "tracker_bills",
      "tracker_campaign_finance",
      "tracker_clinical_trials",
      "tracker_committees",
      "tracker_congress_hearings",
      "tracker_congress_members",
      "tracker_congress_trades",
      "tracker_cot",
      "tracker_fda_approvals",
      "tracker_fed_communications",
      "tracker_freshness",
      "tracker_gov_contract_totals",
      "tracker_gov_contracts",
      "tracker_gov_grants",
      "tracker_insider_summary",
      "tracker_insider_trades",
      "tracker_lobbying",
      "tracker_member_profile",
      "tracker_patents",
      "tracker_search",
      "tracker_short_volume",
      "tracker_wiki_pageviews",
    ]);
    // Agent-facing descriptions are substantial, not one-liners.
    for (const tool of tools) {
      expect((tool.description ?? "").length).toBeGreaterThan(100);
    }
  });

  it("tracker_congress_trades returns rows with citations and range amounts", async () => {
    const payload = await callTool<{
      count: number;
      rows: (CongressTrade & { citation: string })[];
    }>("tracker_congress_trades", { ticker: "exco" });
    expect(payload.count).toBe(1);
    expect(payload.rows[0]?.citation).toBe("https://efdsearch.senate.gov/search/view/ptr/doc-1/");
    expect(payload.rows[0]?.amountRange).toEqual({
      min: 1_001,
      max: 15_000,
      text: "$1,001 - $15,000",
    });
  });

  it("tracker_congress_members aggregates activity", async () => {
    const payload = await callTool<{ members: { name: string; tradeCount: number }[] }>(
      "tracker_congress_members",
      { q: "example" },
    );
    expect(payload.members[0]?.tradeCount).toBe(1);
  });

  it("tracker_insider_trades ships a code legend for the codes it returns", async () => {
    const payload = await callTool<{
      count: number;
      code_legend: Record<string, string>;
      rows: { citation: string }[];
    }>("tracker_insider_trades", { ticker: "EXCO", codes: ["P"] });
    expect(payload.count).toBe(1);
    expect(payload.code_legend.P).toMatch(/purchase/i);
    expect(payload.rows[0]?.citation).toContain("sec.gov");
  });

  it("tracker_insider_summary aggregates without inventing signals", async () => {
    const payload = await callTool<{
      openMarket: { buys: number; sells: number; netShares: number };
    }>("tracker_insider_summary", { ticker: "EXCO", window_days: 3650 });
    expect(payload.openMarket.buys).toBe(1);
    expect(payload.openMarket.sells).toBe(0);
  });

  it("tracker_13f_holders returns holders for the latest period", async () => {
    const payload = await callTool<{
      period_end: string;
      holders: { managerName: string; citation: string }[];
    }>("tracker_13f_holders", { ticker: "EXCO" });
    expect(payload.period_end).toBe("2026-06-30");
    expect(payload.holders[0]?.managerName).toBe("EXAMPLE CAPITAL MANAGEMENT LP");
  });

  it("tracker_13f_manager resolves a manager by name", async () => {
    const payload = await callTool<{ manager_cik: string; holdings: unknown[] }>(
      "tracker_13f_manager",
      { q: "example capital" },
    );
    expect(payload.manager_cik).toBe("0009876543");
    expect(payload.holdings).toHaveLength(1);
  });

  it("tracker_13f_holders errors cleanly without ticker or cusip", async () => {
    const result = await client.callTool({ name: "tracker_13f_holders", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("tracker_short_volume returns the series with data notes", async () => {
    const payload = await callTool<{ count: number; data_notes: string }>("tracker_short_volume", {
      ticker: "EXCO",
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(payload.count).toBe(1);
    expect(payload.data_notes).toMatch(/not short interest/);
  });

  it("tracker_gov_contracts and tracker_lobbying answer with empty stores", async () => {
    const contracts = await callTool<{ count: number }>("tracker_gov_contracts", {
      ticker: "EXCO",
    });
    expect(contracts.count).toBe(0);
    const lobbying = await callTool<{ count: number }>("tracker_lobbying", { ticker: "EXCO" });
    expect(lobbying.count).toBe(0);
  });

  it("tracker_search finds entities across datasets", async () => {
    const payload = await callTool<{ results: { kind: string }[] }>("tracker_search", {
      q: "example",
    });
    const kinds = new Set(payload.results.map((r) => r.kind));
    expect(kinds.has("ticker")).toBe(true);
    expect(kinds.has("member")).toBe(true);
    expect(kinds.has("manager")).toBe(true);
  });

  it("tracker_member_profile joins identity, committee seats, and trades", async () => {
    const payload = await callTool<{
      member: { name: string; bioguideId: string };
      committees: { thomasId: string; subcommittees: string[] }[];
      trades: { total: number; buys: number; topTickers: { ticker: string }[]; recent: unknown[] };
    }>("tracker_member_profile", { q: "jane example" });
    expect(payload.member.bioguideId).toBe("E000001");
    expect(payload.committees).toHaveLength(1);
    expect(payload.committees[0]?.thomasId).toBe("SSAS");
    expect(payload.committees[0]?.subcommittees).toContain("Airland");
    expect(payload.trades.total).toBe(1);
    expect(payload.trades.buys).toBe(1);
    expect(payload.trades.topTickers[0]?.ticker).toBe("EXCO");
    expect(payload.trades.recent).toHaveLength(1);
  });

  it("tracker_committees returns the roster with trade activity", async () => {
    const payload = await callTool<{
      committee: { thomasId: string };
      members: { name: string; tradeCount: number; subcommittees: string[] }[];
    }>("tracker_committees", { q: "armed services" });
    expect(payload.committee.thomasId).toBe("SSAS");
    expect(payload.members[0]?.name).toBe("Jane Example");
    expect(payload.members[0]?.tradeCount).toBe(1);
    expect(payload.members[0]?.subcommittees).toContain("Airland");
  });

  it("tracker_gov_grants queries the grant universe separately from contracts", async () => {
    const grants = await callTool<{ count: number; rows: { citation: string }[] }>(
      "tracker_gov_grants",
      { ticker: "EXCO" },
    );
    expect(grants.count).toBe(1);
    expect(grants.rows[0]?.citation).toContain("usaspending.gov");
    const contracts = await callTool<{ count: number }>("tracker_gov_contracts", {
      ticker: "EXCO",
    });
    expect(contracts.count).toBe(0);
  });

  it("tracker_cot returns positioning verbatim", async () => {
    const payload = await callTool<{
      count: number;
      rows: { commercialLong: number; citation: string }[];
    }>("tracker_cot", { market: "crude oil" });
    expect(payload.count).toBe(1);
    expect(payload.rows[0]?.commercialLong).toBe(600_000);
    expect(payload.rows[0]?.citation).toContain("cftc.gov");
  });

  it("patents / clinical trials / fda tools answer cleanly on empty stores", async () => {
    expect((await callTool<{ count: number }>("tracker_patents", { ticker: "EXCO" })).count).toBe(
      0,
    );
    expect(
      (await callTool<{ count: number }>("tracker_clinical_trials", { ticker: "EXCO" })).count,
    ).toBe(0);
    expect(
      (await callTool<{ count: number }>("tracker_fda_approvals", { ticker: "EXCO" })).count,
    ).toBe(0);
  });

  it("tracker_congress_hearings filters by text over titles and witnesses, with citations", async () => {
    const byWitness = await callTool<{
      count: number;
      rows: { id: string; citation: string; memberBioguideIds: string[] }[];
    }>("tracker_congress_hearings", { q: "jane q. witness" });
    expect(byWitness.count).toBe(1);
    expect(byWitness.rows[0]?.id).toBe("CHRG-119hhrg90001");
    expect(byWitness.rows[0]?.citation).toContain("govinfo.gov");
    expect(byWitness.rows[0]?.memberBioguideIds).toContain("E000001");

    const byCommittee = await callTool<{ count: number }>("tracker_congress_hearings", {
      committee: "example matters",
      chamber: "house",
      congress: 119,
    });
    expect(byCommittee.count).toBe(1);

    const noMatch = await callTool<{ count: number }>("tracker_congress_hearings", {
      chamber: "senate",
    });
    expect(noMatch.count).toBe(0);
  });

  it("tracker_fed_communications filters by type and speaker, with citations", async () => {
    const statements = await callTool<{
      count: number;
      rows: { id: string; type: string; speaker: string | null; citation: string }[];
    }>("tracker_fed_communications", { type: "statement" });
    expect(statements.count).toBe(1);
    expect(statements.rows[0]?.id).toBe("pressreleases/monetary20260810a");
    expect(statements.rows[0]?.speaker).toBeNull();
    expect(statements.rows[0]?.citation).toContain("federalreserve.gov");

    const bySpeaker = await callTool<{ count: number; rows: { type: string }[] }>(
      "tracker_fed_communications",
      { speaker: "jane example", since: "2026-08-01" },
    );
    expect(bySpeaker.count).toBe(1);
    expect(bySpeaker.rows[0]?.type).toBe("speech");
  });

  it("tracker_member_profile errors cleanly on no match", async () => {
    const result = await client.callTool({
      name: "tracker_member_profile",
      arguments: { q: "zzz-nobody" },
    });
    expect(result.isError).toBe(true);
  });

  it("tracker_freshness reports staleness per dataset and health per source", async () => {
    const payload = await callTool<{
      datasets: { dataset: string; rowCount: number; stale: boolean }[];
      sources: { source: string }[];
    }>("tracker_freshness");
    expect(payload.datasets).toHaveLength(18);
    expect(payload.sources).toHaveLength(17);
    const congress = payload.datasets.find((d) => d.dataset === "congress-trades");
    expect(congress?.rowCount).toBe(1);
    const contracts = payload.datasets.find((d) => d.dataset === "gov-contracts");
    expect(contracts?.rowCount).toBe(0);
    expect(contracts?.stale).toBe(true);
  });
});
