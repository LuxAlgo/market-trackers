import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDumps, buildManifest } from "./writer.js";
import { MAX_ITEMS } from "./feeds.js";
import { TrackerStore } from "../store/store.js";
import { DATASETS, SCHEMA_VERSION } from "../schema/datasets.js";
import {
  makeShortVolumeDay,
  makeCongressTrade,
  makePatent,
  makeProvenance,
  makeTmpDir,
} from "../test-helpers.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";

let store: TrackerStore;
let tmp: { dir: string; cleanup: () => void };

beforeAll(async () => {
  store = await TrackerStore.open(":memory:");
  tmp = makeTmpDir("export");

  await store.upsert(DATASETS["short-volume"], [
    makeShortVolumeDay({
      id: "2026-08-20:EXCO:CNMS",
      date: "2026-08-20",
      provenance: makeProvenance("finra", { retrievedAt: "2026-08-20T23:00:00.000Z" }),
    }),
    makeShortVolumeDay({
      id: "2026-08-21:EXCO:CNMS",
      date: "2026-08-21",
      provenance: makeProvenance("finra", { retrievedAt: "2026-08-21T23:00:00.000Z" }),
    }),
  ]);
  await store.upsert(DATASETS["congress-trades"], [makeCongressTrade()]);
  await store.setWatermark("finra", "shortvol.CNMS.lastDay", "2026-08-21");
});

afterAll(async () => {
  await store.close();
  tmp.cleanup();
});

describe("exportDumps", () => {
  it("writes daily deltas, latest.json, snapshots, and a manifest", async () => {
    // A fixed `now` (matching the fixtures' 2026-08-2x retrievedAt dates)
    // keeps the entity-feed window — and everything downstream that reads
    // this export's output — deterministic regardless of when the suite runs.
    const summary = await exportDumps(store, {
      outDir: tmp.dir,
      now: new Date("2026-08-24T12:30:00Z"),
    });

    const shortVolDir = join(tmp.dir, "short-volume", "daily");
    expect(existsSync(join(shortVolDir, "2026", "2026-08-20.json"))).toBe(true);
    expect(existsSync(join(shortVolDir, "2026", "2026-08-21.json"))).toBe(true);
    expect(existsSync(join(shortVolDir, "latest.json"))).toBe(true);
    expect(existsSync(join(shortVolDir, "snapshot.json.gz"))).toBe(true);
    expect(existsSync(join(tmp.dir, "manifest.json"))).toBe(true);
    expect(summary.rowTotals["short-volume"]).toBe(2);

    const delta = JSON.parse(
      readFileSync(join(shortVolDir, "2026", "2026-08-20.json"), "utf8"),
    ) as ShortVolumeDay[];
    expect(delta).toHaveLength(1);
    expect(delta[0]?.id).toBe("2026-08-20:EXCO:CNMS");

    const manifest = JSON.parse(readFileSync(join(tmp.dir, "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.datasets["short-volume"].rows).toBe(2);
    expect(manifest.sources.finra.watermarks["shortvol.CNMS.lastDay"]).toBe("2026-08-21");
  });

  it("writes per-entity feeds alongside feed.xml, and records their counts on the manifest", async () => {
    // short-volume: one ticker (EXCO), no member concept.
    const shortVolDir = join(tmp.dir, "short-volume", "daily");
    expect(existsSync(join(shortVolDir, "feeds", "by-ticker", "EXCO.xml"))).toBe(true);
    expect(existsSync(join(shortVolDir, "feeds", "by-member"))).toBe(false);

    // congress-trades: one ticker (EXCO) and one member (E000001, the
    // fixture's default bioguideId), from the single seeded trade.
    const congressDir = join(tmp.dir, "congress", "trades");
    expect(existsSync(join(congressDir, "feeds", "by-ticker", "EXCO.xml"))).toBe(true);
    expect(existsSync(join(congressDir, "feeds", "by-member", "E000001.xml"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(tmp.dir, "manifest.json"), "utf8"));
    expect(manifest.datasets["short-volume"].entityFeeds).toEqual({ byTicker: 1, byMember: 0 });
    expect(manifest.datasets["congress-trades"].entityFeeds).toEqual({
      byTicker: 1,
      byMember: 1,
    });
    // A dataset with no ticker or member concept always reports zeros, never
    // an omitted field.
    expect(manifest.datasets["committee-assignments"].entityFeeds).toEqual({
      byTicker: 0,
      byMember: 0,
    });
  });

  it("round-trips: snapshot → fresh store → identical records", async () => {
    const snapshot = gunzipSync(
      readFileSync(join(tmp.dir, "short-volume", "daily", "snapshot.json.gz")),
    ).toString("utf8");
    const records = JSON.parse(snapshot) as ShortVolumeDay[];

    const fresh = await TrackerStore.open(":memory:");
    await fresh.upsert(DATASETS["short-volume"], records);
    expect(await fresh.count("short-volume")).toBe(2);

    const reExported: ShortVolumeDay[] = [];
    for await (const row of fresh.iterate(DATASETS["short-volume"])) reExported.push(row);
    const original: ShortVolumeDay[] = [];
    for await (const row of store.iterate(DATASETS["short-volume"])) original.push(row);
    expect(reExported).toEqual(original);
    await fresh.close();
  });

  it("writes year-sharded snapshots and an RSS feed with primary-source links", async () => {
    const shortVolDir = join(tmp.dir, "short-volume", "daily");
    expect(existsSync(join(shortVolDir, "snapshot-2026.json.gz"))).toBe(true);

    const feed = readFileSync(join(shortVolDir, "feed.xml"), "utf8");
    expect(feed).toContain('<rss version="2.0">');
    expect(feed).toContain("LuxAlgo Market Trackers — Short-sale volume");
    expect(feed).toContain("<link>https://example.gov/primary/document/1</link>");
    expect(feed).toContain('guid isPermaLink="false"');

    const manifest = JSON.parse(readFileSync(join(tmp.dir, "manifest.json"), "utf8"));
    const files = manifest.datasets["short-volume"].snapshots.map((s: { file: string }) => s.file);
    expect(files).toContain("snapshot-2026.json.gz");
    expect(files).toContain("snapshot.json.gz");
    expect(manifest.datasets["short-volume"].feed).toBe("short-volume/daily/feed.xml");
  });

  it("builds a manifest with per-source health fields", async () => {
    const manifest = await buildManifest(store);
    expect(Object.keys(manifest.sources)).toHaveLength(16);
    expect(Object.keys(manifest.datasets)).toHaveLength(18);
    expect(manifest.sources.finra?.implementedDatasets).toContain("short-volume");
  });

  // Regression: a backfilled store can put its entire history on one
  // ingestion day. This dataset's single day/year exceeds both the old
  // `rowsIngestedOn` single-`.all()`-call read and V8's spread-argument
  // limit (~65k) that `all.push(...rows)`/`recentRows.push(...rows)` hit —
  // export must complete rather than OOM or throw "Maximum call stack size
  // exceeded".
  it("exports a dataset with 70,000+ rows sharing one event year and one ingestion day", async () => {
    const ROWS = 70_001;
    const bigStore = await TrackerStore.open(":memory:");
    const bigTmp = makeTmpDir("export-at-scale");
    try {
      const rows = Array.from({ length: ROWS }, (_, i) =>
        makeShortVolumeDay({
          id: `2026-06-15:TICK:M${i}`,
          date: "2026-06-15",
          ticker: "TICK",
          market: `M${i}`,
          provenance: makeProvenance("finra", { retrievedAt: "2026-08-24T12:00:00.000Z" }),
        }),
      );
      await bigStore.upsert(DATASETS["short-volume"], rows);

      const summary = await exportDumps(bigStore, {
        outDir: bigTmp.dir,
        datasets: ["short-volume"],
        // Below ROWS on purpose: also exercises the combined-snapshot
        // buffer's own discard-once-over-cap path in the same run.
        combinedSnapshotMaxRows: 1_000,
        now: new Date("2026-08-24T12:30:00Z"),
      });
      expect(summary.rowTotals["short-volume"]).toBe(ROWS);

      const dir = join(bigTmp.dir, "short-volume", "daily");
      const shardRows = JSON.parse(
        gunzipSync(readFileSync(join(dir, "snapshot-2026.json.gz"))).toString("utf8"),
      ) as unknown[];
      expect(shardRows).toHaveLength(ROWS);
      // Over combinedSnapshotMaxRows: no combined snapshot.json.gz.
      expect(existsSync(join(dir, "snapshot.json.gz"))).toBe(false);

      const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as unknown[];
      expect(latest).toHaveLength(ROWS);

      // feed.xml stays capped at MAX_ITEMS even though the day holds far more.
      const feed = readFileSync(join(dir, "feed.xml"), "utf8");
      expect(feed.match(/<item>/g)).toHaveLength(MAX_ITEMS);

      // entity-feeds' own recentRows.push(...rows) fix: one ticker, every
      // row in-window, no crash.
      expect(existsSync(join(dir, "feeds", "by-ticker", "TICK.xml"))).toBe(true);

      const manifest = JSON.parse(readFileSync(join(bigTmp.dir, "manifest.json"), "utf8"));
      expect(manifest.datasets["short-volume"].rows).toBe(ROWS);
      expect(
        manifest.datasets["short-volume"].snapshots.map((s: { file: string }) => s.file),
      ).toEqual(["snapshot-2026.json.gz"]);
    } finally {
      bigTmp.cleanup();
      await bigStore.close();
    }
  });

  // Regression: patents is wholesale-replaced each quarterly sync, so its one
  // ingestion day IS the whole 1976→today history — an ungated export spends
  // hours writing a multi-GB "daily delta" plus an equal latest.json and
  // materializes every row in memory for entity feeds. snapshotOnly must
  // confine such datasets to year shards + manifest while ordinary datasets
  // in the same run keep their full export.
  it("snapshotOnly datasets get year shards and a manifest, never deltas, latest.json, or feeds", async () => {
    const soStore = await TrackerStore.open(":memory:");
    const soTmp = makeTmpDir("export-snapshot-only-dataset");
    try {
      await soStore.upsert(DATASETS.patents, [
        makePatent(),
        makePatent({ id: "11111111", patentId: "11111111", grantDate: "2025-03-04" }),
      ]);
      await soStore.upsert(DATASETS["short-volume"], [makeShortVolumeDay()]);

      const summary = await exportDumps(soStore, {
        outDir: soTmp.dir,
        datasets: ["patents", "short-volume"],
        now: new Date("2026-08-24T12:30:00Z"),
      });
      expect(summary.rowTotals.patents).toBe(2);

      const patentsDir = join(soTmp.dir, "patents", "grants");
      expect(existsSync(join(patentsDir, "2026"))).toBe(false);
      expect(existsSync(join(patentsDir, "latest.json"))).toBe(false);
      expect(existsSync(join(patentsDir, "feed.xml"))).toBe(false);
      expect(existsSync(join(patentsDir, "feeds"))).toBe(false);

      expect(existsSync(join(patentsDir, "snapshot-2026.json.gz"))).toBe(true);
      expect(existsSync(join(patentsDir, "snapshot-2025.json.gz"))).toBe(true);
      expect(existsSync(join(patentsDir, "snapshot.json.gz"))).toBe(true);

      // The ordinary dataset in the same run is unaffected by the gate.
      const svDir = join(soTmp.dir, "short-volume", "daily");
      expect(existsSync(join(svDir, "latest.json"))).toBe(true);
      expect(existsSync(join(svDir, "feed.xml"))).toBe(true);

      const manifest = JSON.parse(readFileSync(join(soTmp.dir, "manifest.json"), "utf8"));
      expect(manifest.datasets.patents.rows).toBe(2);
      expect(manifest.datasets.patents.feed).toBeNull();
      expect(manifest.datasets["short-volume"].feed).toBe("short-volume/daily/feed.xml");
      expect(
        manifest.datasets.patents.snapshots.map((s: { file: string }) => s.file).sort(),
      ).toEqual(["snapshot-2025.json.gz", "snapshot-2026.json.gz", "snapshot.json.gz"]);
      expect(manifest.datasets.patents.entityFeeds).toEqual({ byTicker: 0, byMember: 0 });
    } finally {
      soTmp.cleanup();
      await soStore.close();
    }
  });

  it("--snapshots-only equivalent (deltas: false, feeds: false) writes only snapshots and the manifest", async () => {
    const soStore = await TrackerStore.open(":memory:");
    const soTmp = makeTmpDir("export-snapshots-only");
    try {
      await soStore.upsert(DATASETS["short-volume"], [makeShortVolumeDay()]);

      const summary = await exportDumps(soStore, {
        outDir: soTmp.dir,
        datasets: ["short-volume"],
        deltas: false,
        feeds: false,
        now: new Date("2026-08-24T12:30:00Z"),
      });

      const dir = join(soTmp.dir, "short-volume", "daily");
      expect(existsSync(join(dir, "2026"))).toBe(false);
      expect(existsSync(join(dir, "latest.json"))).toBe(false);
      expect(existsSync(join(dir, "feed.xml"))).toBe(false);
      expect(existsSync(join(dir, "feeds"))).toBe(false);

      expect(existsSync(join(dir, "snapshot-2026.json.gz"))).toBe(true);
      expect(existsSync(join(dir, "snapshot.json.gz"))).toBe(true);
      expect(existsSync(join(soTmp.dir, "manifest.json"))).toBe(true);
      expect(summary.rowTotals["short-volume"]).toBe(1);

      const manifest = JSON.parse(readFileSync(join(soTmp.dir, "manifest.json"), "utf8"));
      expect(manifest.datasets["short-volume"].rows).toBe(1);
      // feeds:false means no entity feeds ran this export, same as an empty count.
      expect(manifest.datasets["short-volume"].entityFeeds).toEqual({ byTicker: 0, byMember: 0 });
    } finally {
      soTmp.cleanup();
      await soStore.close();
    }
  });
});
