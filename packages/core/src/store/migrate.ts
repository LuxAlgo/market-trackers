import type { ColumnType, TableSpec } from "./table-specs.js";
import { V1_TABLES, V2_TABLES } from "./table-specs.js";
import type { Dialect, SqlDriver } from "./sql-driver.js";
import { isoNow } from "../lib/dates.js";

/**
 * Versioned, idempotent migrations. Migration 0001 is generated from the
 * table specs so DDL can never drift from them; later migrations are written
 * as explicit SQL per dialect and appended here. Opening a store always
 * migrates first, so `docket sync` works on a fresh file with zero setup.
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
  statements(dialect: Dialect): string[];
}

export const MIGRATIONS: Migration[] = [
  {
    // FROZEN: exactly the v1 cohort. Stores that already applied 0001 only
    // run later migrations, so this list must never change.
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
      for (const statement of migration.statements(driver.dialect)) {
        await driver.exec(statement);
      }
      await driver.run(`INSERT INTO "schema_migrations" ("id", "applied_at") VALUES (?, ?)`, [
        migration.id,
        isoNow(),
      ]);
    });
    ran.push(migration.id);
  }
  return ran;
}
