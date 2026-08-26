import { describe, expect, it } from "vitest";
import { runBackfill, BACKFILL_WATERMARK_KEY, type RunSyncFn } from "./engine.js";
import type { RunSyncOptions, SyncSummary } from "../sync/engine.js";
import type { SourceSyncResult } from "../sources/types.js";
import type { SourceId } from "../schema/provenance.js";
import { AltDataStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";
import type { SourceContext } from "../sources/types.js";

/**
 * Engine-only tests: no real source ever runs. `runSyncFn` is a scripted
 * recorder standing in for `runSync`, so these exercise chunk boundaries,
 * resume-from-watermark, early-stop accounting, and per-source failure
 * isolation without touching the network or the source registry.
 */

async function makeCtx(): Promise<SourceContext & { store: AltDataStore }> {
  const store = await AltDataStore.open(":memory:");
  return {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
  };
}

type ScriptFn = (
  opts: RunSyncOptions,
  callIndex: number,
) => Partial<SourceSyncResult & { error?: string }>;

function fakeRunSync(script: ScriptFn): { fn: RunSyncFn; calls: RunSyncOptions[] } {
  const calls: RunSyncOptions[] = [];
  let index = 0;
  const fn: RunSyncFn = async (_ctx, opts) => {
    calls.push(opts);
    const source = (opts.sources ?? [])[0] as SourceId;
    const partial = script(opts, index++);
    const result: SourceSyncResult & { error?: string } = {
      source,
      implemented: true,
      rowsUpserted: 0,
      parse: { attempted: 0, succeeded: 0 },
      perDataset: {},
      notes: [],
      ...partial,
    };
    const ok = result.error === undefined;
    const summary: SyncSummary = { ok, partialOk: ok, results: [result] };
    return summary;
  };
  return { fn, calls };
}

/** Always reports a fully-completed chunk (no --limit note, no error). */
const completeChunk = (rows = 1): Partial<SourceSyncResult> => ({
  rowsUpserted: rows,
  parse: { attempted: rows, succeeded: rows },
});

describe("runBackfill — chunking", () => {
  it("splits [from, to] into inclusive, non-overlapping chunkDays windows", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync(() => completeChunk());

    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      chunkDays: 3,
      runSyncFn: fn,
    });

    expect(calls.map((c) => [c.since, c.until])).toEqual([
      ["2024-01-01", "2024-01-03"],
      ["2024-01-04", "2024-01-06"],
      ["2024-01-07", "2024-01-09"],
      ["2024-01-10", "2024-01-10"],
    ]);
    const result = summary.sources[0];
    expect(result?.chunks.map((c) => [c.chunkStart, c.chunkEnd])).toEqual([
      ["2024-01-01", "2024-01-03"],
      ["2024-01-04", "2024-01-06"],
      ["2024-01-07", "2024-01-09"],
      ["2024-01-10", "2024-01-10"],
    ]);
    expect(result?.complete).toBe(true);
    expect(result?.completedThrough).toBe("2024-01-10");
    expect(summary.ok).toBe(true);
    await ctx.store.close();
  });

  it("defaults chunkDays to 30 and `to` to today when omitted", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync(() => completeChunk());

    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      runSyncFn: fn,
      now: () => new Date("2024-01-15T00:00:00.000Z"),
    });

    expect(summary.to).toBe("2024-01-15");
    expect(summary.chunkDays).toBe(30);
    // The whole window fits in one 30-day chunk.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.until).toBe("2024-01-15");
    await ctx.store.close();
  });

  it("a single-day window produces exactly one chunk", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync(() => completeChunk());
    await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-05-01",
      to: "2024-05-01",
      runSyncFn: fn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.since).toBe("2024-05-01");
    expect(calls[0]?.until).toBe("2024-05-01");
    await ctx.store.close();
  });
});

describe("runBackfill — resume from the backfill watermark", () => {
  it("a later run skips ahead of --from when it's below the completed-through mark", async () => {
    const ctx = await makeCtx();
    const first = fakeRunSync(() => completeChunk());
    await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      chunkDays: 5,
      runSyncFn: first.fn,
    });
    expect(await ctx.store.getWatermark("finra", BACKFILL_WATERMARK_KEY)).toBe("2024-01-10");

    // Second run asks for the SAME --from, further out --to: it should
    // resume the day after where the first run left off, not re-walk from
    // --from again.
    const second = fakeRunSync(() => completeChunk());
    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-20",
      chunkDays: 5,
      runSyncFn: second.fn,
    });
    expect(second.calls[0]?.since).toBe("2024-01-11");
    expect(summary.sources[0]?.chunks[0]?.chunkStart).toBe("2024-01-11");
    expect(await ctx.store.getWatermark("finra", BACKFILL_WATERMARK_KEY)).toBe("2024-01-20");
    await ctx.store.close();
  });

  it("--full ignores the completed-through mark and restarts at --from", async () => {
    const ctx = await makeCtx();
    const first = fakeRunSync(() => completeChunk());
    await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      runSyncFn: first.fn,
    });

    const second = fakeRunSync(() => completeChunk());
    await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      full: true,
      runSyncFn: second.fn,
    });
    expect(second.calls[0]?.since).toBe("2024-01-01");
    await ctx.store.close();
  });

  it("a --from already fully covered by a prior run is a no-op with zero chunks", async () => {
    const ctx = await makeCtx();
    const first = fakeRunSync(() => completeChunk());
    await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      runSyncFn: first.fn,
    });

    const second = fakeRunSync(() => completeChunk());
    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-10",
      runSyncFn: second.fn,
    });
    expect(second.calls).toHaveLength(0);
    expect(summary.sources[0]?.complete).toBe(true);
    expect(summary.sources[0]?.chunks).toHaveLength(0);
    await ctx.store.close();
  });
});

describe("runBackfill — early stop on --limit", () => {
  it("stops the source (without advancing past the interrupted chunk) when a chunk reports --limit hit", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync((_opts, i) => {
      if (i === 1) {
        return {
          rowsUpserted: 3,
          parse: { attempted: 3, succeeded: 3 },
          notes: ["stopped at --limit 3; watermark not advanced"],
        };
      }
      return completeChunk(2);
    });

    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-31",
      chunkDays: 15,
      limit: 1000, // generous — the *source's own* note triggers the stop, not the engine budget
      runSyncFn: fn,
    });

    // Only the first two chunks ran; the third (2024-01-31 alone) never did.
    expect(calls).toHaveLength(2);
    const result = summary.sources[0];
    expect(result?.chunks).toHaveLength(2);
    expect(result?.stoppedReason).toBe("limit");
    expect(result?.complete).toBe(false);
    // Chunk 1 (2024-01-01..01-15) completed; chunk 2 hit the limit and is
    // NOT considered complete, so the resume point stays at chunk 1's end.
    expect(result?.completedThrough).toBe("2024-01-15");
    expect(summary.ok).toBe(false);
    await ctx.store.close();
  });

  it("stops before starting a chunk once the engine's own remaining budget hits zero", async () => {
    const ctx = await makeCtx();
    // No source-reported --limit note anywhere — every chunk looks fully
    // complete on its own terms. The engine's shared budget is what stops it.
    const { fn, calls } = fakeRunSync((opts) => ({
      rowsUpserted: opts.limit ?? 0,
      parse: { attempted: opts.limit ?? 0, succeeded: opts.limit ?? 0 },
    }));

    const summary = await runBackfill(ctx, {
      sources: ["finra"],
      from: "2024-01-01",
      to: "2024-01-31",
      chunkDays: 10,
      limit: 5,
      runSyncFn: fn,
    });

    expect(calls).toHaveLength(1);
    const result = summary.sources[0];
    expect(result?.chunks).toHaveLength(1);
    expect(result?.stoppedReason).toBe("limit");
    expect(result?.complete).toBe(false);
    // The one chunk that did run reported no --limit note itself, so it
    // counts as complete and the resume point advances to its end.
    expect(result?.completedThrough).toBe("2024-01-10");
    await ctx.store.close();
  });
});

describe("runBackfill — per-source failure isolation", () => {
  it("one source erroring on its first chunk doesn't stop or shorten another source's run", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync((opts) => {
      const source = opts.sources?.[0];
      if (source === "edgar") return { error: "network exploded" };
      return completeChunk(4);
    });

    const summary = await runBackfill(ctx, {
      sources: ["edgar", "finra"],
      from: "2024-01-01",
      to: "2024-01-05",
      runSyncFn: fn,
    });

    expect(summary.ok).toBe(false);
    const edgarResult = summary.sources.find((s) => s.source === "edgar");
    const finraResult = summary.sources.find((s) => s.source === "finra");
    expect(edgarResult?.stoppedReason).toBe("error");
    expect(edgarResult?.complete).toBe(false);
    expect(edgarResult?.chunks[0]?.error).toBe("network exploded");
    expect(finraResult?.complete).toBe(true);
    expect(finraResult?.stoppedReason).toBeNull();
    expect(finraResult?.rowsUpserted).toBe(4);
    // Both sources were still attempted — edgar's failure didn't cut finra off.
    expect(calls.map((c) => c.sources?.[0])).toEqual(["edgar", "finra"]);
    await ctx.store.close();
  });

  it("a source failing on a LATER chunk keeps its earlier progress and stops only that source", async () => {
    const ctx = await makeCtx();
    const { fn } = fakeRunSync((opts, i) => {
      const source = opts.sources?.[0];
      if (source === "edgar" && i > 0) return { error: "boom on chunk 2" };
      return completeChunk(1);
    });

    const summary = await runBackfill(ctx, {
      sources: ["edgar"],
      from: "2024-01-01",
      to: "2024-01-20",
      chunkDays: 5,
      runSyncFn: fn,
    });

    const result = summary.sources[0];
    expect(result?.chunks).toHaveLength(2);
    expect(result?.completedThrough).toBe("2024-01-05");
    expect(result?.stoppedReason).toBe("error");
    await ctx.store.close();
  });
});

describe("runBackfill — date-unbounded sources", () => {
  it("skips a source whose sync ignores date bounds, with a note and zero chunks", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync(() => completeChunk());

    const summary = await runBackfill(ctx, {
      sources: ["congress-legislators"],
      from: "2024-01-01",
      to: "2024-01-31",
      runSyncFn: fn,
    });

    expect(calls).toHaveLength(0);
    const result = summary.sources[0];
    expect(result?.skipped).toBe(true);
    expect(result?.skippedReason).toMatch(/ignores date bounds/);
    expect(result?.chunks).toHaveLength(0);
    expect(result?.complete).toBe(true);
    expect(summary.ok).toBe(true);
    await ctx.store.close();
  });

  it("mixes a skipped source with a normal one in the same run", async () => {
    const ctx = await makeCtx();
    const { fn, calls } = fakeRunSync(() => completeChunk());

    const summary = await runBackfill(ctx, {
      sources: ["congress-legislators", "finra"],
      from: "2024-01-01",
      to: "2024-01-05",
      runSyncFn: fn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sources).toEqual(["finra"]);
    expect(summary.sources.find((s) => s.source === "congress-legislators")?.skipped).toBe(true);
    expect(summary.sources.find((s) => s.source === "finra")?.complete).toBe(true);
    await ctx.store.close();
  });
});
