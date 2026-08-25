import { describe, expect, it } from "vitest";
import { runSync, selectSources } from "./engine.js";
import { AltDataStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";
import type { SourceContext } from "../sources/types.js";
import { ALL_SOURCES, sourceById } from "../sources/registry.js";

async function makeCtx(): Promise<{ ctx: SourceContext; store: AltDataStore }> {
  const store = await AltDataStore.open(":memory:");
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
      "fec",
      "finra",
      "house-clerk",
      "lda",
      "openfda",
      "patentsview",
      "senate-efd",
      "usaspending",
    ]);
  });

  it("restricts to explicitly named sources", () => {
    expect(selectSources(["house-clerk"]).map((s) => s.id)).toEqual(["house-clerk"]);
  });

  it("registry covers all fourteen sources and rejects unknowns", () => {
    expect(ALL_SOURCES).toHaveLength(14);
    expect(() => sourceById("not-a-source")).toThrow(/Unknown source/);
  });
});

describe("runSync", () => {
  it("records a run per source and keeps going when one fails", async () => {
    const { ctx, store } = await makeCtx();
    // edgar fails fast: no contact email configured → buildUserAgent throws.
    const summary = await runSync(ctx, { sources: ["edgar", "finra"], since: "2026-08-21" });
    expect(summary.ok).toBe(false);

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

  it("a dataset filter no source produces makes the run an explicit no-op", async () => {
    const { ctx, store } = await makeCtx();
    // finra only produces short-volume; the filter short-circuits before any
    // network access, so this exercises the engine path fully offline.
    const summary = await runSync(ctx, { sources: ["finra"], datasets: ["congress-trades"] });
    expect(summary.ok).toBe(true);
    expect(summary.results[0]?.implemented).toBe(true);
    expect(summary.results[0]?.rowsUpserted).toBe(0);
    expect((await store.latestSyncRun("finra"))?.ok).toBe(true);
    await store.close();
  });
});
