import type { ZodType } from "zod";
import type { SourceId } from "./provenance.js";
import { congressTradeSchema, type CongressTrade } from "./congress-trade.js";
import { insiderTransactionSchema, type InsiderTransaction } from "./insider-transaction.js";
import { thirteenfHoldingSchema, type ThirteenfHolding } from "./thirteenf-holding.js";
import { govContractAwardSchema, type GovContractAward } from "./gov-contract-award.js";
import { lobbyingFilingSchema, type LobbyingFiling } from "./lobbying-filing.js";
import { shortVolumeDaySchema, type ShortVolumeDay } from "./short-volume-day.js";

/**
 * The dataset registry: one definition per dataset Docket ingests, stores,
 * serves, and dumps. Storage, export, sync, and the MCP server all iterate
 * this registry instead of hard-coding dataset lists.
 */

export const DATASET_IDS = [
  "congress-trades",
  "insider-transactions",
  "thirteenf-holdings",
  "gov-contracts",
  "lobbying-filings",
  "short-volume",
] as const;

export type DatasetId = (typeof DATASET_IDS)[number];

/** Bump when a published record shape changes; recorded in every dump manifest. */
export const SCHEMA_VERSION = 1;

export interface DatasetDefinition<T = unknown> {
  id: DatasetId;
  title: string;
  description: string;
  /** zod schema — the source of truth for the record shape. */
  schema: ZodType<T>;
  /** Storage table name. */
  table: string;
  /** Sources that can produce rows for this dataset. */
  sources: SourceId[];
  /** Directory this dataset dumps into inside a data export. */
  exportDir: string;
  /**
   * How stale this dataset may be (in hours) before freshness canaries go red.
   * Generous on purpose: quiet news days happen and must not page anyone.
   */
  freshnessWindowHours: number;
}

export const DATASETS: {
  "congress-trades": DatasetDefinition<CongressTrade>;
  "insider-transactions": DatasetDefinition<InsiderTransaction>;
  "thirteenf-holdings": DatasetDefinition<ThirteenfHolding>;
  "gov-contracts": DatasetDefinition<GovContractAward>;
  "lobbying-filings": DatasetDefinition<LobbyingFiling>;
  "short-volume": DatasetDefinition<ShortVolumeDay>;
} = {
  "congress-trades": {
    id: "congress-trades",
    title: "Congressional trades",
    description:
      "Transactions from congressional Periodic Transaction Reports (Senate eFD + House Clerk), one row per reported transaction, amounts kept as ranges.",
    schema: congressTradeSchema,
    table: "congress_trades",
    sources: ["senate-efd", "house-clerk"],
    exportDir: "congress/trades",
    freshnessWindowHours: 72,
  },
  "insider-transactions": {
    id: "insider-transactions",
    title: "Insider transactions",
    description:
      "SEC Forms 3/4/5 ownership filings parsed from EDGAR primary XML, one row per transaction or initial holding.",
    schema: insiderTransactionSchema,
    table: "insider_transactions",
    sources: ["edgar"],
    exportDir: "insider/transactions",
    freshnessWindowHours: 72,
  },
  "thirteenf-holdings": {
    id: "thirteenf-holdings",
    title: "13F holdings",
    description:
      "Quarterly institutional holdings from EDGAR 13F-HR information tables, CUSIP-keyed with best-effort ticker resolution.",
    schema: thirteenfHoldingSchema,
    table: "thirteenf_holdings",
    sources: ["edgar"],
    exportDir: "thirteenf/holdings",
    // 13F filings cluster around quarterly deadlines; staleness is judged in weeks.
    freshnessWindowHours: 24 * 45,
    // (45 days: the filing window after each quarter end.)
  },
  "gov-contracts": {
    id: "gov-contracts",
    title: "Government contract awards",
    description:
      "Federal awards from USAspending with best-effort recipient→ticker mapping against a curated map of public-company subsidiaries.",
    schema: govContractAwardSchema,
    table: "gov_contract_awards",
    sources: ["usaspending"],
    exportDir: "contracts/awards",
    freshnessWindowHours: 96,
  },
  "lobbying-filings": {
    id: "lobbying-filings",
    title: "Lobbying filings",
    description:
      "Lobbying disclosure filings from the Senate LDA API with best-effort client→ticker mapping.",
    schema: lobbyingFilingSchema,
    table: "lobbying_filings",
    sources: ["lda"],
    exportDir: "lobbying/filings",
    // Lobbying discloses quarterly; judge staleness accordingly.
    freshnessWindowHours: 24 * 120,
  },
  "short-volume": {
    id: "short-volume",
    title: "Short-sale volume",
    description:
      "FINRA Reg SHO daily short-sale volume files, one row per symbol-day-market, both pre- and post-2026 volume formats.",
    schema: shortVolumeDaySchema,
    table: "short_volume_days",
    sources: ["finra"],
    exportDir: "short-volume/daily",
    freshnessWindowHours: 96,
  },
};

export const ALL_DATASETS: DatasetDefinition[] = Object.values(DATASETS);

export function datasetById(id: string): DatasetDefinition {
  const def = (DATASETS as Record<string, DatasetDefinition>)[id];
  if (!def) {
    throw new Error(`Unknown dataset '${id}'. Known datasets: ${DATASET_IDS.join(", ")}`);
  }
  return def;
}

export function isDatasetId(id: string): id is DatasetId {
  return (DATASET_IDS as readonly string[]).includes(id);
}
