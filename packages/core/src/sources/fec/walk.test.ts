import { describe, expect, it } from "vitest";
import { silentLogger } from "../../lib/logger.js";
import { WALK_BATCH_SIZE, walkPipeFile } from "./walk.js";

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `row-${i}`).join("\n");
}

describe("walkPipeFile", () => {
  it("batches upserts every WALK_BATCH_SIZE rows, never holding a whole large file in memory at once", async () => {
    const total = WALK_BATCH_SIZE * 2 + 321;
    const batchSizes: number[] = [];
    const outcome = await walkPipeFile<string>(
      linesOf(total),
      Number.POSITIVE_INFINITY,
      (line) => line,
      async (rows) => {
        batchSizes.push(rows.length);
        return rows.length;
      },
      silentLogger,
    );

    expect(outcome.attempted).toBe(total);
    expect(outcome.succeeded).toBe(total);
    expect(outcome.upserted).toBe(total);
    expect(outcome.limitHit).toBe(false);
    expect(outcome.firstLine).toBe("row-0");
    expect(batchSizes).toEqual([WALK_BATCH_SIZE, WALK_BATCH_SIZE, 321]);
  });

  it("flushes no trailing empty batch when the total is an exact multiple of the batch size", async () => {
    const batchSizes: number[] = [];
    await walkPipeFile<string>(
      linesOf(WALK_BATCH_SIZE),
      Number.POSITIVE_INFINITY,
      (line) => line,
      async (rows) => {
        batchSizes.push(rows.length);
        return rows.length;
      },
      silentLogger,
    );
    expect(batchSizes).toEqual([WALK_BATCH_SIZE]);
  });

  it("counts a throwing row as attempted-but-not-succeeded, and keeps walking", async () => {
    const outcome = await walkPipeFile<{ n: number }>(
      linesOf(5),
      Number.POSITIVE_INFINITY,
      (line) => {
        const n = Number(line.split("-")[1]);
        if (n === 2) throw new Error("boom");
        return { n };
      },
      async (rows) => rows.length,
      silentLogger,
    );
    expect(outcome.attempted).toBe(5);
    expect(outcome.succeeded).toBe(4);
    expect(outcome.upserted).toBe(4);
  });

  it("stops at limit without consuming the rest of the file, and reports limitHit", async () => {
    const outcome = await walkPipeFile<string>(
      linesOf(10),
      5,
      (line) => line,
      async (rows) => rows.length,
      silentLogger,
    );
    expect(outcome.attempted).toBe(5);
    expect(outcome.upserted).toBe(5);
    expect(outcome.limitHit).toBe(true);
  });

  it("captures firstLine even when limit is 0", async () => {
    const outcome = await walkPipeFile<string>(
      linesOf(3),
      0,
      (line) => line,
      async () => 0,
      silentLogger,
    );
    expect(outcome.firstLine).toBe("row-0");
    expect(outcome.attempted).toBe(0);
    expect(outcome.limitHit).toBe(true);
  });

  it("skips blank lines without counting them", async () => {
    const outcome = await walkPipeFile<string>(
      "row-0\n\n\nrow-1\n",
      Number.POSITIVE_INFINITY,
      (line) => line,
      async (rows) => rows.length,
      silentLogger,
    );
    expect(outcome.attempted).toBe(2);
    expect(outcome.succeeded).toBe(2);
  });
});
