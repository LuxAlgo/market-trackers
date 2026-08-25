import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDumps, buildManifest } from "./writer.js";
import { AltDataStore } from "../store/store.js";
import { DATASETS, SCHEMA_VERSION } from "../schema/datasets.js";
import {
  makeShortVolumeDay,
  makeCongressTrade,
  makeProvenance,
  makeTmpDir,
} from "../test-helpers.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";

let store: AltDataStore;
let tmp: { dir: string; cleanup: () => void };

beforeAll(async () => {
  store = await AltDataStore.open(":memory:");
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
    const summary = await exportDumps(store, { outDir: tmp.dir });

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

  it("round-trips: snapshot → fresh store → identical records", async () => {
    const snapshot = gunzipSync(
      readFileSync(join(tmp.dir, "short-volume", "daily", "snapshot.json.gz")),
    ).toString("utf8");
    const records = JSON.parse(snapshot) as ShortVolumeDay[];

    const fresh = await AltDataStore.open(":memory:");
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
    expect(feed).toContain("LuxAlgo Alt Data — Short-sale volume");
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
    expect(Object.keys(manifest.sources)).toHaveLength(11);
    expect(Object.keys(manifest.datasets)).toHaveLength(12);
    expect(manifest.sources.finra?.implementedDatasets).toContain("short-volume");
  });
});
