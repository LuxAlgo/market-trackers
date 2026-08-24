import { DATASETS, ALL_DATASETS, type DatasetId } from "../schema/datasets.js";
import { SOURCE_IDS, type SourceId } from "../schema/provenance.js";
import type { CongressTrade } from "../schema/congress-trade.js";
import type { InsiderTransaction } from "../schema/insider-transaction.js";
import type { ThirteenfHolding } from "../schema/thirteenf-holding.js";
import type { GovContractAward } from "../schema/gov-contract-award.js";
import type { LobbyingFiling } from "../schema/lobbying-filing.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";
import { hoursSince } from "../lib/dates.js";
import type { CanaryRunRecord, DocketStore, SyncRunRecord } from "./store.js";
import { mapperFor } from "./rows.js";

/**
 * The typed query layer the MCP tools and CLI sit on. All SQL here is
 * portable across the SQLite and Postgres drivers (case-insensitive matching
 * via lower(), `?` placeholders, no dialect-specific functions).
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

interface WhereBuilder {
  clauses: string[];
  params: unknown[];
}

function where(): WhereBuilder {
  return { clauses: [], params: [] };
}

function add(b: WhereBuilder, clause: string, ...params: unknown[]) {
  b.clauses.push(clause);
  b.params.push(...params);
}

function contains(b: WhereBuilder, column: string, needle: string) {
  add(b, `lower(${column}) LIKE ?`, `%${needle.toLowerCase()}%`);
}

function sql(b: WhereBuilder): string {
  return b.clauses.length ? `WHERE ${b.clauses.join(" AND ")}` : "";
}

async function run<T>(
  store: DocketStore,
  datasetId: DatasetId,
  b: WhereBuilder,
  orderBy: string,
  limit?: number,
): Promise<T[]> {
  const dataset = DATASETS[datasetId];
  const mapper = mapperFor<T>(datasetId);
  const rows = await store.driver.all(
    `SELECT * FROM "${dataset.table}" ${sql(b)} ORDER BY ${orderBy} LIMIT ?`,
    [...b.params, clampLimit(limit)],
  );
  return rows.map((row) => mapper.fromRow(row as Record<string, unknown>));
}

// ── Congress ──────────────────────────────────────────────────────────────

export interface CongressTradeFilters {
  ticker?: string;
  member?: string;
  chamber?: "senate" | "house";
  since?: string;
  until?: string;
  side?: "buy" | "sell" | "exchange";
  needsReview?: boolean;
  limit?: number;
}

export async function queryCongressTrades(
  store: DocketStore,
  f: CongressTradeFilters = {},
): Promise<CongressTrade[]> {
  const b = where();
  if (f.ticker) add(b, `"ticker" = ?`, f.ticker.toUpperCase());
  if (f.member) contains(b, `"member_name"`, f.member);
  if (f.chamber) add(b, `"chamber" = ?`, f.chamber);
  if (f.since) add(b, `"transacted_at" >= ?`, f.since);
  if (f.until) add(b, `"transacted_at" <= ?`, f.until);
  if (f.side) add(b, `"side" = ?`, f.side);
  if (f.needsReview !== undefined) add(b, `"needs_review" = ?`, f.needsReview);
  return run(store, "congress-trades", b, `"transacted_at" DESC, "id"`, f.limit);
}

export interface CongressMemberSummary {
  name: string;
  bioguideId: string | null;
  chamber: "senate" | "house";
  party: string | null;
  state: string | null;
  tradeCount: number;
  lastTransactedAt: string | null;
}

export async function queryCongressMembers(
  store: DocketStore,
  q?: string,
  limit?: number,
): Promise<CongressMemberSummary[]> {
  const b = where();
  if (q) contains(b, `"member_name"`, q);
  const rows = await store.driver.all<Record<string, unknown>>(
    `SELECT "member_name", "bioguide_id", "chamber", "party", "state", COUNT(*) AS trade_count, MAX("transacted_at") AS last_transacted_at ` +
      `FROM "congress_trades" ${sql(b)} ` +
      `GROUP BY "member_name", "bioguide_id", "chamber", "party", "state" ` +
      `ORDER BY trade_count DESC, "member_name" LIMIT ?`,
    [...b.params, clampLimit(limit)],
  );
  return rows.map((r) => ({
    name: String(r.member_name),
    bioguideId: r.bioguide_id === null ? null : String(r.bioguide_id),
    chamber: r.chamber as "senate" | "house",
    party: r.party === null ? null : String(r.party),
    state: r.state === null ? null : String(r.state),
    tradeCount: Number(r.trade_count),
    lastTransactedAt: r.last_transacted_at === null ? null : String(r.last_transacted_at),
  }));
}

// ── Insider ───────────────────────────────────────────────────────────────

export interface InsiderTransactionFilters {
  ticker?: string;
  insiderName?: string;
  codes?: string[];
  since?: string;
  until?: string;
  /** Minimum |shares × pricePerShare| in USD. */
  minValue?: number;
  isDerivative?: boolean;
  limit?: number;
}

export async function queryInsiderTransactions(
  store: DocketStore,
  f: InsiderTransactionFilters = {},
): Promise<InsiderTransaction[]> {
  const b = where();
  if (f.ticker) add(b, `"ticker" = ?`, f.ticker.toUpperCase());
  if (f.insiderName) contains(b, `"insider_name"`, f.insiderName);
  if (f.codes && f.codes.length > 0) {
    add(
      b,
      `"code" IN (${f.codes.map(() => "?").join(", ")})`,
      ...f.codes.map((c) => c.toUpperCase()),
    );
  }
  if (f.since) add(b, `"transacted_at" >= ?`, f.since);
  if (f.until) add(b, `"transacted_at" <= ?`, f.until);
  if (f.minValue !== undefined) {
    add(
      b,
      `"shares" IS NOT NULL AND "price_per_share" IS NOT NULL AND ("shares" * "price_per_share") >= ?`,
      f.minValue,
    );
  }
  if (f.isDerivative !== undefined) add(b, `"is_derivative" = ?`, f.isDerivative);
  return run(store, "insider-transactions", b, `"transacted_at" DESC, "id"`, f.limit);
}

export interface InsiderSummary {
  ticker: string;
  since: string;
  codeBreakdown: {
    code: string;
    transactions: number;
    totalShares: number;
    totalValueUsd: number | null;
  }[];
  openMarket: {
    buys: number;
    sells: number;
    netShares: number;
  };
  notableInsiders: {
    name: string;
    title: string | null;
    transactions: number;
    totalValueUsd: number | null;
  }[];
}

export async function insiderSummary(
  store: DocketStore,
  ticker: string,
  since: string,
): Promise<InsiderSummary> {
  const t = ticker.toUpperCase();
  const codeRows = await store.driver.all<Record<string, unknown>>(
    `SELECT "code", COUNT(*) AS n, SUM("shares") AS total_shares, SUM("shares" * "price_per_share") AS total_value ` +
      `FROM "insider_transactions" WHERE "ticker" = ? AND "transacted_at" >= ? AND "code" IS NOT NULL AND "is_derivative" = ? ` +
      `GROUP BY "code" ORDER BY n DESC`,
    [t, since, false],
  );
  const codeBreakdown = codeRows.map((r) => ({
    code: String(r.code),
    transactions: Number(r.n),
    totalShares: Number(r.total_shares ?? 0),
    totalValueUsd: r.total_value === null ? null : Number(r.total_value),
  }));

  const buys = codeBreakdown.find((c) => c.code === "P");
  const sells = codeBreakdown.find((c) => c.code === "S");

  const insiderRows = await store.driver.all<Record<string, unknown>>(
    `SELECT "insider_name", "insider_title", COUNT(*) AS n, SUM("shares" * "price_per_share") AS total_value ` +
      `FROM "insider_transactions" WHERE "ticker" = ? AND "transacted_at" >= ? ` +
      `GROUP BY "insider_name", "insider_title" ORDER BY total_value DESC LIMIT 10`,
    [t, since],
  );

  return {
    ticker: t,
    since,
    codeBreakdown,
    openMarket: {
      buys: buys?.transactions ?? 0,
      sells: sells?.transactions ?? 0,
      netShares: (buys?.totalShares ?? 0) - (sells?.totalShares ?? 0),
    },
    notableInsiders: insiderRows.map((r) => ({
      name: String(r.insider_name),
      title: r.insider_title === null ? null : String(r.insider_title),
      transactions: Number(r.n),
      totalValueUsd: r.total_value === null ? null : Number(r.total_value),
    })),
  };
}

// ── 13F ───────────────────────────────────────────────────────────────────

export interface ThirteenfHolderRow {
  managerCik: string;
  managerName: string;
  periodEnd: string;
  shares: number;
  valueUsd: number;
  putCall: "put" | "call" | null;
  sharesPriorPeriod: number | null;
  sharesChange: number | null;
  sourceUrl: string;
}

/** Available reporting periods for a ticker or cusip, newest first. */
async function thirteenfPeriods(
  store: DocketStore,
  key: { ticker?: string; cusip?: string; managerCik?: string },
): Promise<string[]> {
  const b = where();
  if (key.ticker) add(b, `"ticker" = ?`, key.ticker.toUpperCase());
  if (key.cusip) add(b, `"cusip" = ?`, key.cusip);
  if (key.managerCik) add(b, `"manager_cik" = ?`, key.managerCik);
  const rows = await store.driver.all<{ p: string }>(
    `SELECT DISTINCT "period_end" AS p FROM "thirteenf_holdings" ${sql(b)} ORDER BY p DESC`,
    b.params,
  );
  return rows.map((r) => r.p);
}

export async function queryThirteenfHolders(
  store: DocketStore,
  key: { ticker?: string; cusip?: string },
  periodEnd?: string,
  limit?: number,
): Promise<{
  periodEnd: string | null;
  priorPeriodEnd: string | null;
  holders: ThirteenfHolderRow[];
}> {
  if (!key.ticker && !key.cusip) throw new Error("queryThirteenfHolders requires ticker or cusip");
  const periods = await thirteenfPeriods(store, key);
  const period = periodEnd ?? periods[0] ?? null;
  if (!period) return { periodEnd: null, priorPeriodEnd: null, holders: [] };
  const prior = periods.find((p) => p < period) ?? null;

  const b = where();
  if (key.ticker) add(b, `"ticker" = ?`, key.ticker.toUpperCase());
  if (key.cusip) add(b, `"cusip" = ?`, key.cusip);
  add(b, `"period_end" = ?`, period);
  const rows = await store.driver.all<Record<string, unknown>>(
    `SELECT "manager_cik", "manager_name", "period_end", "put_call", "source_url", SUM("shares") AS shares, SUM("value_usd") AS value_usd ` +
      `FROM "thirteenf_holdings" ${sql(b)} ` +
      `GROUP BY "manager_cik", "manager_name", "period_end", "put_call", "source_url" ` +
      `ORDER BY value_usd DESC LIMIT ?`,
    [...b.params, clampLimit(limit)],
  );

  let priorByManager = new Map<string, number>();
  if (prior) {
    const pb = where();
    if (key.ticker) add(pb, `"ticker" = ?`, key.ticker.toUpperCase());
    if (key.cusip) add(pb, `"cusip" = ?`, key.cusip);
    add(pb, `"period_end" = ?`, prior);
    const priorRows = await store.driver.all<Record<string, unknown>>(
      `SELECT "manager_cik", "put_call", SUM("shares") AS shares FROM "thirteenf_holdings" ${sql(pb)} GROUP BY "manager_cik", "put_call"`,
      pb.params,
    );
    priorByManager = new Map(
      priorRows.map((r) => [`${String(r.manager_cik)}:${r.put_call ?? ""}`, Number(r.shares)]),
    );
  }

  return {
    periodEnd: period,
    priorPeriodEnd: prior,
    holders: rows.map((r) => {
      const putCall = (r.put_call ?? null) as "put" | "call" | null;
      const priorShares = priorByManager.get(`${String(r.manager_cik)}:${putCall ?? ""}`) ?? null;
      const shares = Number(r.shares);
      return {
        managerCik: String(r.manager_cik),
        managerName: String(r.manager_name),
        periodEnd: String(r.period_end),
        shares,
        valueUsd: Number(r.value_usd),
        putCall,
        sharesPriorPeriod: priorShares,
        sharesChange: priorShares === null ? null : shares - priorShares,
        sourceUrl: String(r.source_url),
      };
    }),
  };
}

export async function queryThirteenfManager(
  store: DocketStore,
  key: { managerCik?: string; q?: string },
  periodEnd?: string,
  limit?: number,
): Promise<{
  managerCik: string | null;
  managerName: string | null;
  periodEnd: string | null;
  holdings: ThirteenfHolding[];
}> {
  let managerCik = key.managerCik ?? null;
  let managerName: string | null = null;
  if (!managerCik && key.q) {
    const row = await store.driver.get<Record<string, unknown>>(
      `SELECT "manager_cik", "manager_name", COUNT(*) AS n FROM "thirteenf_holdings" WHERE lower("manager_name") LIKE ? ` +
        `GROUP BY "manager_cik", "manager_name" ORDER BY n DESC LIMIT 1`,
      [`%${key.q.toLowerCase()}%`],
    );
    if (row) {
      managerCik = String(row.manager_cik);
      managerName = String(row.manager_name);
    }
  }
  if (!managerCik) return { managerCik: null, managerName: null, periodEnd: null, holdings: [] };

  const periods = await thirteenfPeriods(store, { managerCik });
  const period = periodEnd ?? periods[0] ?? null;
  if (!period) return { managerCik, managerName, periodEnd: null, holdings: [] };

  const b = where();
  add(b, `"manager_cik" = ?`, managerCik);
  add(b, `"period_end" = ?`, period);
  const holdings = await run<ThirteenfHolding>(
    store,
    "thirteenf-holdings",
    b,
    `"value_usd" DESC, "id"`,
    limit,
  );
  return {
    managerCik,
    managerName: managerName ?? holdings[0]?.managerName ?? null,
    periodEnd: period,
    holdings,
  };
}

// ── Contracts & lobbying ──────────────────────────────────────────────────

export interface GovContractFilters {
  ticker?: string;
  recipient?: string;
  agency?: string;
  since?: string;
  minAmount?: number;
  limit?: number;
}

export async function queryGovContracts(
  store: DocketStore,
  f: GovContractFilters = {},
): Promise<GovContractAward[]> {
  const b = where();
  // tickers are stored as a JSON array of upper-case strings; exact-quoted
  // containment is portable and safe because tickers are [A-Z0-9.-] only.
  if (f.ticker) add(b, `"recipient_tickers" LIKE ?`, `%"${f.ticker.toUpperCase()}"%`);
  if (f.recipient) contains(b, `"recipient_name"`, f.recipient);
  if (f.agency) contains(b, `"agency"`, f.agency);
  if (f.since) add(b, `"action_date" >= ?`, f.since);
  if (f.minAmount !== undefined) add(b, `"amount_usd" >= ?`, f.minAmount);
  return run(store, "gov-contracts", b, `"action_date" DESC, "id"`, f.limit);
}

export interface LobbyingFilters {
  ticker?: string;
  client?: string;
  registrant?: string;
  sinceYear?: number;
  limit?: number;
}

export async function queryLobbying(
  store: DocketStore,
  f: LobbyingFilters = {},
): Promise<LobbyingFiling[]> {
  const b = where();
  if (f.ticker) add(b, `"client_tickers" LIKE ?`, `%"${f.ticker.toUpperCase()}"%`);
  if (f.client) contains(b, `"client_name"`, f.client);
  if (f.registrant) contains(b, `"registrant_name"`, f.registrant);
  if (f.sinceYear !== undefined) add(b, `"filing_year" >= ?`, f.sinceYear);
  return run(store, "lobbying-filings", b, `"filing_year" DESC, "id"`, f.limit);
}

// ── Short volume ──────────────────────────────────────────────────────────

export async function queryShortVolume(
  store: DocketStore,
  ticker: string,
  from: string,
  to: string,
): Promise<ShortVolumeDay[]> {
  const b = where();
  add(b, `"ticker" = ?`, ticker.toUpperCase());
  add(b, `"date" >= ?`, from);
  add(b, `"date" <= ?`, to);
  const dataset = DATASETS["short-volume"];
  const mapper = mapperFor<ShortVolumeDay>("short-volume");
  const rows = await store.driver.all(
    `SELECT * FROM "${dataset.table}" ${sql(b)} ORDER BY "date" ASC, "id"`,
    b.params,
  );
  return rows.map((row) => mapper.fromRow(row as Record<string, unknown>));
}

// ── Cross-dataset entity search ───────────────────────────────────────────

export interface EntitySearchResult {
  kind: "ticker" | "member" | "manager" | "insider";
  name: string;
  ticker?: string;
  bioguideId?: string | null;
  managerCik?: string;
  matches: { dataset: DatasetId; rows: number }[];
}

export async function searchEntities(
  store: DocketStore,
  q: string,
  limit = 10,
): Promise<EntitySearchResult[]> {
  const needle = `%${q.toLowerCase()}%`;
  const results: EntitySearchResult[] = [];

  const tickerRows = await store.driver.all<Record<string, unknown>>(
    `SELECT "ticker", "name", COUNT(*) AS n FROM "cik_tickers" WHERE lower("ticker") LIKE ? OR lower("name") LIKE ? ` +
      `GROUP BY "ticker", "name" ORDER BY n DESC LIMIT ?`,
    [needle, needle, limit],
  );
  for (const row of tickerRows) {
    const ticker = String(row.ticker);
    const matches: { dataset: DatasetId; rows: number }[] = [];
    for (const dataset of ALL_DATASETS) {
      const spec =
        dataset.id === "gov-contracts" || dataset.id === "lobbying-filings" ? null : "ticker";
      if (!spec) continue;
      const countRow = await store.driver.get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM "${dataset.table}" WHERE "ticker" = ?`,
        [ticker],
      );
      const n = Number(countRow?.n ?? 0);
      if (n > 0) matches.push({ dataset: dataset.id, rows: n });
    }
    results.push({ kind: "ticker", name: String(row.name), ticker, matches });
  }

  const memberRows = await queryCongressMembers(store, q, limit);
  for (const member of memberRows) {
    results.push({
      kind: "member",
      name: member.name,
      bioguideId: member.bioguideId,
      matches: [{ dataset: "congress-trades", rows: member.tradeCount }],
    });
  }

  const managerRows = await store.driver.all<Record<string, unknown>>(
    `SELECT "manager_cik", "manager_name", COUNT(*) AS n FROM "thirteenf_holdings" WHERE lower("manager_name") LIKE ? ` +
      `GROUP BY "manager_cik", "manager_name" ORDER BY n DESC LIMIT ?`,
    [needle, limit],
  );
  for (const row of managerRows) {
    results.push({
      kind: "manager",
      name: String(row.manager_name),
      managerCik: String(row.manager_cik),
      matches: [{ dataset: "thirteenf-holdings", rows: Number(row.n) }],
    });
  }

  const insiderRows = await store.driver.all<Record<string, unknown>>(
    `SELECT "insider_name", COUNT(*) AS n FROM "insider_transactions" WHERE lower("insider_name") LIKE ? ` +
      `GROUP BY "insider_name" ORDER BY n DESC LIMIT ?`,
    [needle, limit],
  );
  for (const row of insiderRows) {
    results.push({
      kind: "insider",
      name: String(row.insider_name),
      matches: [{ dataset: "insider-transactions", rows: Number(row.n) }],
    });
  }

  return results.slice(0, Math.max(limit, 10));
}

// ── Freshness ─────────────────────────────────────────────────────────────

export interface DatasetFreshness {
  dataset: DatasetId;
  rowCount: number;
  lastIngestedAt: string | null;
  ageHours: number | null;
  freshnessWindowHours: number;
  stale: boolean;
}

export interface SourceFreshness {
  source: SourceId;
  lastSync: SyncRunRecord | null;
  lastCanary: CanaryRunRecord | null;
  watermarks: { key: string; value: string; updatedAt: string }[];
}

export interface FreshnessReport {
  generatedAt: string;
  datasets: DatasetFreshness[];
  sources: SourceFreshness[];
}

export async function freshnessReport(
  store: DocketStore,
  now = new Date(),
): Promise<FreshnessReport> {
  const datasets: DatasetFreshness[] = [];
  for (const dataset of ALL_DATASETS) {
    const rowCount = await store.count(dataset.id);
    const lastIngestedAt = await store.maxRetrievedAt(dataset.id);
    const ageHours =
      lastIngestedAt === null ? null : Math.round(hoursSince(lastIngestedAt, now) * 10) / 10;
    datasets.push({
      dataset: dataset.id,
      rowCount,
      lastIngestedAt,
      ageHours,
      freshnessWindowHours: dataset.freshnessWindowHours,
      stale: ageHours === null ? true : ageHours > dataset.freshnessWindowHours,
    });
  }

  const watermarks = await store.allWatermarks();
  const sources: SourceFreshness[] = [];
  for (const source of SOURCE_IDS) {
    sources.push({
      source,
      lastSync: await store.latestSyncRun(source),
      lastCanary: await store.latestCanaryRun(source),
      watermarks: watermarks
        .filter((w) => w.source === source)
        .map((w) => ({ key: w.key, value: w.value, updatedAt: w.updatedAt })),
    });
  }

  return { generatedAt: now.toISOString(), datasets, sources };
}
