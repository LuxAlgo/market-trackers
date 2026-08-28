#!/usr/bin/env node
/**
 * Converts a dumps directory's gzipped JSON snapshots into sibling Parquet
 * files, so anything that prefers columnar/Arrow-ecosystem tooling (DuckDB,
 * pandas, polars, ...) over hand-parsing JSON can read the same rows
 * directly.
 *
 *   node scripts/make-parquet.mjs [dumpsDir]     # default: dumps
 *
 * For every `snapshot*.json.gz` found anywhere under dumpsDir — both the
 * per-year shards (`snapshot-<YYYY>.json.gz`) and the combined
 * `snapshot.json.gz` small datasets also get (see the sharding/combining
 * logic in packages/core/src/export/writer.ts) — writes a `.parquet`
 * sibling with the same rows, via DuckDB's `read_json` reader piped
 * straight into `COPY ... TO ... (FORMAT PARQUET)`. Column types come from
 * DuckDB's JSON auto-detection rather than the zod schemas; the JSON stays
 * the canonical, exact representation and the Parquet files are a
 * best-effort convenience mirror of it.
 *
 * DuckDB is intentionally never a project dependency (nothing here is added
 * to any package.json / pnpm-lock.yaml) — the workflow that calls this
 * script installs the `duckdb` npm package ephemerally right before running
 * it (`npm i --no-save duckdb`). This drives it programmatically rather
 * than shelling out to an `npx duckdb` CLI: `npm view duckdb bin main`
 * shows the package declares no `bin` at all (only `main: ./lib/duckdb.js`)
 * — there is no DuckDB shell to invoke via npx, only the Node API.
 *
 * This script must never be the thing that breaks a publish: if the
 * `duckdb` package isn't importable (install skipped, install failed, wrong
 * platform for the prebuilt binary, ...) it logs a clear line and exits 0.
 * One file failing to convert (corrupt gzip, an unexpected JSON shape, a
 * DuckDB quirk) is logged and skipped rather than aborting the run.
 */
import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const SNAPSHOT_NAME = /^snapshot.*\.json\.gz$/;

function findSnapshots(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // a missing/unreadable dumpsDir just means nothing to convert
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findSnapshots(full));
    } else if (entry.isFile() && SNAPSHOT_NAME.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function parquetSibling(jsonGzPath) {
  const stem = basename(jsonGzPath).replace(/\.json\.gz$/, "");
  return join(dirname(jsonGzPath), `${stem}.parquet`);
}

// These are paths this workflow itself produced, not untrusted input, but
// escape single quotes anyway before splicing into SQL string literals.
function sqlLiteral(path) {
  return `'${path.replaceAll("'", "''")}'`;
}

async function loadDuckdb() {
  try {
    const mod = await import("duckdb");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function execSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    db.close(() => resolve());
  });
}

async function main() {
  const dumpsDir = process.argv[2] ?? "dumps";
  const snapshots = findSnapshots(dumpsDir);
  if (snapshots.length === 0) {
    console.log(`make-parquet: no snapshot*.json.gz files under '${dumpsDir}'; nothing to do.`);
    return;
  }

  const duckdb = await loadDuckdb();
  if (!duckdb) {
    console.log(
      "make-parquet: the 'duckdb' package is not installed (expected `npm i --no-save " +
        "duckdb` to have run first) — skipping parquet conversion. Publishing continues " +
        "without it.",
    );
    return;
  }

  const db = new duckdb.Database(":memory:");
  let converted = 0;
  let skipped = 0;
  for (const jsonGzPath of snapshots) {
    const parquetPath = parquetSibling(jsonGzPath);
    const sql =
      `COPY (SELECT * FROM read_json(${sqlLiteral(jsonGzPath)}, format='array')) ` +
      `TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET);`;
    try {
      // Sequential on purpose: one shared in-memory DuckDB connection, and a
      // bad file should never race a good one.
      await execSql(db, sql);
      converted += 1;
      console.log(`make-parquet: wrote ${parquetPath}`);
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`make-parquet: skipped ${jsonGzPath} (${message})`);
    }
  }
  await closeDb(db);

  console.log(
    `make-parquet: ${converted} converted, ${skipped} skipped, out of ${snapshots.length} total.`,
  );
}

main().catch((error) => {
  // Belt-and-suspenders on top of the try/catches above: whatever went
  // wrong, this script still exits 0 so it can never break a publish.
  const message = error instanceof Error ? error.message : String(error);
  console.log(`make-parquet: unexpected error (${message}) — continuing without parquet output.`);
});
