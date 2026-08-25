/**
 * Dialect-neutral table specifications — the single source that DDL
 * generation (SQLite + Postgres), upsert statements, and the parity tests
 * all derive from. Record shapes themselves are owned by the zod schemas in
 * `../schema`; these specs describe how those records flatten into rows.
 */

export type ColumnType = "text" | "real" | "integer" | "boolean" | "json";

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  nullable?: boolean;
}

export interface IndexSpec {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
  primaryKey: string[];
  indexes: IndexSpec[];
}

/** Provenance columns shared by every dataset table. */
export const PROVENANCE_COLUMNS: ColumnSpec[] = [
  { name: "source", type: "text" },
  { name: "source_url", type: "text" },
  { name: "retrieved_at", type: "text" },
  { name: "parser", type: "text" },
  { name: "confidence", type: "real" },
  { name: "needs_review", type: "boolean" },
];

function datasetTable(name: string, columns: ColumnSpec[], indexes: IndexSpec[]): TableSpec {
  return {
    name,
    columns: [{ name: "id", type: "text" }, ...columns, ...PROVENANCE_COLUMNS],
    primaryKey: ["id"],
    indexes: [
      ...indexes,
      { name: `idx_${name}_retrieved_at`, columns: ["retrieved_at"] },
      { name: `idx_${name}_needs_review`, columns: ["needs_review"] },
    ],
  };
}

export const CONGRESS_TRADES_TABLE = datasetTable(
  "congress_trades",
  [
    { name: "chamber", type: "text" },
    { name: "doc_id", type: "text" },
    { name: "row_index", type: "integer" },
    { name: "member_name", type: "text" },
    { name: "bioguide_id", type: "text", nullable: true },
    { name: "party", type: "text", nullable: true },
    { name: "state", type: "text", nullable: true },
    { name: "filed_at", type: "text" },
    { name: "transacted_at", type: "text" },
    { name: "ticker", type: "text", nullable: true },
    { name: "asset_description", type: "text" },
    { name: "asset_type", type: "text" },
    { name: "side", type: "text" },
    { name: "amount_min", type: "real" },
    { name: "amount_max", type: "real", nullable: true },
    { name: "amount_text", type: "text" },
    { name: "owner", type: "text", nullable: true },
  ],
  [
    { name: "idx_congress_trades_ticker", columns: ["ticker"] },
    { name: "idx_congress_trades_transacted_at", columns: ["transacted_at"] },
    { name: "idx_congress_trades_member_name", columns: ["member_name"] },
    { name: "idx_congress_trades_bioguide_id", columns: ["bioguide_id"] },
  ],
);

export const INSIDER_TRANSACTIONS_TABLE = datasetTable(
  "insider_transactions",
  [
    { name: "accession_number", type: "text" },
    { name: "form_type", type: "text" },
    { name: "ticker", type: "text", nullable: true },
    { name: "issuer_cik", type: "text" },
    { name: "issuer_name", type: "text" },
    { name: "insider_name", type: "text" },
    { name: "insider_cik", type: "text" },
    { name: "insider_title", type: "text", nullable: true },
    { name: "is_director", type: "boolean" },
    { name: "is_officer", type: "boolean" },
    { name: "is_ten_pct_owner", type: "boolean" },
    { name: "transacted_at", type: "text", nullable: true },
    { name: "filed_at", type: "text" },
    { name: "code", type: "text", nullable: true },
    { name: "acquired_disposed", type: "text", nullable: true },
    { name: "security_title", type: "text" },
    { name: "shares", type: "real", nullable: true },
    { name: "price_per_share", type: "real", nullable: true },
    { name: "shares_owned_after", type: "real", nullable: true },
    { name: "ownership", type: "text" },
    { name: "is_derivative", type: "boolean" },
  ],
  [
    { name: "idx_insider_transactions_ticker", columns: ["ticker"] },
    { name: "idx_insider_transactions_transacted_at", columns: ["transacted_at"] },
    { name: "idx_insider_transactions_insider_name", columns: ["insider_name"] },
    { name: "idx_insider_transactions_issuer_cik", columns: ["issuer_cik"] },
    { name: "idx_insider_transactions_filed_at", columns: ["filed_at"] },
  ],
);

export const THIRTEENF_HOLDINGS_TABLE = datasetTable(
  "thirteenf_holdings",
  [
    { name: "accession_number", type: "text" },
    { name: "manager_cik", type: "text" },
    { name: "manager_name", type: "text" },
    { name: "period_end", type: "text" },
    { name: "filed_at", type: "text" },
    { name: "cusip", type: "text" },
    { name: "ticker", type: "text", nullable: true },
    { name: "issuer_name", type: "text" },
    { name: "share_type", type: "text", nullable: true },
    { name: "shares", type: "real" },
    { name: "value_usd", type: "real" },
    { name: "put_call", type: "text", nullable: true },
  ],
  [
    { name: "idx_thirteenf_holdings_ticker", columns: ["ticker"] },
    { name: "idx_thirteenf_holdings_cusip", columns: ["cusip"] },
    { name: "idx_thirteenf_holdings_manager_cik", columns: ["manager_cik"] },
    { name: "idx_thirteenf_holdings_period_end", columns: ["period_end"] },
  ],
);

export const GOV_CONTRACT_AWARDS_TABLE = datasetTable(
  "gov_contract_awards",
  [
    { name: "award_id", type: "text", nullable: true },
    { name: "award_type", type: "text", nullable: true },
    { name: "agency", type: "text" },
    { name: "sub_agency", type: "text", nullable: true },
    { name: "recipient_name", type: "text" },
    { name: "recipient_uei", type: "text", nullable: true },
    { name: "recipient_tickers", type: "json" },
    { name: "amount_usd", type: "real", nullable: true },
    { name: "action_date", type: "text" },
    { name: "description", type: "text", nullable: true },
    { name: "naics_code", type: "text", nullable: true },
    { name: "naics_description", type: "text", nullable: true },
  ],
  [
    { name: "idx_gov_contract_awards_action_date", columns: ["action_date"] },
    { name: "idx_gov_contract_awards_recipient_name", columns: ["recipient_name"] },
  ],
);

export const LOBBYING_FILINGS_TABLE = datasetTable(
  "lobbying_filings",
  [
    { name: "filing_uuid", type: "text" },
    { name: "registrant_name", type: "text" },
    { name: "client_name", type: "text" },
    { name: "client_tickers", type: "json" },
    { name: "amount_usd", type: "real", nullable: true },
    { name: "filing_year", type: "integer" },
    { name: "filing_period", type: "text" },
    { name: "filing_type", type: "text", nullable: true },
    { name: "issues", type: "json" },
    // Added by migration 0003 on stores that predate it (fresh stores get it
    // from 0001, which always generates from the current spec).
    { name: "bill_references", type: "json" },
  ],
  [
    { name: "idx_lobbying_filings_client_name", columns: ["client_name"] },
    { name: "idx_lobbying_filings_filing_year", columns: ["filing_year"] },
  ],
);

export const SHORT_VOLUME_DAYS_TABLE = datasetTable(
  "short_volume_days",
  [
    { name: "date", type: "text" },
    { name: "ticker", type: "text" },
    { name: "market", type: "text" },
    { name: "short_volume", type: "real" },
    { name: "short_exempt_volume", type: "real" },
    { name: "total_volume", type: "real" },
    { name: "short_ratio", type: "real", nullable: true },
  ],
  [
    { name: "idx_short_volume_days_ticker", columns: ["ticker"] },
    { name: "idx_short_volume_days_date", columns: ["date"] },
  ],
);

export const GOV_GRANT_AWARDS_TABLE = datasetTable(
  "gov_grant_awards",
  [
    { name: "award_id", type: "text", nullable: true },
    { name: "award_type", type: "text", nullable: true },
    { name: "agency", type: "text" },
    { name: "sub_agency", type: "text", nullable: true },
    { name: "recipient_name", type: "text" },
    { name: "recipient_uei", type: "text", nullable: true },
    { name: "recipient_tickers", type: "json" },
    { name: "amount_usd", type: "real", nullable: true },
    { name: "action_date", type: "text" },
    { name: "description", type: "text", nullable: true },
    { name: "naics_code", type: "text", nullable: true },
    { name: "naics_description", type: "text", nullable: true },
  ],
  [
    { name: "idx_gov_grant_awards_action_date", columns: ["action_date"] },
    { name: "idx_gov_grant_awards_recipient_name", columns: ["recipient_name"] },
  ],
);

export const COMMITTEE_ASSIGNMENTS_TABLE = datasetTable(
  "committee_assignments",
  [
    { name: "bioguide_id", type: "text" },
    { name: "member_name", type: "text" },
    { name: "chamber", type: "text" },
    { name: "committee_thomas_id", type: "text" },
    { name: "committee_name", type: "text" },
    { name: "committee_type", type: "text" },
    { name: "subcommittee_thomas_id", type: "text", nullable: true },
    { name: "subcommittee_name", type: "text", nullable: true },
    { name: "rank", type: "integer", nullable: true },
    { name: "title", type: "text", nullable: true },
  ],
  [
    { name: "idx_committee_assignments_bioguide_id", columns: ["bioguide_id"] },
    { name: "idx_committee_assignments_committee", columns: ["committee_thomas_id"] },
    { name: "idx_committee_assignments_member_name", columns: ["member_name"] },
  ],
);

export const PATENTS_TABLE = datasetTable(
  "patents",
  [
    { name: "patent_id", type: "text" },
    { name: "title", type: "text" },
    { name: "grant_date", type: "text" },
    { name: "assignee_name", type: "text", nullable: true },
    { name: "assignee_tickers", type: "json" },
    { name: "assignee_count", type: "integer" },
    { name: "kind", type: "text", nullable: true },
    { name: "cpc_class", type: "text", nullable: true },
  ],
  [
    { name: "idx_patents_grant_date", columns: ["grant_date"] },
    { name: "idx_patents_assignee_name", columns: ["assignee_name"] },
  ],
);

export const CLINICAL_TRIALS_TABLE = datasetTable(
  "clinical_trials",
  [
    { name: "nct_id", type: "text" },
    { name: "title", type: "text" },
    { name: "sponsor_name", type: "text" },
    { name: "sponsor_tickers", type: "json" },
    { name: "phase", type: "text", nullable: true },
    { name: "overall_status", type: "text" },
    { name: "study_type", type: "text", nullable: true },
    { name: "conditions", type: "json" },
    { name: "start_date", type: "text", nullable: true },
    { name: "primary_completion_date", type: "text", nullable: true },
    { name: "last_updated", type: "text" },
  ],
  [
    { name: "idx_clinical_trials_sponsor_name", columns: ["sponsor_name"] },
    { name: "idx_clinical_trials_last_updated", columns: ["last_updated"] },
    { name: "idx_clinical_trials_status", columns: ["overall_status"] },
  ],
);

export const FDA_APPROVALS_TABLE = datasetTable(
  "fda_approvals",
  [
    { name: "application_number", type: "text" },
    { name: "sponsor_name", type: "text" },
    { name: "sponsor_tickers", type: "json" },
    { name: "brand_name", type: "text", nullable: true },
    { name: "submission_type", type: "text" },
    { name: "submission_number", type: "text" },
    { name: "submission_status", type: "text", nullable: true },
    { name: "status_date", type: "text" },
  ],
  [
    { name: "idx_fda_approvals_status_date", columns: ["status_date"] },
    { name: "idx_fda_approvals_sponsor_name", columns: ["sponsor_name"] },
  ],
);

export const COT_REPORTS_TABLE = datasetTable(
  "cot_reports",
  [
    { name: "report_date", type: "text" },
    { name: "contract_code", type: "text" },
    { name: "market_name", type: "text" },
    { name: "open_interest", type: "real" },
    { name: "commercial_long", type: "real" },
    { name: "commercial_short", type: "real" },
    { name: "non_commercial_long", type: "real" },
    { name: "non_commercial_short", type: "real" },
    { name: "non_reportable_long", type: "real" },
    { name: "non_reportable_short", type: "real" },
  ],
  [
    { name: "idx_cot_reports_report_date", columns: ["report_date"] },
    { name: "idx_cot_reports_contract_code", columns: ["contract_code"] },
    { name: "idx_cot_reports_market_name", columns: ["market_name"] },
  ],
);

export const WIKI_PAGEVIEWS_TABLE = datasetTable(
  "wiki_pageviews",
  [
    { name: "project", type: "text" },
    { name: "article", type: "text" },
    { name: "day", type: "text" },
    { name: "views", type: "integer" },
    { name: "tickers", type: "json" },
  ],
  [
    { name: "idx_wiki_pageviews_article", columns: ["article"] },
    { name: "idx_wiki_pageviews_day", columns: ["day"] },
  ],
);

export const BILLS_TABLE = datasetTable(
  "bills",
  [
    { name: "congress", type: "integer" },
    { name: "bill_type", type: "text" },
    { name: "bill_number", type: "integer" },
    { name: "title", type: "text" },
    { name: "introduced_date", type: "text" },
    { name: "latest_action_date", type: "text", nullable: true },
    { name: "latest_action_text", type: "text", nullable: true },
    { name: "sponsor_bioguide_id", type: "text", nullable: true },
    { name: "sponsor_name", type: "text", nullable: true },
    { name: "policy_area", type: "text", nullable: true },
    { name: "cosponsor_count", type: "integer" },
  ],
  [
    { name: "idx_bills_congress_type", columns: ["congress", "bill_type"] },
    { name: "idx_bills_latest_action_date", columns: ["latest_action_date"] },
    { name: "idx_bills_sponsor_bioguide_id", columns: ["sponsor_bioguide_id"] },
  ],
);

export const FEC_CANDIDATES_TABLE = datasetTable(
  "fec_candidates",
  [
    { name: "candidate_id", type: "text" },
    { name: "cycle", type: "integer" },
    { name: "name", type: "text" },
    { name: "party", type: "text", nullable: true },
    { name: "office", type: "text" },
    { name: "state", type: "text", nullable: true },
    { name: "district", type: "text", nullable: true },
    { name: "incumbent_challenger", type: "text", nullable: true },
    { name: "total_receipts", type: "real", nullable: true },
    { name: "total_disbursements", type: "real", nullable: true },
    { name: "cash_on_hand", type: "real", nullable: true },
    { name: "coverage_end_date", type: "text", nullable: true },
  ],
  [
    { name: "idx_fec_candidates_candidate_id", columns: ["candidate_id"] },
    { name: "idx_fec_candidates_cycle", columns: ["cycle"] },
    { name: "idx_fec_candidates_name", columns: ["name"] },
  ],
);

export const FEC_CONTRIBUTIONS_TABLE = datasetTable(
  "fec_contributions",
  [
    { name: "committee_id", type: "text" },
    { name: "committee_name", type: "text", nullable: true },
    { name: "candidate_id", type: "text" },
    { name: "candidate_name", type: "text", nullable: true },
    { name: "amount_usd", type: "real" },
    { name: "date", type: "text", nullable: true },
    { name: "transaction_type", type: "text" },
    { name: "cycle", type: "integer" },
  ],
  [
    { name: "idx_fec_contributions_candidate_id", columns: ["candidate_id"] },
    { name: "idx_fec_contributions_committee_id", columns: ["committee_id"] },
    { name: "idx_fec_contributions_date", columns: ["date"] },
  ],
);

/** Meta tables: sync bookkeeping, canaries, entity-resolution caches. */

export const WATERMARKS_TABLE: TableSpec = {
  name: "watermarks",
  columns: [
    { name: "source", type: "text" },
    { name: "key", type: "text" },
    { name: "value", type: "text" },
    { name: "updated_at", type: "text" },
  ],
  primaryKey: ["source", "key"],
  indexes: [],
};

export const SYNC_RUNS_TABLE: TableSpec = {
  name: "sync_runs",
  columns: [
    { name: "id", type: "text" },
    { name: "source", type: "text" },
    { name: "started_at", type: "text" },
    { name: "finished_at", type: "text", nullable: true },
    { name: "ok", type: "boolean", nullable: true },
    { name: "rows_upserted", type: "integer" },
    { name: "parse_attempted", type: "integer" },
    { name: "parse_succeeded", type: "integer" },
    { name: "error", type: "text", nullable: true },
    { name: "details", type: "json", nullable: true },
  ],
  primaryKey: ["id"],
  indexes: [{ name: "idx_sync_runs_source_started_at", columns: ["source", "started_at"] }],
};

export const CANARY_RUNS_TABLE: TableSpec = {
  name: "canary_runs",
  columns: [
    { name: "id", type: "text" },
    { name: "source", type: "text" },
    { name: "ran_at", type: "text" },
    { name: "status", type: "text" },
    { name: "checks", type: "json" },
  ],
  primaryKey: ["id"],
  indexes: [{ name: "idx_canary_runs_source_ran_at", columns: ["source", "ran_at"] }],
};

export const FINGERPRINTS_TABLE: TableSpec = {
  name: "fingerprints",
  columns: [
    { name: "source", type: "text" },
    { name: "key", type: "text" },
    { name: "hash", type: "text" },
    { name: "updated_at", type: "text" },
  ],
  primaryKey: ["source", "key"],
  indexes: [],
};

export const FETCH_CACHE_TABLE: TableSpec = {
  name: "fetch_cache",
  columns: [
    { name: "url", type: "text" },
    { name: "etag", type: "text", nullable: true },
    { name: "last_modified", type: "text", nullable: true },
    { name: "fetched_at", type: "text" },
  ],
  primaryKey: ["url"],
  indexes: [],
};

export const CIK_TICKERS_TABLE: TableSpec = {
  name: "cik_tickers",
  columns: [
    { name: "cik", type: "text" },
    { name: "ticker", type: "text" },
    { name: "name", type: "text" },
    { name: "refreshed_at", type: "text" },
  ],
  primaryKey: ["cik", "ticker"],
  indexes: [{ name: "idx_cik_tickers_ticker", columns: ["ticker"] }],
};

export const CUSIP_MAP_TABLE: TableSpec = {
  name: "cusip_map",
  columns: [
    { name: "cusip", type: "text" },
    { name: "ticker", type: "text", nullable: true },
    { name: "figi", type: "text", nullable: true },
    { name: "name", type: "text", nullable: true },
    { name: "map_source", type: "text" },
    { name: "resolved_at", type: "text" },
  ],
  primaryKey: ["cusip"],
  indexes: [],
};

export const MEMBER_MAP_TABLE: TableSpec = {
  name: "member_map",
  columns: [
    { name: "bioguide_id", type: "text" },
    { name: "full_name", type: "text" },
    { name: "first_name", type: "text" },
    { name: "last_name", type: "text" },
    { name: "chamber", type: "text" },
    { name: "party", type: "text", nullable: true },
    { name: "state", type: "text", nullable: true },
    { name: "refreshed_at", type: "text" },
  ],
  primaryKey: ["bioguide_id"],
  indexes: [{ name: "idx_member_map_last_name", columns: ["last_name"] }],
};

export const META_TABLES: TableSpec[] = [
  WATERMARKS_TABLE,
  SYNC_RUNS_TABLE,
  CANARY_RUNS_TABLE,
  FINGERPRINTS_TABLE,
  FETCH_CACHE_TABLE,
  CIK_TICKERS_TABLE,
  CUSIP_MAP_TABLE,
  MEMBER_MAP_TABLE,
];

/**
 * Migration cohorts. V1 is FROZEN — it is exactly what migration 0001
 * created on existing stores; never add to it. New tables join a new cohort
 * with a new migration (see store/migrate.ts).
 */
export const V1_TABLES: TableSpec[] = [
  CONGRESS_TRADES_TABLE,
  INSIDER_TRANSACTIONS_TABLE,
  THIRTEENF_HOLDINGS_TABLE,
  GOV_CONTRACT_AWARDS_TABLE,
  LOBBYING_FILINGS_TABLE,
  SHORT_VOLUME_DAYS_TABLE,
  ...META_TABLES,
];

export const V2_TABLES: TableSpec[] = [
  GOV_GRANT_AWARDS_TABLE,
  COMMITTEE_ASSIGNMENTS_TABLE,
  PATENTS_TABLE,
  CLINICAL_TRIALS_TABLE,
  FDA_APPROVALS_TABLE,
  COT_REPORTS_TABLE,
];

export const V3_TABLES: TableSpec[] = [
  WIKI_PAGEVIEWS_TABLE,
  BILLS_TABLE,
  FEC_CANDIDATES_TABLE,
  FEC_CONTRIBUTIONS_TABLE,
];

export const DATASET_TABLES: TableSpec[] = [
  CONGRESS_TRADES_TABLE,
  INSIDER_TRANSACTIONS_TABLE,
  THIRTEENF_HOLDINGS_TABLE,
  GOV_CONTRACT_AWARDS_TABLE,
  GOV_GRANT_AWARDS_TABLE,
  LOBBYING_FILINGS_TABLE,
  SHORT_VOLUME_DAYS_TABLE,
  COMMITTEE_ASSIGNMENTS_TABLE,
  PATENTS_TABLE,
  CLINICAL_TRIALS_TABLE,
  FDA_APPROVALS_TABLE,
  COT_REPORTS_TABLE,
  WIKI_PAGEVIEWS_TABLE,
  BILLS_TABLE,
  FEC_CANDIDATES_TABLE,
  FEC_CONTRIBUTIONS_TABLE,
];

export const ALL_TABLES: TableSpec[] = [...V1_TABLES, ...V2_TABLES, ...V3_TABLES];

export function tableSpecByName(name: string): TableSpec {
  const spec = ALL_TABLES.find((t) => t.name === name);
  if (!spec) throw new Error(`Unknown table '${name}'`);
  return spec;
}
