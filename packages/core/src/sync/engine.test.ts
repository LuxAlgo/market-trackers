import { describe, expect, it } from "vitest";
import { runSync, selectSources } from "./engine.js";
import { DocketStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";
import type { SourceContext } from "../sources/types.js";
import { ALL_SOURCES, sourceById } from "../sources/registry.js";

async function makeCtx(): Promise<{ ctx: SourceContext; store: DocketStore }> {
  const store = await DocketStore.open(":memory:");
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
    expect(selected.map((s) => s.id)).toContain("finra");
    expect(selected.map((s) => s.id)).toContain("edgar");
  });

  it("includes explicitly named scaffolded sources", () => {
    expect(selectSources(["house-clerk"]).map((s) => s.id)).toEqual(["house-clerk"]);
  });

  it("registry covers all six sources and rejects unknowns", () => {
    expect(ALL_SOURCES).toHaveLength(6);
    expect(() => sourceById("quiverquant")).toThrow(/Unknown source/);
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

  it("scaffolded sources sync as an explicit no-op", async () => {
    const { ctx, store } = await makeCtx();
    const summary = await runSync(ctx, { sources: ["house-clerk"] });
    expect(summary.ok).toBe(true);
    expect(summary.results[0]?.implemented).toBe(false);
    expect(summary.results[0]?.notes[0]).toMatch(/not implemented/);
    await store.close();
  });
});
