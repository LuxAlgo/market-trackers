import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDumps } from "./writer.js";
import { importDumps } from "./import.js";
import { AltDataStore } from "../store/store.js";
import { DATASETS } from "../schema/datasets.js";
import {
  makeCongressTrade,
  makeCotReport,
  makeShortVolumeDay,
  makeTmpDir,
} from "../test-helpers.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";

/**
 * The archive contract: everything export writes, import reads back — a
 * fresh store rebuilt from a dumps directory matches the original.
 */

let source: AltDataStore;
let tmp: { dir: string; cleanup: () => void };

beforeAll(async () => {
  source = await AltDataStore.open(":memory:");
  await source.upsert(DATASETS["short-volume"], [
    makeShortVolumeDay({ id: "2026-08-20:EXCO:CNMS", date: "2026-08-20" }),
    makeShortVolumeDay({ id: "2026-08-21:EXCO:CNMS", date: "2026-08-21" }),
    // A prior-year row exercises snapshot sharding on the way out and back.
    makeShortVolumeDay({ id: "2025-03-03:EXCO:CNMS", date: "2025-03-03" }),
  ]);
  await source.upsert(DATASETS["congress-trades"], [makeCongressTrade()]);
  await source.upsert(DATASETS["cot-reports"], [makeCotReport()]);
  tmp = makeTmpDir("import");
  await exportDumps(source, { outDir: tmp.dir });
});

afterAll(async () => {
  await source.close();
  tmp.cleanup();
});

describe("importDumps", () => {
  it("rebuilds a fresh store from a dumps directory", async () => {
    const rebuilt = await AltDataStore.open(":memory:");
    const summary = await importDumps(rebuilt, tmp.dir);
    expect(summary.perDataset["short-volume"]).toBeGreaterThanOrEqual(3);
    expect(summary.perDataset["congress-trades"]).toBeGreaterThanOrEqual(1);
    expect(summary.perDataset["cot-reports"]).toBeGreaterThanOrEqual(1);

    // Record-identical, not just count-identical.
    expect(await rebuilt.count("short-volume")).toBe(3);
    const original: ShortVolumeDay[] = [];
    for await (const row of source.iterate(DATASETS["short-volume"])) original.push(row);
    const restored: ShortVolumeDay[] = [];
    for await (const row of rebuilt.iterate(DATASETS["short-volume"])) restored.push(row);
    expect(restored).toEqual(original);

    // Importing the same directory again duplicates nothing.
    await importDumps(rebuilt, tmp.dir);
    expect(await rebuilt.count("short-volume")).toBe(3);
    await rebuilt.close();
  });

  it("imports a single snapshot file, inferring the dataset from its path", async () => {
    const rebuilt = await AltDataStore.open(":memory:");
    const summary = await importDumps(
      rebuilt,
      join(tmp.dir, "short-volume", "daily", "snapshot-2025.json.gz"),
    );
    expect(summary.rows).toBe(1);
    expect(await rebuilt.count("short-volume")).toBe(1);
    await rebuilt.close();
  });

  it("refuses a file whose dataset can't be inferred, naming the flag to use", async () => {
    const rebuilt = await AltDataStore.open(":memory:");
    const { writeFileSync } = await import("node:fs");
    const orphan = join(tmp.dir, "orphan.json");
    writeFileSync(orphan, "[]");
    await expect(importDumps(rebuilt, orphan)).rejects.toThrow(/--dataset/);
    await rebuilt.close();
  });
});
