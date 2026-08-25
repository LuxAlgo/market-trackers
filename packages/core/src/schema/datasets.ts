import type { ZodType } from "zod";
import type { SourceId } from "./provenance.js";
import { congressTradeSchema, type CongressTrade } from "./congress-trade.js";
import { insiderTransactionSchema, type InsiderTransaction } from "./insider-transaction.js";
import { thirteenfHoldingSchema, type ThirteenfHolding } from "./thirteenf-holding.js";
import { govContractAwardSchema, type GovContractAward } from "./gov-contract-award.js";
import { lobbyingFilingSchema, type LobbyingFiling } from "./lobbying-filing.js";
import { shortVolumeDaySchema, type ShortVolumeDay } from "./short-volume-day.js";
import { committeeAssignmentSchema, type CommitteeAssignment } from "./committee-assignment.js";
import { patentSchema, type Patent } from "./patent.js";
import { clinicalTrialSchema, type ClinicalTrial } from "./clinical-trial.js";
import { fdaApprovalSchema, type FdaApproval } from "./fda-approval.js";
import { cotReportSchema, type CotReport } from "./cot-report.js";

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
  "gov-grants",
  "lobbying-filings",
  "short-volume",
  "committee-assignments",
  "patents",
  "clinical-trials",
  "fda-approvals",
  "cot-reports",
] as const;

export type DatasetId = (typeof DATASET_IDS)[number];

/**
 * Bump when a PUBLISHED record shape changes. Adding whole new datasets is
 * additive and does not bump (existing consumers keep parsing untouched
 * shapes) — see docs/docket-data.md.
 */
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
  /**
   * The record's event date (YYYY-MM-DD or a YYYY[-MM[-DD]] prefix) — used to
   * shard full-history snapshots by year. Falls back to the ingestion day.
   */
  eventDate: (record: T) => string;
}

/** Grants share the federal-award record shape; only the award universe differs. */
export const govGrantAwardSchema = govContractAwardSchema;
export type GovGrantAward = GovContractAward;

export const DATASETS: {
  "congress-trades": DatasetDefinition<CongressTrade>;
  "insider-transactions": DatasetDefinition<InsiderTransaction>;
  "thirteenf-holdings": DatasetDefinition<ThirteenfHolding>;
  "gov-contracts": DatasetDefinition<GovContractAward>;
  "gov-grants": DatasetDefinition<GovGrantAward>;
  "lobbying-filings": DatasetDefinition<LobbyingFiling>;
  "short-volume": DatasetDefinition<ShortVolumeDay>;
  "committee-assignments": DatasetDefinition<CommitteeAssignment>;
  patents: DatasetDefinition<Patent>;
  "clinical-trials": DatasetDefinition<ClinicalTrial>;
  "fda-approvals": DatasetDefinition<FdaApproval>;
  "cot-reports": DatasetDefinition<CotReport>;
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
    eventDate: (r) => r.transactedAt,
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
    eventDate: (r) => r.transactedAt ?? r.filedAt,
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
    eventDate: (r) => r.periodEnd,
  },
  "gov-contracts": {
    id: "gov-contracts",
    title: "Government contract awards",
    description:
      "Federal contract awards from USAspending with best-effort recipient→ticker mapping against a curated map of public-company subsidiaries.",
    schema: govContractAwardSchema,
    table: "gov_contract_awards",
    sources: ["usaspending"],
    exportDir: "contracts/awards",
    freshnessWindowHours: 96,
    eventDate: (r) => r.actionDate,
  },
  "gov-grants": {
    id: "gov-grants",
    title: "Government grant awards",
    description:
      "Federal grant awards from USAspending (grant award types), same record shape and recipient→ticker mapping as contracts.",
    schema: govGrantAwardSchema,
    table: "gov_grant_awards",
    sources: ["usaspending"],
    exportDir: "grants/awards",
    freshnessWindowHours: 96,
    eventDate: (r) => r.actionDate,
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
    eventDate: (r) => `${r.filingYear}-01-01`,
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
    eventDate: (r) => r.date,
  },
  "committee-assignments": {
    id: "committee-assignments",
    title: "Congressional committee assignments",
    description:
      "Current member↔committee/subcommittee assignments from the public-domain unitedstates/congress-legislators dataset — the join between who trades and what their committee oversees.",
    schema: committeeAssignmentSchema,
    table: "committee_assignments",
    sources: ["congress-legislators"],
    exportDir: "congress/committees",
    // A current-state snapshot dataset; membership changes are infrequent.
    freshnessWindowHours: 24 * 45,
    eventDate: (r) => r.provenance.retrievedAt.slice(0, 10),
  },
  patents: {
    id: "patents",
    title: "Granted patents",
    description:
      "US patents granted, from the PatentsView PatentSearch API (free key), with best-effort assignee→ticker mapping.",
    schema: patentSchema,
    table: "patents",
    sources: ["patentsview"],
    exportDir: "patents/grants",
    // Patents grant weekly (Tuesdays).
    freshnessWindowHours: 24 * 12,
    eventDate: (r) => r.grantDate,
  },
  "clinical-trials": {
    id: "clinical-trials",
    title: "Clinical trial registrations",
    description:
      "Study registrations and status changes from ClinicalTrials.gov (API v2, keyless), sponsor-declared registry facts with best-effort sponsor→ticker mapping.",
    schema: clinicalTrialSchema,
    table: "clinical_trials",
    sources: ["clinicaltrials"],
    exportDir: "clinical-trials/studies",
    freshnessWindowHours: 96,
    eventDate: (r) => r.lastUpdated,
  },
  "fda-approvals": {
    id: "fda-approvals",
    title: "FDA drug application events",
    description:
      "Drug-application submission events (originals and supplements) with FDA status codes, from openFDA's Drugs@FDA endpoint, with best-effort sponsor→ticker mapping.",
    schema: fdaApprovalSchema,
    table: "fda_approvals",
    sources: ["openfda"],
    exportDir: "fda/approvals",
    // Drugs@FDA refreshes on a lag measured in days-to-weeks.
    freshnessWindowHours: 24 * 12,
    eventDate: (r) => r.statusDate,
  },
  "cot-reports": {
    id: "cot-reports",
    title: "CFTC Commitments of Traders",
    description:
      "Weekly Commitments of Traders positioning (legacy futures-only) per contract market, from the CFTC public reporting API.",
    schema: cotReportSchema,
    table: "cot_reports",
    sources: ["cftc"],
    exportDir: "cot/legacy-futures",
    // Published weekly (Fridays, for Tuesday data).
    freshnessWindowHours: 24 * 10,
    eventDate: (r) => r.reportDate,
  },
};

// The cast erases per-dataset record types; `eventDate` is contravariant in
// T, so the typed definitions can't unify without it. Call sites that hold a
// typed definition keep full safety.
export const ALL_DATASETS = Object.values(DATASETS) as unknown as DatasetDefinition[];

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
