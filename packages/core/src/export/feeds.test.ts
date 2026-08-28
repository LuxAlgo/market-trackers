import { describe, expect, it } from "vitest";
import { buildRssFeed, renderFeedXml, BoundedFeedSelection, MAX_ITEMS } from "./feeds.js";
import { DATASETS } from "../schema/datasets.js";
import { makeShortVolumeDay, makeProvenance } from "../test-helpers.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";

/**
 * feed.xml's item selection ("newest MAX_ITEMS by provenance.retrievedAt")
 * has to survive being computed incrementally from a day too large to
 * materialize — see `BoundedFeedSelection` in feeds.ts. These tests pin
 * that the incremental path matches `buildRssFeed`'s one-shot sort+slice
 * exactly, including its tie behavior — `retrievedAt` collisions are
 * ordinary here (a backfill or a bulk sync commonly stamps a whole batch
 * with the same instant).
 */

function makeDay(rowCount: number, dupEveryN: number): ShortVolumeDay[] {
  return Array.from({ length: rowCount }, (_, i) => {
    // Every `dupEveryN` consecutive rows share one retrievedAt — real ties,
    // not just closely-spaced distinct timestamps.
    const bucket = Math.floor(i / dupEveryN) % 1000;
    const retrievedAt = `2026-08-24T00:00:00.${String(bucket).padStart(3, "0")}Z`;
    return makeShortVolumeDay({
      id: `2026-08-24:TICK:M${String(i).padStart(6, "0")}`,
      date: "2026-08-24",
      ticker: "TICK",
      market: `M${i}`,
      provenance: makeProvenance("finra", { retrievedAt }),
    });
  });
}

const GENERATED_AT = "2026-08-24T12:30:00.000Z";

describe("BoundedFeedSelection", () => {
  it("matches buildRssFeed's full sort+slice byte-for-byte on a day larger than MAX_ITEMS, ties included", () => {
    const dataset = DATASETS["short-volume"];
    const rows = makeDay(250, 6);
    expect(rows.length).toBeGreaterThan(MAX_ITEMS);

    // The old, unbounded path: materialize everything, sort, slice.
    const expectedXml = buildRssFeed(dataset, rows, GENERATED_AT);

    // The new, bounded path: stream the same rows in the same order.
    const selection = new BoundedFeedSelection<ShortVolumeDay>();
    for (const row of rows) selection.push(row);
    const actualXml = renderFeedXml(dataset, selection.items(), GENERATED_AT);

    expect(actualXml).toBe(expectedXml);
    expect(actualXml.match(/<item>/g)).toHaveLength(MAX_ITEMS);
  });

  it("matches when the day is smaller than the cap too (nothing gets truncated either way)", () => {
    const dataset = DATASETS["short-volume"];
    const rows = makeDay(40, 6);

    const expectedXml = buildRssFeed(dataset, rows, GENERATED_AT);

    const selection = new BoundedFeedSelection<ShortVolumeDay>();
    for (const row of rows) selection.push(row);
    const actualXml = renderFeedXml(dataset, selection.items(), GENERATED_AT);

    expect(actualXml).toBe(expectedXml);
    expect(actualXml.match(/<item>/g)).toHaveLength(40);
  });

  it("respects a custom cap", () => {
    const dataset = DATASETS["short-volume"];
    const rows = makeDay(30, 4);

    const expectedXml = renderFeedXml(
      dataset,
      [...rows]
        .sort((a, b) => (a.provenance.retrievedAt < b.provenance.retrievedAt ? 1 : -1))
        .slice(0, 5),
      GENERATED_AT,
    );

    const selection = new BoundedFeedSelection<ShortVolumeDay>(5);
    for (const row of rows) selection.push(row);
    const actualXml = renderFeedXml(dataset, selection.items(), GENERATED_AT);

    expect(actualXml).toBe(expectedXml);
    expect(actualXml.match(/<item>/g)).toHaveLength(5);
  });
});
