import { describe, expect, it } from "vitest";
import { TrackerStore } from "../store/store.js";
import { silentLogger } from "../lib/logger.js";
import { COMPANY_TICKERS_URL, EdgarClient } from "../sources/edgar/client.js";
import { refreshCikTickersIfStale } from "./cik-ticker.js";

/**
 * Offline coverage of the company↔ticker refresh, including the
 * conditional-GET loop: 200 stores validators, a replayed validator earning
 * a 304 keeps the map and bumps freshness, and a fresh cache never fetches.
 */

const BODY = JSON.stringify({
  "0": { cik_str: 123456, ticker: "exco", title: "EXAMPLECORP INC" },
  "1": { cik_str: 123456, ticker: "exco.b", title: "EXAMPLECORP INC" },
});
const ETAG = '"v1-company-tickers"';
const LAST_MODIFIED = "Thu, 20 Aug 2026 10:00:00 GMT";

interface SeenRequest {
  url: string;
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
}

/** Serves company_tickers.json honoring If-None-Match; records every request. */
function mockSecFetch(): { fetchImpl: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      ifNoneMatch: headers["if-none-match"] ?? null,
      ifModifiedSince: headers["if-modified-since"] ?? null,
    });
    if (headers["if-none-match"] === ETAG) {
      return new Response(null, { status: 304 });
    }
    return new Response(BODY, {
      status: 200,
      headers: { "content-type": "application/json", etag: ETAG, "last-modified": LAST_MODIFIED },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function makeStore(): Promise<TrackerStore> {
  return TrackerStore.open(":memory:");
}

function makeClient(fetchImpl: typeof fetch): EdgarClient {
  return new EdgarClient({ userAgent: "market-trackers-test/0.0 (test@example.com)", fetchImpl });
}

async function markStale(store: TrackerStore): Promise<void> {
  await store.driver.run(`UPDATE "cik_tickers" SET "refreshed_at" = ?`, [
    "2020-01-01T00:00:00.000Z",
  ]);
}

describe("refreshCikTickersIfStale", () => {
  it("downloads on first run, stores validators, and sends no conditional headers", async () => {
    const store = await makeStore();
    const { fetchImpl, seen } = mockSecFetch();

    const result = await refreshCikTickersIfStale(store, makeClient(fetchImpl), silentLogger);
    expect(result).toEqual({ refreshed: true, entries: 2 });
    expect(await store.tickersForCik("0000123456")).toEqual(["EXCO", "EXCO.B"]);
    expect(seen).toEqual([{ url: COMPANY_TICKERS_URL, ifNoneMatch: null, ifModifiedSince: null }]);
    expect(await store.getFetchCache(COMPANY_TICKERS_URL)).toEqual({
      etag: ETAG,
      lastModified: LAST_MODIFIED,
    });
    await store.close();
  });

  it("does not fetch at all while the cache is fresh", async () => {
    const store = await makeStore();
    const { fetchImpl, seen } = mockSecFetch();
    const client = makeClient(fetchImpl);

    await refreshCikTickersIfStale(store, client, silentLogger);
    const again = await refreshCikTickersIfStale(store, client, silentLogger);
    expect(again).toEqual({ refreshed: false, entries: 2 });
    expect(seen).toHaveLength(1);
    await store.close();
  });

  it("on 304 keeps the map, bumps freshness, and reports not refreshed", async () => {
    const store = await makeStore();
    const { fetchImpl, seen } = mockSecFetch();
    const client = makeClient(fetchImpl);

    await refreshCikTickersIfStale(store, client, silentLogger);
    await markStale(store);

    const result = await refreshCikTickersIfStale(store, client, silentLogger);
    expect(result).toEqual({ refreshed: false, entries: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({
      url: COMPANY_TICKERS_URL,
      ifNoneMatch: ETAG,
      ifModifiedSince: LAST_MODIFIED,
    });
    // Map untouched, freshness bumped past the synthetic stale date.
    expect(await store.tickersForCik("0000123456")).toEqual(["EXCO", "EXCO.B"]);
    const refreshedAt = await store.cikTickersRefreshedAt();
    expect(refreshedAt && refreshedAt > "2020-01-01T00:00:00.000Z").toBe(true);

    // The bump satisfies the next staleness check without another request.
    await refreshCikTickersIfStale(store, client, silentLogger);
    expect(seen).toHaveLength(2);
    await store.close();
  });

  it("on 200 after staleness replaces the map and the stored validators", async () => {
    const store = await makeStore();
    const first = mockSecFetch();
    await refreshCikTickersIfStale(store, makeClient(first.fetchImpl), silentLogger);
    await markStale(store);

    // Upstream changed: new body, new ETag — the old validator no longer matches.
    const seen: SeenRequest[] = [];
    const changedFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        url: String(url),
        ifNoneMatch: headers["if-none-match"] ?? null,
        ifModifiedSince: headers["if-modified-since"] ?? null,
      });
      return new Response(
        JSON.stringify({ "0": { cik_str: 555001, ticker: "smpl", title: "SAMPLE BIOTECH CO" } }),
        { status: 200, headers: { etag: '"v2"', "last-modified": LAST_MODIFIED } },
      );
    }) as typeof fetch;

    const result = await refreshCikTickersIfStale(store, makeClient(changedFetch), silentLogger);
    expect(result).toEqual({ refreshed: true, entries: 1 });
    expect(seen[0]?.ifNoneMatch).toBe(ETAG);
    expect(await store.tickersForCik("0000123456")).toEqual([]);
    expect(await store.tickersForCik("0000555001")).toEqual(["SMPL"]);
    expect(await store.getFetchCache(COMPANY_TICKERS_URL)).toEqual({
      etag: '"v2"',
      lastModified: LAST_MODIFIED,
    });
    await store.close();
  });
});
