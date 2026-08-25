import { z } from "zod";
import type { DatasetDefinition, DatasetId } from "../schema/datasets.js";
import { ALL_DATASETS, datasetById } from "../schema/datasets.js";
import type { SourceId } from "../schema/provenance.js";
import { addDays, isoNow } from "../lib/dates.js";
import type { SqlDriver } from "./sql-driver.js";
import { createDriver } from "./sql-driver.js";
import { migrate } from "./migrate.js";
import { tableSpecByName } from "./table-specs.js";
import { mapperFor } from "./rows.js";

/**
 * The LuxAlgo Alt Data store: idempotent upserts by natural key, per-source
 * watermarks, sync/canary bookkeeping, and entity-resolution caches. All
 * writes validate through the dataset's zod schema first — nothing enters
 * the database that the published schema doesn't describe.
 */

export interface UpsertResult {
  rows: number;
}

export interface SyncRunRecord {
  id: string;
  source: SourceId;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  rowsUpserted: number;
  parseAttempted: number;
  parseSucceeded: number;
  error: string | null;
  details: Record<string, unknown> | null;
}

export type CanaryStatus = "green" | "amber" | "red" | "skip";

export interface CanaryCheck {
  name: string;
  ok: boolean;
  note?: string;
}

export interface CanaryRunRecord {
  id: string;
  source: SourceId;
  ranAt: string;
  status: CanaryStatus;
  checks: CanaryCheck[];
}

export interface CikTickerEntry {
  cik: string;
  ticker: string;
  name: string;
}

export interface CusipMapEntry {
  cusip: string;
  ticker: string | null;
  figi: string | null;
  name: string | null;
  mapSource: string;
}

export interface MemberMapEntry {
  bioguideId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  chamber: "senate" | "house";
  party: string | null;
  state: string | null;
}

const boolFrom = (v: unknown): boolean => v === true || v === 1;

export class AltDataStore {
  private constructor(
    public readonly driver: SqlDriver,
    public readonly url: string,
  ) {}

  /**
   * Opens (and migrates) a store. `url` accepts a SQLite path (default),
   * "sqlite:path", ":memory:", or a postgres:// connection string.
   */
  static async open(url: string): Promise<AltDataStore> {
    const driver = await createDriver(url);
    await migrate(driver);
    return new AltDataStore(driver, url);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ── Dataset rows ────────────────────────────────────────────────────────

  /**
   * Validates and upserts records by natural key. Re-running a sync never
   * duplicates: an existing id is overwritten with the fresh row.
   */
  async upsert<T>(dataset: DatasetDefinition<T>, records: T[]): Promise<UpsertResult> {
    if (records.length === 0) return { rows: 0 };
    const spec = tableSpecByName(dataset.table);
    const mapper = mapperFor<T>(dataset.id);
    const columns = spec.columns.map((c) => c.name);

    const rows = records.map((record, i) => {
      const parsed = dataset.schema.safeParse(record);
      if (!parsed.success) {
        throw new Error(
          `Invalid ${dataset.id} record at index ${i}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      const row = mapper.toRow(parsed.data);
      return columns.map((c) => row[c] ?? null);
    });

    const chunkSize = Math.max(1, Math.floor(this.driver.maxParams / columns.length));
    const nonPk = columns.filter((c) => !spec.primaryKey.includes(c));
    const updates = nonPk.map((c) => `"${c}" = excluded."${c}"`).join(", ");

    await this.driver.transaction(async () => {
      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
        const sql =
          `INSERT INTO "${dataset.table}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
          `VALUES ${placeholders} ` +
          `ON CONFLICT (${spec.primaryKey.map((c) => `"${c}"`).join(", ")}) DO UPDATE SET ${updates}`;
        await this.driver.run(sql, chunk.flat());
      }
    });

    return { rows: rows.length };
  }

  async count(datasetId: DatasetId): Promise<number> {
    const dataset = datasetById(datasetId);
    const row = await this.driver.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM "${dataset.table}"`,
    );
    return Number(row?.n ?? 0);
  }

  async counts(): Promise<Record<DatasetId, number>> {
    const out = {} as Record<DatasetId, number>;
    for (const dataset of ALL_DATASETS) {
      out[dataset.id] = await this.count(dataset.id);
    }
    return out;
  }

  async maxRetrievedAt(datasetId: DatasetId): Promise<string | null> {
    const dataset = datasetById(datasetId);
    const row = await this.driver.get<{ m: string | null }>(
      `SELECT MAX("retrieved_at") AS m FROM "${dataset.table}"`,
    );
    return row?.m ?? null;
  }

  /** Streams every record of a dataset in stable id order (keyset pagination). */
  async *iterate<T>(dataset: DatasetDefinition<T>, batchSize = 2_000): AsyncGenerator<T> {
    const mapper = mapperFor<T>(dataset.id);
    let after = "";
    for (;;) {
      const rows = await this.driver.all(
        `SELECT * FROM "${dataset.table}" WHERE "id" > ? ORDER BY "id" LIMIT ?`,
        [after, batchSize],
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        yield mapper.fromRow(row as Record<string, unknown>);
      }
      after = String((rows[rows.length - 1] as Record<string, unknown>).id);
    }
  }

  /** Distinct ingestion days (YYYY-MM-DD of retrieved_at) present for a dataset. */
  async ingestionDays(datasetId: DatasetId): Promise<string[]> {
    const dataset = datasetById(datasetId);
    const rows = await this.driver.all<{ d: string }>(
      `SELECT DISTINCT substr("retrieved_at", 1, 10) AS d FROM "${dataset.table}" ORDER BY d`,
    );
    return rows.map((r) => r.d);
  }

  /** Records ingested on a given day (delta export unit). */
  async rowsIngestedOn<T>(dataset: DatasetDefinition<T>, day: string): Promise<T[]> {
    const mapper = mapperFor<T>(dataset.id);
    const rows = await this.driver.all(
      `SELECT * FROM "${dataset.table}" WHERE "retrieved_at" >= ? AND "retrieved_at" < ? ORDER BY "id"`,
      [`${day}T00:00:00`, `${addDays(day, 1)}T00:00:00`],
    );
    return rows.map((row) => mapper.fromRow(row as Record<string, unknown>));
  }

  // ── Watermarks ──────────────────────────────────────────────────────────

  async getWatermark(source: SourceId, key: string): Promise<string | null> {
    const row = await this.driver.get<{ value: string }>(
      `SELECT "value" FROM "watermarks" WHERE "source" = ? AND "key" = ?`,
      [source, key],
    );
    return row?.value ?? null;
  }

  async setWatermark(source: SourceId, key: string, value: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO "watermarks" ("source", "key", "value", "updated_at") VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT ("source", "key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at"`,
      [source, key, value, isoNow()],
    );
  }

  async allWatermarks(): Promise<
    { source: SourceId; key: string; value: string; updatedAt: string }[]
  > {
    const rows = await this.driver.all<{
      source: SourceId;
      key: string;
      value: string;
      updated_at: string;
    }>(`SELECT "source", "key", "value", "updated_at" FROM "watermarks" ORDER BY "source", "key"`);
    return rows.map((r) => ({
      source: r.source,
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at,
    }));
  }

  // ── Sync runs ───────────────────────────────────────────────────────────

  async startSyncRun(source: SourceId): Promise<string> {
    const id = `${source}:${isoNow()}`;
    await this.driver.run(
      `INSERT INTO "sync_runs" ("id", "source", "started_at", "finished_at", "ok", "rows_upserted", "parse_attempted", "parse_succeeded", "error", "details") ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, source, isoNow(), null, null, 0, 0, 0, null, null],
    );
    return id;
  }

  async finishSyncRun(
    id: string,
    result: {
      ok: boolean;
      rowsUpserted: number;
      parseAttempted: number;
      parseSucceeded: number;
      error?: string | null;
      details?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.driver.run(
      `UPDATE "sync_runs" SET "finished_at" = ?, "ok" = ?, "rows_upserted" = ?, "parse_attempted" = ?, "parse_succeeded" = ?, "error" = ?, "details" = ? WHERE "id" = ?`,
      [
        isoNow(),
        result.ok,
        result.rowsUpserted,
        result.parseAttempted,
        result.parseSucceeded,
        result.error ?? null,
        result.details ? JSON.stringify(result.details) : null,
        id,
      ],
    );
  }

  async latestSyncRun(source: SourceId): Promise<SyncRunRecord | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM "sync_runs" WHERE "source" = ? ORDER BY "started_at" DESC LIMIT 1`,
      [source],
    );
    if (!row) return null;
    return {
      id: String(row.id),
      source: row.source as SourceId,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      ok: row.ok === null ? null : boolFrom(row.ok),
      rowsUpserted: Number(row.rows_upserted),
      parseAttempted: Number(row.parse_attempted),
      parseSucceeded: Number(row.parse_succeeded),
      error: row.error === null ? null : String(row.error),
      details: row.details ? (JSON.parse(String(row.details)) as Record<string, unknown>) : null,
    };
  }

  // ── Canary runs ─────────────────────────────────────────────────────────

  async recordCanaryRun(run: Omit<CanaryRunRecord, "id" | "ranAt">): Promise<CanaryRunRecord> {
    const record: CanaryRunRecord = { ...run, id: `${run.source}:${isoNow()}`, ranAt: isoNow() };
    await this.driver.run(
      `INSERT INTO "canary_runs" ("id", "source", "ran_at", "status", "checks") VALUES (?, ?, ?, ?, ?)`,
      [record.id, record.source, record.ranAt, record.status, JSON.stringify(record.checks)],
    );
    return record;
  }

  async latestCanaryRun(source: SourceId): Promise<CanaryRunRecord | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM "canary_runs" WHERE "source" = ? ORDER BY "ran_at" DESC LIMIT 1`,
      [source],
    );
    if (!row) return null;
    const checks = z
      .array(z.object({ name: z.string(), ok: z.boolean(), note: z.string().optional() }))
      .parse(JSON.parse(String(row.checks)));
    return {
      id: String(row.id),
      source: row.source as SourceId,
      ranAt: String(row.ran_at),
      status: row.status as CanaryStatus,
      checks,
    };
  }

  // ── Fingerprints (schema-drift detection) ──────────────────────────────

  async getFingerprint(source: SourceId, key: string): Promise<string | null> {
    const row = await this.driver.get<{ hash: string }>(
      `SELECT "hash" FROM "fingerprints" WHERE "source" = ? AND "key" = ?`,
      [source, key],
    );
    return row?.hash ?? null;
  }

  async setFingerprint(source: SourceId, key: string, hash: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO "fingerprints" ("source", "key", "hash", "updated_at") VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT ("source", "key") DO UPDATE SET "hash" = excluded."hash", "updated_at" = excluded."updated_at"`,
      [source, key, hash, isoNow()],
    );
  }

  // ── Conditional-GET cache ───────────────────────────────────────────────

  async getFetchCache(
    url: string,
  ): Promise<{ etag: string | null; lastModified: string | null } | null> {
    const row = await this.driver.get<{ etag: string | null; last_modified: string | null }>(
      `SELECT "etag", "last_modified" FROM "fetch_cache" WHERE "url" = ?`,
      [url],
    );
    return row ? { etag: row.etag, lastModified: row.last_modified } : null;
  }

  async setFetchCache(
    url: string,
    entry: { etag: string | null; lastModified: string | null },
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO "fetch_cache" ("url", "etag", "last_modified", "fetched_at") VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT ("url") DO UPDATE SET "etag" = excluded."etag", "last_modified" = excluded."last_modified", "fetched_at" = excluded."fetched_at"`,
      [url, entry.etag, entry.lastModified, isoNow()],
    );
  }

  // ── Entity-resolution caches ───────────────────────────────────────────

  async replaceCikTickers(entries: CikTickerEntry[]): Promise<void> {
    const now = isoNow();
    await this.driver.transaction(async () => {
      await this.driver.run(`DELETE FROM "cik_tickers"`);
      const chunkSize = Math.max(1, Math.floor(this.driver.maxParams / 4));
      for (let offset = 0; offset < entries.length; offset += chunkSize) {
        const chunk = entries.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
        await this.driver.run(
          `INSERT INTO "cik_tickers" ("cik", "ticker", "name", "refreshed_at") VALUES ${placeholders} ` +
            `ON CONFLICT ("cik", "ticker") DO UPDATE SET "name" = excluded."name", "refreshed_at" = excluded."refreshed_at"`,
          chunk.flatMap((e) => [e.cik, e.ticker, e.name, now]),
        );
      }
    });
  }

  async tickersForCik(cik: string): Promise<string[]> {
    const rows = await this.driver.all<{ ticker: string }>(
      `SELECT "ticker" FROM "cik_tickers" WHERE "cik" = ? ORDER BY "ticker"`,
      [cik],
    );
    return rows.map((r) => r.ticker);
  }

  async cikTickersRefreshedAt(): Promise<string | null> {
    const row = await this.driver.get<{ m: string | null }>(
      `SELECT MAX("refreshed_at") AS m FROM "cik_tickers"`,
    );
    return row?.m ?? null;
  }

  async cikTickerCount(): Promise<number> {
    const row = await this.driver.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM "cik_tickers"`,
    );
    return Number(row?.n ?? 0);
  }

  async getCusip(cusip: string): Promise<CusipMapEntry | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM "cusip_map" WHERE "cusip" = ?`,
      [cusip],
    );
    if (!row) return null;
    return {
      cusip: String(row.cusip),
      ticker: row.ticker === null ? null : String(row.ticker),
      figi: row.figi === null ? null : String(row.figi),
      name: row.name === null ? null : String(row.name),
      mapSource: String(row.map_source),
    };
  }

  async putCusips(entries: CusipMapEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = isoNow();
    const placeholders = entries.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    await this.driver.run(
      `INSERT INTO "cusip_map" ("cusip", "ticker", "figi", "name", "map_source", "resolved_at") VALUES ${placeholders} ` +
        `ON CONFLICT ("cusip") DO UPDATE SET "ticker" = excluded."ticker", "figi" = excluded."figi", "name" = excluded."name", "map_source" = excluded."map_source", "resolved_at" = excluded."resolved_at"`,
      entries.flatMap((e) => [e.cusip, e.ticker, e.figi, e.name, e.mapSource, now]),
    );
  }

  async replaceMemberMap(entries: MemberMapEntry[]): Promise<void> {
    const now = isoNow();
    await this.driver.transaction(async () => {
      await this.driver.run(`DELETE FROM "member_map"`);
      const chunkSize = Math.max(1, Math.floor(this.driver.maxParams / 8));
      for (let offset = 0; offset < entries.length; offset += chunkSize) {
        const chunk = entries.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        await this.driver.run(
          `INSERT INTO "member_map" ("bioguide_id", "full_name", "first_name", "last_name", "chamber", "party", "state", "refreshed_at") VALUES ${placeholders}`,
          chunk.flatMap((e) => [
            e.bioguideId,
            e.fullName,
            e.firstName,
            e.lastName,
            e.chamber,
            e.party,
            e.state,
            now,
          ]),
        );
      }
    });
  }

  async allMembers(): Promise<MemberMapEntry[]> {
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT * FROM "member_map"`);
    return rows.map((row) => ({
      bioguideId: String(row.bioguide_id),
      fullName: String(row.full_name),
      firstName: String(row.first_name),
      lastName: String(row.last_name),
      chamber: row.chamber as "senate" | "house",
      party: row.party === null ? null : String(row.party),
      state: row.state === null ? null : String(row.state),
    }));
  }

  /**
   * Bumps the company↔ticker cache's freshness without rewriting it — the
   * conditional-GET 304 path: upstream confirmed the map is unchanged.
   */
  async touchCikTickersRefreshedAt(): Promise<void> {
    await this.driver.run(`UPDATE "cik_tickers" SET "refreshed_at" = ?`, [isoNow()]);
  }

  // ── CUSIP→ticker enrichment (the `alt-data resolve cusips` loop) ─────────

  /** Distinct CUSIPs on 13F holding rows whose ticker is still unresolved. */
  async distinctUnresolvedCusips(limit?: number): Promise<string[]> {
    const sql =
      `SELECT DISTINCT "cusip" FROM "thirteenf_holdings" WHERE "ticker" IS NULL ORDER BY "cusip"` +
      (limit !== undefined ? ` LIMIT ?` : ``);
    const rows = await this.driver.all<{ cusip: string }>(sql, limit !== undefined ? [limit] : []);
    return rows.map((r) => r.cusip);
  }

  /**
   * Applies resolved CUSIP→ticker mappings to 13F holding rows that still
   * lack a ticker. Null tickers (cached misses) never touch rows; already
   * resolved rows are never overwritten.
   */
  async applyCusipTickers(map: Map<string, string | null>): Promise<{ updated: number }> {
    const entries = [...map.entries()].filter(
      (entry): entry is [string, string] => entry[1] !== null,
    );
    if (entries.length === 0) return { updated: 0 };
    let updated = 0;
    await this.driver.transaction(async () => {
      for (const [cusip, ticker] of entries) {
        const { changes } = await this.driver.run(
          `UPDATE "thirteenf_holdings" SET "ticker" = ? WHERE "cusip" = ? AND "ticker" IS NULL`,
          [ticker, cusip],
        );
        updated += changes;
      }
    });
    return { updated };
  }

  /**
   * Replaces a dataset's rows wholesale, atomically — for CURRENT-STATE
   * datasets (e.g. committee assignments) where a departed row must
   * disappear rather than linger. Event-history datasets keep using
   * `upsert`; this is the deliberate exception, not the norm.
   */
  async replaceDataset<T>(dataset: DatasetDefinition<T>, records: T[]): Promise<UpsertResult> {
    return this.driver.transaction(async () => {
      await this.driver.run(`DELETE FROM "${dataset.table}"`);
      return this.upsert(dataset, records);
    });
  }
}
