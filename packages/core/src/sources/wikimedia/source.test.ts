import { describe, expect, it } from "vitest";
import { wikimediaSource } from "./source.js";
import { pageviewsUrl } from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { WikiPageview } from "../../schema/wiki-pageview.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { makeWikiPageview } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source tests with a mocked network. The curated map ships ~90
 * articles, so every test that exercises a real walk pins `--limit` (the
 * "articles fetched this run" cap) to keep the request count for that test
 * well under the client's 5 req/s ceiling — otherwise a full unthrottled
 * walk of the whole map would make these tests genuinely rate-limited.
 * `Apple_Inc.` (index 0) and `Microsoft` (index 1) are the map's first two
 * entries and are used as the walk targets throughout, matching the order
 * `wikimediaSource.canary` itself probes.
 */

const APPLE = { project: "en.wikipedia", article: "Apple_Inc.", tickers: ["AAPL"] };
const MICROSOFT = { project: "en.wikipedia", article: "Microsoft", tickers: ["MSFT"] };
// "pageviews.en.wikipedia.Apple_Inc..lastDay" — the double "." is expected:
// one ends "Apple_Inc." and one starts the ".lastDay" suffix.
const APPLE_WATERMARK_KEY = "pageviews.en.wikipedia.Apple_Inc..lastDay";
const MICROSOFT_WATERMARK_KEY = "pageviews.en.wikipedia.Microsoft.lastDay";
const FINGERPRINT_KEY = "pageviews.item-fields";

function rawItem(entry: { project: string; article: string }, timestamp: string, views: number) {
  return {
    project: entry.project,
    article: entry.article,
    granularity: "daily",
    timestamp,
    access: "all-access",
    agent: "user",
    views,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes exact URLs to response factories; anything unmatched 404s. */
function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const factory = routes[String(url)];
    return factory ? factory() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(now: string): Promise<{ ctx: SourceContext; store: AltDataStore }> {
  const store = await AltDataStore.open(":memory:");
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: (async () => new Response("not found", { status: 404 })) as typeof fetch,
    now: () => new Date(now),
  };
  return { ctx, store };
}

describe("wikimediaSource.sync", () => {
  it("ingests one article's window, sets its watermark, fingerprints, and is idempotent", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    const url = pageviewsUrl(APPLE.project, APPLE.article, "2026-08-18", "2026-08-20");
    ctx.fetchImpl = mockFetch({
      [url]: () =>
        jsonResponse({
          items: [
            rawItem(APPLE, "2026081800", 55000),
            rawItem(APPLE, "2026081900", 51200),
            rawItem(APPLE, "2026082000", 60310),
          ],
        }),
    });

    const first = await wikimediaSource.sync(ctx, {
      since: "2026-08-18",
      until: "2026-08-20",
      limit: 1,
    });
    expect(first.rowsUpserted).toBe(3);
    expect(first.perDataset["wiki-pageviews"]).toBe(3);
    expect(first.parse).toEqual({ attempted: 3, succeeded: 3 });
    expect(await store.count("wiki-pageviews")).toBe(3);
    expect(await store.getWatermark("wikimedia", APPLE_WATERMARK_KEY)).toBe("2026-08-20");
    expect(await store.getFingerprint("wikimedia", FINGERPRINT_KEY)).toBeTruthy();

    const rows: WikiPageview[] = [];
    for await (const row of store.iterate(DATASETS["wiki-pageviews"])) rows.push(row);
    expect(rows.map((r) => [r.day, r.views, r.tickers])).toEqual([
      ["2026-08-18", 55000, ["AAPL"]],
      ["2026-08-19", 51200, ["AAPL"]],
      ["2026-08-20", 60310, ["AAPL"]],
    ]);
    expect(rows.every((r) => r.provenance.sourceUrl === url)).toBe(true);
    expect(rows.every((r) => r.provenance.parser === "wikimedia-pageviews@1")).toBe(true);

    // Re-running the identical window duplicates nothing.
    const second = await wikimediaSource.sync(ctx, {
      since: "2026-08-18",
      until: "2026-08-20",
      limit: 1,
    });
    expect(second.rowsUpserted).toBe(3);
    expect(await store.count("wiki-pageviews")).toBe(3);

    await store.close();
  });

  it("respects the datasets filter without touching the network", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await wikimediaSource.sync(ctx, { datasets: ["short-volume"] });
    expect(result.rowsUpserted).toBe(0);
    expect(requested).toHaveLength(0);
    await store.close();
  });

  it("honors --until: never requests a day past it, even though today is later", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await wikimediaSource.sync(ctx, { since: "2026-08-10", until: "2026-08-12", limit: 1 });
    expect(requested).toEqual([
      pageviewsUrl(APPLE.project, APPLE.article, "2026-08-10", "2026-08-12"),
    ]);
    // A 404 over the whole range is still a completed walk: watermark advances to the bound.
    expect(await store.getWatermark("wikimedia", APPLE_WATERMARK_KEY)).toBe("2026-08-12");
    await store.close();
  });

  it("never requests through today — daily counts finalize with ~1-day lag", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z"); // "today" = 2026-08-24
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // No --until given: the range end must still stop at yesterday (2026-08-23).
    await wikimediaSource.sync(ctx, { since: "2026-08-20", limit: 1 });
    expect(requested).toEqual([
      pageviewsUrl(APPLE.project, APPLE.article, "2026-08-20", "2026-08-23"),
    ]);
    await store.close();
  });

  it("a 404 for an article's whole range is skipped with a note, not a failure, and still advances its watermark", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    const result = await wikimediaSource.sync(ctx, {
      since: "2026-08-18",
      until: "2026-08-20",
      limit: 1,
    });
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes.some((n) => n.includes("Apple_Inc.") && n.includes("404"))).toBe(true);
    expect(await store.getWatermark("wikimedia", APPLE_WATERMARK_KEY)).toBe("2026-08-20");
    await store.close();
  });

  it("isolates one article's genuine HTTP error from the rest of the walk", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    const appleUrl = pageviewsUrl(APPLE.project, APPLE.article, "2026-08-18", "2026-08-20");
    const msftUrl = pageviewsUrl(MICROSOFT.project, MICROSOFT.article, "2026-08-18", "2026-08-20");
    ctx.fetchImpl = mockFetch({
      // 400 is not in politeFetch's default retry set, so this throws immediately.
      [appleUrl]: () => new Response("bad request", { status: 400 }),
      [msftUrl]: () => jsonResponse({ items: [rawItem(MICROSOFT, "2026081800", 30000)] }),
    });

    const result = await wikimediaSource.sync(ctx, {
      since: "2026-08-18",
      until: "2026-08-20",
      limit: 2,
    });
    expect(result.notes.some((n) => n.includes("Apple_Inc."))).toBe(true);
    expect(await store.getWatermark("wikimedia", APPLE_WATERMARK_KEY)).toBeNull();
    // Microsoft still ingested and advanced despite Apple's failure.
    expect(result.rowsUpserted).toBe(1);
    expect(await store.getWatermark("wikimedia", MICROSOFT_WATERMARK_KEY)).toBe("2026-08-20");
    await store.close();
  });

  it("honors --limit (articles fetched this run), noting when hit", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await wikimediaSource.sync(ctx, {
      since: "2026-08-18",
      until: "2026-08-20",
      limit: 1,
    });
    expect(requested).toHaveLength(1);
    expect(result.notes.some((n) => n.includes("--limit 1"))).toBe(true);
    await store.close();
  });

  it("honors --full by ignoring the stored watermark and re-backfilling from today - backfillDays", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    // Deliberately far from "today - backfillDays" (2026-08-21) so the two
    // code paths (watermark+1 vs. backfillDays-back) cannot coincide.
    await store.setWatermark("wikimedia", APPLE_WATERMARK_KEY, "2026-08-15");
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // No --since given: full ignores the watermark (which would otherwise
    // start the walk at 2026-08-16) and instead starts backfillDays (3) back.
    await wikimediaSource.sync(ctx, { full: true, limit: 1 });
    expect(requested).toEqual([
      pageviewsUrl(APPLE.project, APPLE.article, "2026-08-21", "2026-08-23"),
    ]);
    await store.close();
  });

  it("an incremental run with no --since continues from watermark + 1 day", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    // Same deliberately-distant watermark as the --full test above, so the
    // two tests' expected URLs prove they took different code paths.
    await store.setWatermark("wikimedia", APPLE_WATERMARK_KEY, "2026-08-15");
    const requested: string[] = [];
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await wikimediaSource.sync(ctx, { limit: 1 });
    expect(requested).toEqual([
      pageviewsUrl(APPLE.project, APPLE.article, "2026-08-16", "2026-08-23"),
    ]);
    await store.close();
  });
});

describe("wikimediaSource.canary", () => {
  const CANARY_ITEM = rawItem(APPLE, "2026082000", 12345);

  it("goes green: map validates, probe fetches, fingerprint baseline recorded, fresh, parse rate healthy", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => jsonResponse({ items: [CANARY_ITEM] })) as typeof fetch;

    // Populate freshness with a row inserted directly — going through sync()
    // would also set the fingerprint prematurely, which would make the
    // "baseline recorded" assertion below false. The last-sync-run stats are
    // seeded the same way the generic sync engine (not the source itself)
    // would record them.
    await store.upsert(DATASETS["wiki-pageviews"], [makeWikiPageview()]);
    const runId = await store.startSyncRun("wikimedia");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 1,
      parseAttempted: 1,
      parseSucceeded: 1,
    });

    const outcome = await wikimediaSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["map-validates"]?.ok).toBe(true);
    expect(byName["map-validates"]?.severity).toBe("hard");
    expect(byName["probe-fetch"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.note).toBe("baseline recorded");
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-wiki-pageviews"]?.ok).toBe(true);
    expect(byName["freshness-wiki-pageviews"]?.severity).toBe("soft");

    // A second call compares against the recorded baseline and still matches.
    const again = await wikimediaSource.canary(ctx);
    const fingerprint = again.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(true);
    expect(fingerprint?.note).toBeUndefined();
    await store.close();
  });

  it("hard-fails the fingerprint check when the result-item shape drifts", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    await store.setFingerprint("wikimedia", FINGERPRINT_KEY, "somethingelse");
    ctx.fetchImpl = (async () => jsonResponse({ items: [CANARY_ITEM] })) as typeof fetch;
    const outcome = await wikimediaSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe-fetch check when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await wikimediaSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-fetch");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });

  it("passes probe-fetch (with a 'no data' note) when the probe 404s, and skips fingerprinting", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const outcome = await wikimediaSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-fetch");
    expect(probe?.ok).toBe(true);
    expect(probe?.note).toContain("no data");
    expect(outcome.checks.some((c) => c.name === "fingerprint")).toBe(false);
    await store.close();
  });

  it("omits the parse-success-rate check when no sync run has been recorded yet", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => jsonResponse({ items: [CANARY_ITEM] })) as typeof fetch;
    const outcome = await wikimediaSource.canary(ctx);
    expect(outcome.checks.some((c) => c.name === "parse-success-rate")).toBe(false);
    await store.close();
  });

  it("hard-fails the parse-success-rate check when the last sync run degraded", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => jsonResponse({ items: [CANARY_ITEM] })) as typeof fetch;
    const runId = await store.startSyncRun("wikimedia");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 80,
      parseAttempted: 100,
      parseSucceeded: 80,
    });
    const outcome = await wikimediaSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(false);
    expect(rate?.severity).toBe("hard");
    await store.close();
  });

  it("soft-fails freshness when nothing has been ingested yet", async () => {
    const { ctx, store } = await makeCtx("2026-08-24T12:00:00Z");
    ctx.fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const outcome = await wikimediaSource.canary(ctx);
    const freshness = outcome.checks.find((c) => c.name === "freshness-wiki-pageviews");
    expect(freshness?.ok).toBe(false);
    expect(freshness?.severity).toBe("soft");
    await store.close();
  });
});
