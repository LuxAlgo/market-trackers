import type { ColumnType, TableSpec } from "./table-specs.js";
import { V1_TABLES, V2_TABLES, V3_TABLES, V4_TABLES } from "./table-specs.js";
import type { Dialect, SqlDriver } from "./sql-driver.js";
import { isoNow } from "../lib/dates.js";

/**
 * Versioned, idempotent migrations. Migration 0001 is generated from the
 * table specs so DDL can never drift from them; later migrations are written
 * as explicit SQL per dialect and appended here. Opening a store always
 * migrates first, so `alt-data sync` works on a fresh file with zero setup.
 */

const TYPE_MAP: Record<Dialect, Record<ColumnType, string>> = {
  sqlite: {
    text: "TEXT",
    real: "REAL",
    integer: "INTEGER",
    boolean: "INTEGER",
    json: "TEXT",
  },
  postgres: {
    text: "TEXT",
    real: "DOUBLE PRECISION",
    integer: "INTEGER",
    boolean: "BOOLEAN",
    json: "TEXT",
  },
};

export function createTableSql(spec: TableSpec, dialect: Dialect): string {
  const cols = spec.columns.map((col) => {
    const type = TYPE_MAP[dialect][col.type];
    const nullable = col.nullable ? "" : " NOT NULL";
    return `  "${col.name}" ${type}${nullable}`;
  });
  const pk = `  PRIMARY KEY (${spec.primaryKey.map((c) => `"${c}"`).join(", ")})`;
  return `CREATE TABLE IF NOT EXISTS "${spec.name}" (\n${[...cols, pk].join(",\n")}\n);`;
}

export function createIndexSql(spec: TableSpec): string[] {
  return spec.indexes.map(
    (idx) =>
      `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${idx.name}" ON "${spec.name}" (${idx.columns
        .map((c) => `"${c}"`)
        .join(", ")});`,
  );
}

export interface Migration {
  id: string;
  statements?(dialect: Dialect): string[];
  /** For steps plain per-dialect SQL can't express (e.g. conditional ALTERs). */
  execute?(driver: SqlDriver): Promise<void>;
}

async function hasColumn(driver: SqlDriver, table: string, column: string): Promise<boolean> {
  if (driver.dialect === "sqlite") {
    const row = await driver.get(`SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`, [
      table,
      column,
    ]);
    return row !== undefined;
  }
  const row = await driver.get(
    `SELECT 1 AS present FROM information_schema.columns WHERE table_name = ? AND column_name = ?`,
    [table, column],
  );
  return row !== undefined;
}

export const MIGRATIONS: Migration[] = [
  {
    // FROZEN as a *list*: stores that already applied 0001 only run later
    // migrations. It generates from the live specs, so a fresh store's 0001
    // includes columns that older stores instead receive via later ALTER
    // migrations (0003's bill_references) — both paths converge on the same
    // schema.
    id: "0001-init",
    statements(dialect) {
      return V1_TABLES.flatMap((spec) => [createTableSql(spec, dialect), ...createIndexSql(spec)]);
    },
  },
  {
    id: "0002-new-datasets",
    statements(dialect) {
      return V2_TABLES.flatMap((spec) => [createTableSql(spec, dialect), ...createIndexSql(spec)]);
    },
  },
  {
    // New round-3 dataset tables, plus lobbying_filings.bill_references for
    // stores created before the column joined the spec. '[]' backfills
    // existing rows (nothing extracted yet); the next LDA sync upserts real
    // values. Fresh stores already created the column in 0001, so the ALTER
    // is guarded by a column-existence check rather than IF NOT EXISTS
    // (SQLite has no ADD COLUMN IF NOT EXISTS).
    id: "0003-round3",
    statements(dialect) {
      return V3_TABLES.flatMap((spec) => [createTableSql(spec, dialect), ...createIndexSql(spec)]);
    },
    async execute(driver) {
      if (!(await hasColumn(driver, "lobbying_filings", "bill_references"))) {
        await driver.exec(
          `ALTER TABLE "lobbying_filings" ADD COLUMN "bill_references" TEXT NOT NULL DEFAULT '[]';`,
        );
      }
    },
  },
  {
    // Round-4 dataset tables (congressional hearing transcripts, Federal
    // Reserve communications). Purely additive — new tables + indexes, no
    // ALTERs — so fresh and existing stores both simply run it and converge
    // on the same schema, exactly like 0002.
    id: "0004-round4",
    statements(dialect) {
      return V4_TABLES.flatMap((spec) => [createTableSql(spec, dialect), ...createIndexSql(spec)]);
    },
  },
];

export async function migrate(driver: SqlDriver): Promise<string[]> {
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS "schema_migrations" ("id" TEXT NOT NULL, "applied_at" TEXT NOT NULL, PRIMARY KEY ("id"));`,
  );
  const appliedRows = await driver.all<{ id: string }>(`SELECT "id" FROM "schema_migrations"`);
  const applied = new Set(appliedRows.map((r) => r.id));
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await driver.transaction(async () => {
      for (const statement of migration.statements?.(driver.dialect) ?? []) {
        await driver.exec(statement);
      }
      await migration.execute?.(driver);
      await driver.run(`INSERT INTO "schema_migrations" ("id", "applied_at") VALUES (?, ?)`, [
        migration.id,
        isoNow(),
      ]);
    });
    ran.push(migration.id);
  }
  return ran;
}
