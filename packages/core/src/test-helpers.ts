import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provenance, SourceId } from "./schema/provenance.js";
import type { CongressTrade } from "./schema/congress-trade.js";
import type { InsiderTransaction } from "./schema/insider-transaction.js";
import type { ThirteenfHolding } from "./schema/thirteenf-holding.js";
import type { GovContractAward } from "./schema/gov-contract-award.js";
import type { LobbyingFiling } from "./schema/lobbying-filing.js";
import type { ShortVolumeDay } from "./schema/short-volume-day.js";

/** Shared factories and fixture plumbing for the test suite (not shipped: tests only). */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function fixturePath(...segments: string[]): string {
  return join(PKG_ROOT, "fixtures", ...segments);
}

export function readFixture(...segments: string[]): string {
  return readFileSync(fixturePath(...segments), "utf8");
}

export function readFixtureJson<T>(...segments: string[]): T {
  return JSON.parse(readFixture(...segments)) as T;
}

/** Temp dirs live inside the package so sandboxed environments allow them. */
export function makeTmpDir(label: string): { dir: string; cleanup: () => void } {
  const base = join(PKG_ROOT, ".tmp-test");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeProvenance(source: SourceId, overrides: Partial<Provenance> = {}): Provenance {
  return {
    source,
    sourceUrl: "https://example.gov/primary/document/1",
    retrievedAt: "2026-08-24T12:00:00.000Z",
    parser: "test@1",
    confidence: 1,
    needsReview: false,
    ...overrides,
  };
}

export function makeCongressTrade(overrides: Partial<CongressTrade> = {}): CongressTrade {
  return {
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
    provenance: makeProvenance("senate-efd"),
    ...overrides,
  };
}

export function makeInsiderTransaction(
  overrides: Partial<InsiderTransaction> = {},
): InsiderTransaction {
  return {
    id: "0001127602-26-019876:nd:0",
    accessionNumber: "0001127602-26-019876",
    formType: "4",
    ticker: "EXCO",
    issuerCik: "0000123456",
    issuerName: "EXAMPLECORP INC",
    insider: {
      name: "Doe Jane A",
      cik: "0001234567",
      title: "Chief Financial Officer",
      isDirector: false,
      isOfficer: true,
      isTenPctOwner: false,
    },
    transactedAt: "2026-08-18",
    filedAt: "2026-08-20",
    code: "S",
    acquiredDisposed: "D",
    securityTitle: "Common Stock",
    shares: 4_000,
    pricePerShare: 41.9,
    sharesOwnedAfter: 48_500,
    ownership: "direct",
    isDerivative: false,
    provenance: makeProvenance("edgar"),
    ...overrides,
  };
}

export function makeThirteenfHolding(overrides: Partial<ThirteenfHolding> = {}): ThirteenfHolding {
  return {
    id: "0009876543-26-000002:0",
    accessionNumber: "0009876543-26-000002",
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
    provenance: makeProvenance("edgar"),
    ...overrides,
  };
}

export function makeGovContractAward(overrides: Partial<GovContractAward> = {}): GovContractAward {
  return {
    id: "CONT_AWD_EXAMPLE_0001",
    awardId: "W9128F26C0001",
    awardType: "definitive contract",
    agency: "Department of Defense",
    subAgency: "Department of the Army",
    recipient: { name: "EXAMPLECORP INC", uei: "EXAMPLEUEI01", tickers: ["EXCO"] },
    amountUsd: 12_500_000,
    actionDate: "2026-08-15",
    description: "Example engineering services",
    naicsCode: "541330",
    naicsDescription: "Engineering Services",
    provenance: makeProvenance("usaspending"),
    ...overrides,
  };
}

export function makeLobbyingFiling(overrides: Partial<LobbyingFiling> = {}): LobbyingFiling {
  return {
    id: "f0e9d8c7-0000-1111-2222-333344445555",
    filingUuid: "f0e9d8c7-0000-1111-2222-333344445555",
    registrant: { name: "Example Advocacy LLC" },
    client: { name: "EXAMPLECORP INC", tickers: ["EXCO"] },
    amountUsd: 80_000,
    filingYear: 2026,
    filingPeriod: "second_quarter",
    filingType: "Q2",
    issues: ["TAX", "TEC"],
    provenance: makeProvenance("lda"),
    ...overrides,
  };
}

export function makeShortVolumeDay(overrides: Partial<ShortVolumeDay> = {}): ShortVolumeDay {
  return {
    id: "2026-08-21:EXCO:CNMS",
    date: "2026-08-21",
    ticker: "EXCO",
    market: "CNMS",
    shortVolume: 750_000,
    shortExemptVolume: 1_200,
    totalVolume: 1_500_000,
    shortRatio: 0.5,
    provenance: makeProvenance("finra"),
    ...overrides,
  };
}
