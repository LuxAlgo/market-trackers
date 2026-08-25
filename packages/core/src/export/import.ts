import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import type { DatasetId } from "../schema/datasets.js";
import { ALL_DATASETS, datasetById, type DatasetDefinition } from "../schema/datasets.js";
import type { DocketStore } from "../store/store.js";
import type { Logger } from "../lib/logger.js";

/**
 * The other half of the dumps contract: everything `docket export` writes,
 * `docket import` reads back. Published dumps are therefore the durable
 * archive — a store can always be rebuilt from the data repo (or from a
 * backfill archive) with no access to the original sources. Upserts by
 * natural key make importing overlapping files safe.
 */

export interface ImportSummary {
  files: number;
  rows: number;
  perDataset: Partial<Record<DatasetId, number>>;
}

function readRows(path: string): unknown[] {
  const raw = path.endsWith(".gz")
    ? gunzipSync(readFileSync(path)).toString("utf8")
    : readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of records`);
  }
  return parsed;
}

function isDataFile(name: string): boolean {
  if (name === "manifest.json" || name === "feed.xml") return false;
  // latest.json duplicates the newest delta; skip it to avoid wasted work.
  if (name === "latest.json") return false;
  return name.endsWith(".json") || name.endsWith(".json.gz");
}

function walkDataFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDataFiles(full));
    else if (entry.isFile() && isDataFile(entry.name)) out.push(full);
  }
  return out.sort();
}

async function importFiles(
  store: DocketStore,
  dataset: DatasetDefinition,
  files: string[],
  summary: ImportSummary,
  logger?: Logger,
): Promise<void> {
  for (const file of files) {
    const rows = readRows(file);
    if (rows.length === 0) continue;
    const { rows: upserted } = await store.upsert(dataset, rows);
    summary.files += 1;
    summary.rows += upserted;
    summary.perDataset[dataset.id] = (summary.perDataset[dataset.id] ?? 0) + upserted;
    logger?.info(`imported ${basename(file)} → ${dataset.id} (${upserted} rows)`);
  }
}

export interface ImportOptions {
  /** Required for single-file imports that can't be inferred from the path. */
  dataset?: DatasetId;
  logger?: Logger;
}

/**
 * Imports a dumps directory (the docket-data layout), a single dataset
 * directory, or a single .json/.json.gz file into the store.
 */
export async function importDumps(
  store: DocketStore,
  path: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = { files: 0, rows: 0, perDataset: {} };
  const stats = statSync(path);

  if (stats.isFile()) {
    const dataset = options.dataset
      ? datasetById(options.dataset)
      : ALL_DATASETS.find((d) => path.replaceAll("\\", "/").includes(`/${d.exportDir}/`));
    if (!dataset) {
      throw new Error(
        `Cannot infer the dataset for '${path}' — pass --dataset (one of: ${ALL_DATASETS.map((d) => d.id).join(", ")})`,
      );
    }
    await importFiles(store, dataset, [path], summary, options.logger);
    return summary;
  }

  // Directory: either a full dumps root (walk every dataset's exportDir) or
  // a single dataset directory when --dataset is given.
  if (options.dataset) {
    const dataset = datasetById(options.dataset);
    const dir = existsSync(join(path, dataset.exportDir)) ? join(path, dataset.exportDir) : path;
    await importFiles(store, dataset, walkDataFiles(dir), summary, options.logger);
    return summary;
  }

  for (const dataset of ALL_DATASETS) {
    const dir = join(path, dataset.exportDir);
    if (!existsSync(dir)) continue;
    await importFiles(store, dataset, walkDataFiles(dir), summary, options.logger);
  }
  if (summary.files === 0) {
    throw new Error(
      `No importable files found under '${path}' — expected the docket-data layout or --dataset with a dataset directory`,
    );
  }
  return summary;
}
