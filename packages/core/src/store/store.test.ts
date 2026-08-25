import { describe, expect, it } from "vitest";
import { DATASETS } from "../schema/datasets.js";
import { AltDataStore } from "./store.js";
import { MIGRATIONS } from "./migrate.js";
import { makeInsiderTransaction, makeShortVolumeDay, makeTmpDir } from "../test-helpers.js";
import { join } from "node:path";

async function memoryStore(): Promise<AltDataStore> {
  return AltDataStore.open(":memory:");
}

describe("AltDataStore (sqlite)", () => {
  it("migrates idempotently on reopen", async () => {
    const { dir, cleanup } = makeTmpDir("store");
    try {
      const file = join(dir, "alt-data.db");
      const first = await AltDataStore.open(file);
      await first.close();
      const second = await AltDataStore.open(file);
      const applied = await second.driver.all<{ id: string }>(
        `SELECT "id" FROM "schema_migrations"`,
      );
      expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
      await second.close();
    } finally {
      cleanup();
    }
  });

  it("upserts by natural key — re-running never duplicates", async () => {
    const store = await memoryStore();
    const record = makeShortVolumeDay();
    await store.upsert(DATASETS["short-volume"], [record]);
    await store.upsert(DATASETS["short-volume"], [record]);
    expect(await store.count("short-volume")).toBe(1);

    // Same key, fresher values → overwritten, still one row.
    await store.upsert(DATASETS["short-volume"], [
      { ...record, shortVolume: 999_999, shortRatio: 0.666666 },
    ]);
    expect(await store.count("short-volume")).toBe(1);
    const rows: (typeof record)[] = [];
    for await (const row of store.iterate(DATASETS["short-volume"])) rows.push(row);
    expect(rows[0]?.shortVolume).toBe(999_999);
    await store.close();
  });

  it("rejects records that fail schema validation, naming the field", async () => {
    const store = await memoryStore();
    const bad = { ...makeShortVolumeDay(), date: "21-08-2026" };
    await expect(store.upsert(DATASETS["short-volume"], [bad])).rejects.toThrow(/date/);
    await store.close();
  });

  it("chunks very large upserts", async () => {
    const store = await memoryStore();
    const rows = Array.from({ length: 4_000 }, (_, i) =>
      makeShortVolumeDay({ id: `2026-08-21:T${i}:CNMS`, ticker: `T${i}` }),
    );
    const result = await store.upsert(DATASETS["short-volume"], rows);
    expect(result.rows).toBe(4_000);
    expect(await store.count("short-volume")).toBe(4_000);
    await store.close();
  });

  it("stores and reads watermarks per source+key", async () => {
    const store = await memoryStore();
    expect(await store.getWatermark("finra", "shortvol.CNMS.lastDay")).toBeNull();
    await store.setWatermark("finra", "shortvol.CNMS.lastDay", "2026-08-20");
    await store.setWatermark("finra", "shortvol.CNMS.lastDay", "2026-08-21");
    expect(await store.getWatermark("finra", "shortvol.CNMS.lastDay")).toBe("2026-08-21");
    const all = await store.allWatermarks();
    expect(all).toHaveLength(1);
    await store.close();
  });

  it("records sync runs and reads the latest", async () => {
    const store = await memoryStore();
    const id = await store.startSyncRun("edgar");
    await store.finishSyncRun(id, {
      ok: true,
      rowsUpserted: 42,
      parseAttempted: 40,
      parseSucceeded: 40,
      details: { note: "test" },
    });
    const latest = await store.latestSyncRun("edgar");
    expect(latest?.ok).toBe(true);
    expect(latest?.rowsUpserted).toBe(42);
    expect(latest?.details).toEqual({ note: "test" });
    expect(await store.latestSyncRun("finra")).toBeNull();
    await store.close();
  });

  it("records canary runs with checks", async () => {
    const store = await memoryStore();
    await store.recordCanaryRun({
      source: "finra",
      status: "green",
      checks: [{ name: "fetch-daily-file", ok: true, note: "200" }],
    });
    const latest = await store.latestCanaryRun("finra");
    expect(latest?.status).toBe("green");
    expect(latest?.checks[0]?.name).toBe("fetch-daily-file");
    await store.close();
  });

  it("fingerprints and fetch-cache round-trip", async () => {
    const store = await memoryStore();
    await store.setFingerprint("edgar", "daily-index.header", "abc123");
    expect(await store.getFingerprint("edgar", "daily-index.header")).toBe("abc123");

    await store.setFetchCache("https://example.gov/x", { etag: 'W/"1"', lastModified: null });
    expect(await store.getFetchCache("https://example.gov/x")).toEqual({
      etag: 'W/"1"',
      lastModified: null,
    });
    await store.close();
  });

  it("cik/cusip/member caches round-trip", async () => {
    const store = await memoryStore();
    await store.replaceCikTickers([
      { cik: "0000123456", ticker: "EXCO", name: "EXAMPLECORP INC" },
      { cik: "0000123456", ticker: "EXCO.B", name: "EXAMPLECORP INC" },
    ]);
    expect(await store.tickersForCik("0000123456")).toEqual(["EXCO", "EXCO.B"]);
    expect(await store.cikTickerCount()).toBe(2);

    await store.putCusips([
      {
        cusip: "30303M102",
        ticker: "EXCO",
        figi: "BBG000TEST01",
        name: "EXAMPLECORP",
        mapSource: "openfigi",
      },
    ]);
    expect((await store.getCusip("30303M102"))?.ticker).toBe("EXCO");
    expect(await store.getCusip("00000UNKNOWN")).toBeNull();

    await store.replaceMemberMap([
      {
        bioguideId: "E000001",
        fullName: "Jane Example",
        firstName: "Jane",
        lastName: "Example",
        chamber: "senate",
        party: "I",
        state: "VT",
      },
    ]);
    expect((await store.allMembers())[0]?.bioguideId).toBe("E000001");
    await store.close();
  });

  it("ingestionDays + rowsIngestedOn bucket by retrieved_at day", async () => {
    const store = await memoryStore();
    await store.upsert(DATASETS["insider-transactions"], [
      makeInsiderTransaction({
        id: "a:nd:0",
        provenance: {
          source: "edgar",
          sourceUrl: "https://example.gov/a",
          retrievedAt: "2026-08-20T10:00:00.000Z",
          parser: "test@1",
          confidence: 1,
          needsReview: false,
        },
      }),
      makeInsiderTransaction({
        id: "b:nd:0",
        provenance: {
          source: "edgar",
          sourceUrl: "https://example.gov/b",
          retrievedAt: "2026-08-21T10:00:00.000Z",
          parser: "test@1",
          confidence: 1,
          needsReview: false,
        },
      }),
    ]);
    expect(await store.ingestionDays("insider-transactions")).toEqual(["2026-08-20", "2026-08-21"]);
    const day1 = await store.rowsIngestedOn(DATASETS["insider-transactions"], "2026-08-20");
    expect(day1.map((r) => r.id)).toEqual(["a:nd:0"]);
    expect(await store.maxRetrievedAt("insider-transactions")).toBe("2026-08-21T10:00:00.000Z");
    await store.close();
  });
});
