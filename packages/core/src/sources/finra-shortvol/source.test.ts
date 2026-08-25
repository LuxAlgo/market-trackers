import { describe, expect, it } from "vitest";
import { finraSource, shortVolumeFileUrl } from "./source.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: the fixture file exists for
 * one date, everything else 404s (weekends/holidays/unpublished days) — the
 * sync must ingest exactly that day, set the watermark, and be idempotent.
 */

const FIXTURE_DAY = "2026-03-02";
const FIXTURE_URL = shortVolumeFileUrl("CNMS", FIXTURE_DAY);

function mockFetch(): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    if (String(url) === FIXTURE_URL) {
      return new Response(readFixture("finra-shortvol", "case-decimal-era", "input.txt"), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{ ctx: SourceContext; store: AltDataStore }> {
  const store = await AltDataStore.open(":memory:");
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(),
    // Pin "today" to the day after the fixture so the walk is two days long.
    now: () => new Date("2026-03-03T12:00:00Z"),
  };
  return { ctx, store };
}

describe("finraSource.sync", () => {
  it("ingests the published day, 404-skips the rest, sets the watermark, and re-runs idempotently", async () => {
    const { ctx, store } = await makeCtx();

    const first = await finraSource.sync(ctx, { since: FIXTURE_DAY });
    expect(first.rowsUpserted).toBe(2);
    expect(first.perDataset["short-volume"]).toBe(2);
    expect(first.parse).toEqual({ attempted: 2, succeeded: 2 });
    expect(await store.count("short-volume")).toBe(2);

    // Watermark advanced through at least the fixture day.
    const watermark = await store.getWatermark("finra", "shortvol.CNMS.lastDay");
    expect(watermark && watermark >= FIXTURE_DAY).toBe(true);

    // Header fingerprint recorded for drift detection.
    expect(await store.getFingerprint("finra", "shortvol.header")).toBeTruthy();

    // Re-running the same window duplicates nothing.
    const second = await finraSource.sync(ctx, { since: FIXTURE_DAY });
    expect(second.rowsUpserted).toBe(2);
    expect(await store.count("short-volume")).toBe(2);

    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, store } = await makeCtx();
    const result = await finraSource.sync(ctx, {
      since: FIXTURE_DAY,
      datasets: ["congress-trades"],
    });
    expect(result.rowsUpserted).toBe(0);
    await store.close();
  });

  it("honors --until: never requests a day past it, even though today is later", async () => {
    const { ctx, store } = await makeCtx(); // "today" is pinned to 2026-03-03
    const requested: string[] = [];
    const inner = ctx.fetchImpl as typeof fetch;
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requested.push(String(url));
      return inner(url, init);
    }) as typeof fetch;

    const result = await finraSource.sync(ctx, { since: FIXTURE_DAY, until: FIXTURE_DAY });
    expect(result.rowsUpserted).toBe(2);
    // Tomorrow's (today's, in walk terms) file is never requested.
    expect(requested).toEqual([FIXTURE_URL]);
    expect(await store.getWatermark("finra", "shortvol.CNMS.lastDay")).toBe(FIXTURE_DAY);
    await store.close();
  });

  it("a bounded backfill chunk over old ground never regresses an already-advanced watermark", async () => {
    const { ctx, store } = await makeCtx();
    // Simulate a live watermark that has already moved well past the fixture
    // day (as it would after months of regular incremental syncs).
    await store.setWatermark("finra", "shortvol.CNMS.lastDay", "2026-03-10");

    await finraSource.sync(ctx, { since: FIXTURE_DAY, until: FIXTURE_DAY });
    expect(await store.getWatermark("finra", "shortvol.CNMS.lastDay")).toBe("2026-03-10");
    await store.close();
  });
});

describe("finraSource.canary", () => {
  it("goes green when the latest file fetches, parses, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    // Canary walks back from today; serve the fixture for every date probed.
    ctx.fetchImpl = (async () =>
      new Response(readFixture("finra-shortvol", "case-decimal-era", "input.txt"), {
        status: 200,
      })) as typeof fetch;
    await finraSource.sync(ctx, { since: FIXTURE_DAY, datasets: ["short-volume"] });

    const outcome = await finraSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fetch-daily-file"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when the header format drifts", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("finra", "shortvol.header", "somethingelse");
    ctx.fetchImpl = (async () =>
      new Response(readFixture("finra-shortvol", "case-decimal-era", "input.txt"), {
        status: 200,
      })) as typeof fetch;
    const outcome = await finraSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });
});
