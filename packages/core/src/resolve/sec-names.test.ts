import { describe, expect, it } from "vitest";
import { AltDataStore, type CikTickerEntry } from "../store/store.js";
import {
  buildSecNameIndex,
  resolveEntityTickersSec,
  resolveEntityTickersTiered,
} from "./sec-names.js";

/**
 * Offline coverage of the SEC-name fallback tier: exact-normalized-name
 * matching only against hand-seeded `cik_tickers` rows, ambiguity exclusion,
 * share-class grouping, and the tiered resolver's curated-map-first order.
 * None of this touches the real curated map's own prefix matching — that
 * stays covered by `recipients.test.ts`.
 */

async function makeStore(entries: CikTickerEntry[] = []): Promise<AltDataStore> {
  const store = await AltDataStore.open(":memory:");
  if (entries.length > 0) await store.replaceCikTickers(entries);
  return store;
}

describe("buildSecNameIndex", () => {
  it("groups tickers by normalized name, keeping every share class for one issuer", async () => {
    const store = await makeStore([
      { cik: "0001652044", ticker: "GOOGL", name: "Alphabet Inc." },
      { cik: "0001652044", ticker: "GOOG", name: "Alphabet Inc." },
    ]);
    const index = await buildSecNameIndex(store);
    expect(index.byName.get("ALPHABET")).toEqual(["GOOG", "GOOGL"]);
    await store.close();
  });

  it("treats punctuation/suffix variants of the same issuer as one normalized key", async () => {
    const store = await makeStore([{ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." }]);
    const index = await buildSecNameIndex(store);
    expect(index.byName.get("APPLE")).toEqual(["AAPL"]);
    // Same key from a differently-punctuated title on the *same* CIK stays unambiguous.
    await store.replaceCikTickers([{ cik: "0000320193", ticker: "AAPL", name: "APPLE, INC." }]);
    const rebuilt = await buildSecNameIndex(store);
    expect(rebuilt.byName.get("APPLE")).toEqual(["AAPL"]);
    await store.close();
  });

  it("excludes a normalized name shared by two distinct CIKs (ambiguity)", async () => {
    const store = await makeStore([
      { cik: "0000000001", ticker: "GWA", name: "Generic Widgets, Inc." },
      { cik: "0000000002", ticker: "GWB", name: "GENERIC WIDGETS INCORPORATED" },
    ]);
    const index = await buildSecNameIndex(store);
    expect(index.byName.has("GENERIC WIDGETS")).toBe(false);
    await store.close();
  });

  it("caches the index per store instance and rebuilds once cik_tickers is replaced", async () => {
    const store = await makeStore([{ cik: "0000000001", ticker: "OLD", name: "OLD ISSUER INC" }]);
    const first = await buildSecNameIndex(store);
    expect(first.byName.get("OLD ISSUER")).toEqual(["OLD"]);

    // Invalidation rides the `refreshed_at` stamp, which is millisecond
    // precision — a small real delay is what separates two refreshes in
    // practice (refreshCikTickersIfStale always has network I/O between
    // them) and is what this test needs to observe a changed stamp too.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.replaceCikTickers([{ cik: "0000000002", ticker: "NEW", name: "NEW ISSUER INC" }]);
    const second = await buildSecNameIndex(store);
    expect(second.byName.get("NEW ISSUER")).toEqual(["NEW"]);
    expect(second.byName.has("OLD ISSUER")).toBe(false);
    await store.close();
  });
});

describe("resolveEntityTickersSec", () => {
  it("matches an exact normalized name regardless of punctuation/suffix", async () => {
    const store = await makeStore([{ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." }]);
    expect(await resolveEntityTickersSec(store, { name: "APPLE INC" })).toEqual(["AAPL"]);
    expect(await resolveEntityTickersSec(store, { name: "Apple, Inc." })).toEqual(["AAPL"]);
    await store.close();
  });

  it("never prefix-matches a subsidiary or lookalike name (exact match only)", async () => {
    const store = await makeStore([{ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." }]);
    expect(
      await resolveEntityTickersSec(store, { name: "APPLE OPERATIONS INTERNATIONAL" }),
    ).toEqual([]);
    expect(await resolveEntityTickersSec(store, { name: "APPLE VALLEY SCHOOL DISTRICT" })).toEqual(
      [],
    );
    await store.close();
  });

  it("returns [] for an ambiguous name", async () => {
    const store = await makeStore([
      { cik: "0000000001", ticker: "GWA", name: "Generic Widgets, Inc." },
      { cik: "0000000002", ticker: "GWB", name: "GENERIC WIDGETS INCORPORATED" },
    ]);
    expect(await resolveEntityTickersSec(store, { name: "Generic Widgets, Inc." })).toEqual([]);
    await store.close();
  });

  it("returns [] for an unknown, empty, whitespace, or null name", async () => {
    const store = await makeStore([{ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." }]);
    expect(await resolveEntityTickersSec(store, { name: "Nobody Ever Filed This LLC" })).toEqual(
      [],
    );
    expect(await resolveEntityTickersSec(store, { name: "   " })).toEqual([]);
    expect(await resolveEntityTickersSec(store, { name: null })).toEqual([]);
    expect(await resolveEntityTickersSec(store, {})).toEqual([]);
    await store.close();
  });
});

describe("resolveEntityTickersTiered", () => {
  it("prefers the curated map's exact hit over a same-named SEC entry", async () => {
    const store = await makeStore([
      // A different ticker under the same normalized name, seeded purely in
      // the SEC tier. If the curated map's exact "LOCKHEED MARTIN" entry
      // didn't win outright, this would surface as LMTFAKE instead of LMT.
      { cik: "0000000099", ticker: "LMTFAKE", name: "LOCKHEED MARTIN CORP" },
    ]);
    expect(
      await resolveEntityTickersTiered(store, { name: "Lockheed Martin Corporation" }),
    ).toEqual(["LMT"]);
    await store.close();
  });

  it("falls back to the SEC index when the curated map misses", async () => {
    const store = await makeStore([
      { cik: "0000000123", ticker: "EXCO", name: "Examplecorp Holdings, Inc." },
    ]);
    expect(await resolveEntityTickersTiered(store, { name: "EXAMPLECORP HOLDINGS" })).toEqual([
      "EXCO",
    ]);
    await store.close();
  });

  it("still returns [] when neither tier matches (absence of a ticker is stored, not guessed)", async () => {
    const store = await makeStore([
      { cik: "0000000123", ticker: "EXCO", name: "Examplecorp Holdings, Inc." },
    ]);
    expect(
      await resolveEntityTickersTiered(store, { name: "Totally Unmapped Nonprofit Inc" }),
    ).toEqual([]);
    await store.close();
  });

  it("is null/whitespace/empty-safe, including a UEI with no matching entry anywhere", async () => {
    const store = await makeStore();
    expect(await resolveEntityTickersTiered(store, { name: null, uei: null })).toEqual([]);
    expect(await resolveEntityTickersTiered(store, { name: "   ", uei: "UEIUNKNOWN001" })).toEqual(
      [],
    );
    expect(await resolveEntityTickersTiered(store, {})).toEqual([]);
    await store.close();
  });
});
