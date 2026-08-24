import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { DatasetId } from "../schema/datasets.js";
import { ALL_DATASETS, SCHEMA_VERSION, type DatasetDefinition } from "../schema/datasets.js";
import type { DocketStore } from "../store/store.js";
import { freshnessReport } from "../store/queries.js";
import { addDays, todayUtc } from "../lib/dates.js";
import type { Logger } from "../lib/logger.js";

/**
 * The dump writer: daily JSON deltas (bucketed by ingestion day) plus a full
 * gzipped snapshot per dataset, with a manifest carrying row counts,
 * watermarks, per-source health, and the schema version.
 *
 * Output is deterministic (rows in id order, one JSON shape) so a data repo
 * publishing these files gets clean, reviewable diffs. Delta files for past
 * days are immutable once written; only recent days are rewritten, because
 * late rows can still land on the current day.
 */

export interface ExportOptions {
  outDir: string;
  datasets?: DatasetId[];
  /** Re-write delta files for the last N days (default 2); older files are kept as-is. */
  rewriteRecentDays?: number;
  snapshot?: boolean;
  logger?: Logger;
}

export interface ExportSummary {
  outDir: string;
  filesWritten: string[];
  rowTotals: Partial<Record<DatasetId, number>>;
}

function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function stableJson(rows: unknown[]): string {
  return JSON.stringify(rows, null, 0) + "\n";
}

export async function exportDumps(
  store: DocketStore,
  options: ExportOptions,
): Promise<ExportSummary> {
  const datasets: DatasetDefinition[] = (options.datasets ?? ALL_DATASETS.map((d) => d.id)).map(
    (id) => ALL_DATASETS.find((d) => d.id === id) as DatasetDefinition,
  );
  const rewriteSince = addDays(todayUtc(), -(options.rewriteRecentDays ?? 2));
  const filesWritten: string[] = [];
  const rowTotals: Partial<Record<DatasetId, number>> = {};

  for (const dataset of datasets) {
    const dir = join(options.outDir, dataset.exportDir);
    const days = await store.ingestionDays(dataset.id);
    let latestDayFile: string | null = null;

    for (const day of days) {
      const year = day.slice(0, 4);
      const path = join(dir, year, `${day}.json`);
      latestDayFile = path;
      if (existsSync(path) && day < rewriteSince) continue;
      const rows = await store.rowsIngestedOn(dataset, day);
      writeFileAtomic(path, stableJson(rows));
      filesWritten.push(path);
      options.logger?.debug(`wrote ${path} (${rows.length} rows)`);
    }

    // latest.json mirrors the newest delta for one-URL consumption.
    if (latestDayFile && days.length > 0) {
      const lastDay = days[days.length - 1] as string;
      const rows = await store.rowsIngestedOn(dataset, lastDay);
      const latestPath = join(dir, "latest.json");
      writeFileAtomic(latestPath, stableJson(rows));
      filesWritten.push(latestPath);
    }

    if (options.snapshot !== false) {
      const all: unknown[] = [];
      for await (const record of store.iterate(dataset)) all.push(record);
      rowTotals[dataset.id] = all.length;
      const snapshotPath = join(dir, "snapshot.json.gz");
      writeFileAtomic(snapshotPath, gzipSync(Buffer.from(stableJson(all))));
      filesWritten.push(snapshotPath);
    } else {
      rowTotals[dataset.id] = await store.count(dataset.id);
    }
  }

  const manifest = await buildManifest(store);
  const manifestPath = join(options.outDir, "manifest.json");
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  filesWritten.push(manifestPath);

  return { outDir: options.outDir, filesWritten, rowTotals };
}

export interface DumpManifest {
  generatedAt: string;
  schemaVersion: number;
  datasets: Record<
    string,
    {
      title: string;
      exportDir: string;
      rows: number;
      lastIngestedAt: string | null;
      stale: boolean;
    }
  >;
  sources: Record<
    string,
    {
      implementedDatasets: string[];
      lastSyncOk: boolean | null;
      lastSyncAt: string | null;
      lastCanaryStatus: string | null;
      lastCanaryAt: string | null;
      watermarks: Record<string, string>;
    }
  >;
}

export async function buildManifest(store: DocketStore): Promise<DumpManifest> {
  const report = await freshnessReport(store);
  const datasets: DumpManifest["datasets"] = {};
  for (const d of report.datasets) {
    const def = ALL_DATASETS.find((x) => x.id === d.dataset) as DatasetDefinition;
    datasets[d.dataset] = {
      title: def.title,
      exportDir: def.exportDir,
      rows: d.rowCount,
      lastIngestedAt: d.lastIngestedAt,
      stale: d.stale,
    };
  }
  const sources: DumpManifest["sources"] = {};
  for (const s of report.sources) {
    sources[s.source] = {
      implementedDatasets: ALL_DATASETS.filter((d) => d.sources.includes(s.source)).map(
        (d) => d.id,
      ),
      lastSyncOk: s.lastSync?.ok ?? null,
      lastSyncAt: s.lastSync?.startedAt ?? null,
      lastCanaryStatus: s.lastCanary?.status ?? null,
      lastCanaryAt: s.lastCanary?.ranAt ?? null,
      watermarks: Object.fromEntries(s.watermarks.map((w) => [w.key, w.value])),
    };
  }
  return {
    generatedAt: report.generatedAt,
    schemaVersion: SCHEMA_VERSION,
    datasets,
    sources,
  };
}
