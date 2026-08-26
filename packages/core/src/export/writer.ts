import { mkdirSync, writeFileSync, existsSync, renameSync, createWriteStream } from "node:fs";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { dirname, join } from "node:path";
import { gzipSync, createGzip } from "node:zlib";
import type { DatasetId } from "../schema/datasets.js";
import { ALL_DATASETS, SCHEMA_VERSION, type DatasetDefinition } from "../schema/datasets.js";
import type { AltDataStore } from "../store/store.js";
import { freshnessReport } from "../store/queries.js";
import { addDays, todayUtc } from "../lib/dates.js";
import type { Logger } from "../lib/logger.js";
import { renderFeedXml, BoundedFeedSelection, type FeedRow } from "./feeds.js";
import { writeEntityFeeds, type EntityFeedCounts } from "./entity-feeds.js";

/**
 * The dump writer: daily JSON deltas (bucketed by ingestion day), an RSS
 * feed of the newest rows, and full-history snapshots sharded by event year
 * per dataset, with a manifest carrying row counts, watermarks, per-source
 * health, and the schema version.
 *
 * Output is deterministic (rows in id order, one JSON shape) so a data repo
 * publishing these files gets clean, reviewable diffs. Delta files for past
 * days are immutable once written; only recent days are rewritten, because
 * late rows can still land on the current day. Year shards keep every file
 * well under git/CDN limits even at full-history depth — and because
 * `alt-data import` reads them back, the published dumps are the durable
 * archive a store can always be rebuilt from.
 */

export interface ExportOptions {
  outDir: string;
  datasets?: DatasetId[];
  /** Re-write delta files for the last N days (default 2); older files are kept as-is. */
  rewriteRecentDays?: number;
  /** Write daily delta files, latest.json, feed.xml, and entity feeds (default true). */
  deltas?: boolean;
  snapshot?: boolean;
  /** Also write a single combined snapshot when a dataset has at most this many rows (default 200k). */
  combinedSnapshotMaxRows?: number;
  /** Write feed.xml per dataset (default true); also gates the per-entity feeds below. */
  feeds?: boolean;
  /** Recency window (days) for per-entity feeds — see export/entity-feeds.ts (default 30). */
  entityFeedWindowDays?: number;
  /** Cap on distinct entities per feed kind (ticker, member) per dataset (default 200). */
  entityFeedCap?: number;
  logger?: Logger;
  /**
   * Overrides "now" for this export's `generatedAt` (feed `lastBuildDate`s,
   * the manifest's `generatedAt`, and the entity-feed recency window).
   * Tests only — defaults to the real current time.
   */
  now?: Date;
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

/**
 * Writes `chunk`, waiting out backpressure (`drain`) instead of letting Node
 * buffer it all. Whichever of `drain`/`error` fires removes the other
 * listener — a row stream backpressures repeatedly, and leaving the loser
 * attached each time leaks a listener per wait until Node's max-listeners
 * warning fires.
 */
function writeChunk(sink: Writable, chunk: string): Promise<void> {
  if (sink.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      sink.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      sink.off("drain", onDrain);
      reject(err);
    };
    sink.once("drain", onDrain);
    sink.once("error", onError);
  });
}

/**
 * Streams a JSON array to disk one row at a time — `[`, each row's
 * `JSON.stringify` joined by `,`, `]\n` — the same bytes `stableJson`
 * produces for the same rows, without ever holding more than one row (plus
 * the stream's own buffer) in memory. `gzip` pipes through `createGzip()`
 * at default settings with no manual flushes, which is what keeps its
 * output deterministic. Atomic: written to `path.tmp`, renamed on `finish`.
 */
class JsonArrayFileWriter {
  private wroteFirst = false;
  private readonly sink: Writable;
  private readonly fileStream: Writable;
  private readonly tmpPath: string;

  constructor(
    private readonly finalPath: string,
    gzip: boolean,
  ) {
    mkdirSync(dirname(finalPath), { recursive: true });
    this.tmpPath = `${finalPath}.tmp`;
    this.fileStream = createWriteStream(this.tmpPath);
    if (gzip) {
      const gz = createGzip();
      gz.pipe(this.fileStream);
      this.sink = gz;
    } else {
      this.sink = this.fileStream;
    }
  }

  async writeRow(row: unknown): Promise<void> {
    const chunk = (this.wroteFirst ? "," : "[") + JSON.stringify(row);
    this.wroteFirst = true;
    await writeChunk(this.sink, chunk);
  }

  async finish(): Promise<void> {
    await writeChunk(this.sink, this.wroteFirst ? "]\n" : "[]\n");
    const closed = finished(this.fileStream);
    this.sink.end();
    await closed;
    renameSync(this.tmpPath, this.finalPath);
  }
}

/** Drains `rows` straight into a JSON-array file; returns the row count seen (counted while streaming). */
async function writeJsonArrayFile(path: string, rows: AsyncIterable<unknown>): Promise<number> {
  const writer = new JsonArrayFileWriter(path, false);
  let count = 0;
  for await (const row of rows) {
    await writer.writeRow(row);
    count += 1;
  }
  await writer.finish();
  return count;
}

export async function exportDumps(
  store: AltDataStore,
  options: ExportOptions,
): Promise<ExportSummary> {
  const datasets: DatasetDefinition[] = (options.datasets ?? ALL_DATASETS.map((d) => d.id)).map(
    (id) => ALL_DATASETS.find((d) => d.id === id) as DatasetDefinition,
  );
  const rewriteSince = addDays(todayUtc(), -(options.rewriteRecentDays ?? 2));
  const combinedMax = options.combinedSnapshotMaxRows ?? 200_000;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const filesWritten: string[] = [];
  const rowTotals: Partial<Record<DatasetId, number>> = {};
  const snapshotIndex = new Map<DatasetId, { file: string; rows: number }[]>();
  const entityFeedIndex = new Map<DatasetId, EntityFeedCounts>();

  for (const dataset of datasets) {
    const dir = join(options.outDir, dataset.exportDir);

    if (options.deltas !== false) {
      const days = await store.ingestionDays(dataset.id);

      for (const day of days) {
        const year = day.slice(0, 4);
        const path = join(dir, year, `${day}.json`);
        if (existsSync(path) && day < rewriteSince) continue;
        const count = await writeJsonArrayFile(path, store.iterateIngestedOn(dataset, day));
        filesWritten.push(path);
        options.logger?.debug(`wrote ${path} (${count} rows)`);
      }

      // latest.json mirrors the newest delta for one-URL consumption; feed.xml
      // republishes the same rows as RSS so anything that reads feeds gets
      // zero-infrastructure alerts with primary-source links. Both stream
      // the same day in a single pass: latest.json takes every row, while
      // the feed's selection never grows past MAX_ITEMS no matter how many
      // rows the day holds.
      if (days.length > 0) {
        const lastDay = days[days.length - 1] as string;
        const latestPath = join(dir, "latest.json");
        const latestWriter = new JsonArrayFileWriter(latestPath, false);
        const selection = options.feeds !== false ? new BoundedFeedSelection<FeedRow>() : undefined;
        for await (const record of store.iterateIngestedOn(dataset, lastDay)) {
          await latestWriter.writeRow(record);
          selection?.push(record as unknown as FeedRow);
        }
        await latestWriter.finish();
        filesWritten.push(latestPath);

        if (selection) {
          const feedPath = join(dir, "feed.xml");
          writeFileAtomic(
            feedPath,
            renderFeedXml(dataset as DatasetDefinition<FeedRow>, selection.items(), generatedAt),
          );
          filesWritten.push(feedPath);

          // Per-entity feeds (feeds/by-ticker/{TICKER}.xml, and for
          // congress-trades feeds/by-member/{bioguideId}.xml) — see
          // export/entity-feeds.ts. Gated by the same `feeds` option as
          // feed.xml: disabling one disables both.
          const entityFeeds = await writeEntityFeeds(store, dataset, dir, generatedAt, {
            windowDays: options.entityFeedWindowDays,
            cap: options.entityFeedCap,
          });
          filesWritten.push(...entityFeeds.filesWritten);
          entityFeedIndex.set(dataset.id, {
            byTicker: entityFeeds.byTicker,
            byMember: entityFeeds.byMember,
          });
          if (entityFeeds.rejected.byTicker > 0 || entityFeeds.rejected.byMember > 0) {
            options.logger?.debug(
              `${dataset.id}: rejected ${entityFeeds.rejected.byTicker} ticker / ` +
                `${entityFeeds.rejected.byMember} member row-entity keys as filesystem-unsafe`,
            );
          }
        }
      }
    }

    if (options.snapshot !== false) {
      // Full history, sharded by event year, in one pass over `store.iterate`:
      // a shard's gzip writer opens lazily on that year's first row and
      // streams every row after, so no year — and no whole dataset — is ever
      // fully materialized. The combined snapshot below is the deliberate
      // exception, and only while it's still within `combinedMax`.
      const shardWriters = new Map<string, JsonArrayFileWriter>();
      const shardCounts = new Map<string, number>();
      const combinedByYear = new Map<string, unknown[]>();
      let combinedOverCap = false;
      let total = 0;

      for await (const record of store.iterate(dataset)) {
        total += 1;
        const year = dataset.eventDate(record).slice(0, 4);

        let shardWriter = shardWriters.get(year);
        if (!shardWriter) {
          shardWriter = new JsonArrayFileWriter(join(dir, `snapshot-${year}.json.gz`), true);
          shardWriters.set(year, shardWriter);
        }
        await shardWriter.writeRow(record);
        shardCounts.set(year, (shardCounts.get(year) ?? 0) + 1);

        // Buffer for the combined file only while it's still affordable; the
        // moment the running total crosses the cap, drop the buffer for good
        // instead of growing it toward the same OOM this pass exists to avoid.
        if (!combinedOverCap) {
          if (total > combinedMax) {
            combinedOverCap = true;
            combinedByYear.clear();
          } else {
            const bucket = combinedByYear.get(year);
            if (bucket) bucket.push(record);
            else combinedByYear.set(year, [record]);
          }
        }
      }
      rowTotals[dataset.id] = total;

      const years = [...shardWriters.keys()].sort();
      const shards: { file: string; rows: number }[] = [];
      for (const year of years) {
        await (shardWriters.get(year) as JsonArrayFileWriter).finish();
        const shardFile = `snapshot-${year}.json.gz`;
        filesWritten.push(join(dir, shardFile));
        shards.push({ file: shardFile, rows: shardCounts.get(year) ?? 0 });
      }
      // Small datasets also get the convenient single-file snapshot.
      if (total <= combinedMax) {
        const all: unknown[] = [];
        for (const year of years) {
          for (const row of combinedByYear.get(year) ?? []) all.push(row);
        }
        writeFileAtomic(join(dir, "snapshot.json.gz"), gzipSync(Buffer.from(stableJson(all))));
        filesWritten.push(join(dir, "snapshot.json.gz"));
        shards.push({ file: "snapshot.json.gz", rows: total });
      }
      snapshotIndex.set(dataset.id, shards);
    } else {
      rowTotals[dataset.id] = await store.count(dataset.id);
    }
  }

  const manifest = await buildManifest(
    store,
    snapshotIndex,
    entityFeedIndex,
    new Date(generatedAt),
  );
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
      snapshots: { file: string; rows: number }[];
      feed: string | null;
      /** Per-entity feed counts actually written this export (see export/entity-feeds.ts). */
      entityFeeds: EntityFeedCounts;
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

export async function buildManifest(
  store: AltDataStore,
  snapshotIndex: Map<DatasetId, { file: string; rows: number }[]> = new Map(),
  entityFeedIndex: Map<DatasetId, EntityFeedCounts> = new Map(),
  now: Date = new Date(),
): Promise<DumpManifest> {
  const report = await freshnessReport(store, now);
  const datasets: DumpManifest["datasets"] = {};
  for (const d of report.datasets) {
    const def = ALL_DATASETS.find((x) => x.id === d.dataset) as DatasetDefinition;
    datasets[d.dataset] = {
      title: def.title,
      exportDir: def.exportDir,
      rows: d.rowCount,
      lastIngestedAt: d.lastIngestedAt,
      stale: d.stale,
      snapshots: snapshotIndex.get(d.dataset) ?? [],
      feed: d.rowCount > 0 ? `${def.exportDir}/feed.xml` : null,
      // entityFeeds counts are 0 whenever a dataset has no ticker/member
      // concept, has no rows, or ran with feeds disabled — never omitted,
      // so "0" always means "checked, found none" rather than "not asked".
      entityFeeds: entityFeedIndex.get(d.dataset) ?? { byTicker: 0, byMember: 0 },
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
