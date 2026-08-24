/**
 * The one seam between Docket and its databases. SQL in the store layer is
 * written once against `?` placeholders and standard SQL that SQLite and
 * Postgres share (including `INSERT … ON CONFLICT … DO UPDATE`); each driver
 * adapts placeholders and value coercions. SQLite is the default backend,
 * Postgres is the same store behind one flag.
 */

export type Dialect = "sqlite" | "postgres";

export interface SqlDriver {
  readonly dialect: Dialect;
  /** Safe upper bound on bound parameters per statement. */
  readonly maxParams: number;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Execute multi-statement SQL (DDL). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction. Transactions are serialized per driver. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Serializes async critical sections (one connection = one transaction at a time). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function coerceSqliteParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export async function createSqliteDriver(file: string): Promise<SqlDriver> {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  const mutex = new Mutex();
  let txDepth = 0;

  return {
    dialect: "sqlite",
    maxParams: 30_000,
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params.map(coerceSqliteParam));
      return { changes: info.changes };
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params.map(coerceSqliteParam)) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...params.map(coerceSqliteParam)) as T | undefined;
    },
    async exec(sql) {
      db.exec(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // Re-entrant calls join the outer transaction instead of nesting BEGINs.
      if (txDepth > 0) return fn();
      return mutex.lock(async () => {
        txDepth += 1;
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          txDepth -= 1;
        }
      });
    },
    async close() {
      db.close();
    },
  };
}

/** Rewrites `?` placeholders to Postgres `$1..$n`. Our SQL never embeds literal '?'. */
export function toPositionalParams(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function createPostgresDriver(connectionString: string): Promise<SqlDriver> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  const mutex = new Mutex();
  let txDepth = 0;

  return {
    dialect: "postgres",
    maxParams: 60_000,
    async run(sql, params = []) {
      const result = await client.query(toPositionalParams(sql), params as unknown[]);
      return { changes: result.rowCount ?? 0 };
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(toPositionalParams(sql), params as unknown[]);
      return result.rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(toPositionalParams(sql), params as unknown[]);
      return result.rows[0] as T | undefined;
    },
    async exec(sql) {
      await client.query(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (txDepth > 0) return fn();
      return mutex.lock(async () => {
        txDepth += 1;
        await client.query("BEGIN");
        try {
          const result = await fn();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          txDepth -= 1;
        }
      });
    },
    async close() {
      await client.end();
    },
  };
}

export interface ParsedDbUrl {
  dialect: Dialect;
  /** SQLite file path (or ":memory:"), or the Postgres connection string. */
  target: string;
}

/**
 * One flag, two backends:
 *   - "docket.db", "./data/docket.db", ":memory:", "sqlite:path" → SQLite
 *   - "postgres://…", "postgresql://…" → Postgres
 */
export function parseDbUrl(url: string): ParsedDbUrl {
  const trimmed = url.trim();
  if (trimmed.length === 0) throw new Error("Empty database URL");
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return { dialect: "postgres", target: trimmed };
  if (/^sqlite:/i.test(trimmed))
    return { dialect: "sqlite", target: trimmed.slice("sqlite:".length) };
  return { dialect: "sqlite", target: trimmed };
}

export async function createDriver(url: string): Promise<SqlDriver> {
  const parsed = parseDbUrl(url);
  return parsed.dialect === "postgres"
    ? createPostgresDriver(parsed.target)
    : createSqliteDriver(parsed.target);
}
