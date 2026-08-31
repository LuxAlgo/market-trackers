import { describe, expect, it } from "vitest";
import { runSync, selectSources } from "./engine.js";
import { TrackerStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";
import type { SourceContext } from "../sources/types.js";
import { ALL_SOURCES, sourceById } from "../sources/registry.js";

async function makeCtx(): Promise<{ ctx: SourceContext; store: TrackerStore }> {
  const store = await TrackerStore.open(":memory:");
  return {
    store,
    ctx: {
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
      // Nothing is reachable: implemented sources will fail or no-op cleanly.
      fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    },
  };
}

describe("selectSources", () => {
  it("defaults to implemented sources only", () => {
    const selected = selectSources();
    expect(selected.every((s) => s.implemented)).toBe(true);
    expect(selected.map((s) => s.id).sort()).toEqual([
      "cftc",
      "clinicaltrials",
      "congress-legislators",
      "edgar",
      "edgar-bulk",
      "fec",
      "federalreserve",
      "finra",
      "govinfo",
      "govinfo-hearings",
      "house-clerk",
      "lda",
      "openfda",
      "patentsview",
      "senate-efd",
      "usaspending",
      "wikimedia",
    ]);
  });

  it("restricts to explicitly named sources", () => {
    expect(selectSources(["house-clerk"]).map((s) => s.id)).toEqual(["house-clerk"]);
  });

  it("registry covers all seventeen sources and rejects unknowns", () => {
    expect(ALL_SOURCES).toHaveLength(17);
    expect(() => sourceById("not-a-source")).toThrow(/Unknown source/);
  });
});

describe("runSync", () => {
  it("records a run per source and keeps going when one fails", async () => {
    const { ctx, store } = await makeCtx();
    // edgar fails fast: no contact email configured → buildUserAgent throws.
    const summary = await runSync(ctx, { sources: ["edgar", "finra"], since: "2026-08-21" });
    expect(summary.ok).toBe(false);
    // finra succeeded, so the run is still partially ok (--allow-partial's exit signal).
    expect(summary.partialOk).toBe(true);

    const edgarResult = summary.results.find((r) => r.source === "edgar");
    expect(edgarResult?.error).toMatch(/User-Agent/);

    const finraResult = summary.results.find((r) => r.source === "finra");
    expect(finraResult?.error).toBeUndefined();

    const edgarRun = await store.latestSyncRun("edgar");
    expect(edgarRun?.ok).toBe(false);
    expect(edgarRun?.error).toMatch(/User-Agent/);
    const finraRun = await store.latestSyncRun("finra");
    expect(finraRun?.ok).toBe(true);
    await store.close();
  });

  it("partialOk stays false when every source fails", async () => {
    const { ctx, store } = await makeCtx();
    // edgar is the only selected source and fails fast (no contact email).
    const summary = await runSync(ctx, { sources: ["edgar"], since: "2026-08-21" });
    expect(summary.ok).toBe(false);
    expect(summary.partialOk).toBe(false);
    await store.close();
  });

  it("a dataset filter no source produces makes the run an explicit no-op", async () => {
    const { ctx, store } = await makeCtx();
    // finra only produces short-volume; the filter short-circuits before any
    // network access, so this exercises the engine path fully offline.
    const summary = await runSync(ctx, { sources: ["finra"], datasets: ["congress-trades"] });
    expect(summary.ok).toBe(true);
    expect(summary.partialOk).toBe(true);
    expect(summary.results[0]?.implemented).toBe(true);
    expect(summary.results[0]?.rowsUpserted).toBe(0);
    expect((await store.latestSyncRun("finra"))?.ok).toBe(true);
    await store.close();
  });
});
