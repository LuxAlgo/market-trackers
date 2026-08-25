import { describe, expect, it } from "vitest";
import { DATASETS } from "../schema/datasets.js";
import { AltDataStore } from "../store/store.js";
import { makeThirteenfHolding } from "../test-helpers.js";
import { OPENFIGI_MAPPING_URL, OpenFigiClient, resolveCusips } from "./cusip.js";

/**
 * Fully offline coverage of the CUSIP→ticker enrichment loop: the OpenFIGI
 * client (mocked fetch), the store cache (hits, misses, retry-misses), and
 * the two store methods the `alt-data resolve cusips` command drives.
 */

/** Mocked OpenFIGI: resolves per `known`, records every batch it was sent. */
function mockOpenFigi(known: Record<string, string>): {
  fetchImpl: typeof fetch;
  batches: string[][];
} {
  const batches: string[][] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe(OPENFIGI_MAPPING_URL);
    const batch = (JSON.parse(String(init?.body)) as { idValue: string }[]).map((q) => q.idValue);
    batches.push(batch);
    const body = batch.map((cusip) =>
      known[cusip]
        ? { data: [{ figi: "BBG000TEST01", ticker: known[cusip], name: "TEST CORP" }] }
        : { error: "No identifier found." },
    );
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, batches };
}

describe("resolveCusips", () => {
  it("queries OpenFIGI for unseen CUSIPs, caches hits and misses, and never re-queries cached entries", async () => {
    const store = await AltDataStore.open(":memory:");
    const { fetchImpl, batches } = mockOpenFigi({ "30303M102": "EXCO" });
    const client = new OpenFigiClient({ fetchImpl });

    const first = await resolveCusips(store, client, ["30303M102", "99999X999"]);
    expect(first.get("30303M102")).toBe("EXCO");
    expect(first.get("99999X999")).toBeNull();
    expect(batches).toEqual([["30303M102", "99999X999"]]);
    expect((await store.getCusip("30303M102"))?.mapSource).toBe("openfigi");
    expect((await store.getCusip("99999X999"))?.mapSource).toBe("openfigi:miss");

    // Second pass: both are cached (the miss too) — no network at all.
    const second = await resolveCusips(store, client, ["30303M102", "99999X999"]);
    expect(second.get("30303M102")).toBe("EXCO");
    expect(second.get("99999X999")).toBeNull();
    expect(batches).toHaveLength(1);
    await store.close();
  });

  it("retryMisses re-queries cached misses but still trusts cached hits", async () => {
    const store = await AltDataStore.open(":memory:");
    const miss = mockOpenFigi({});
    await resolveCusips(store, new OpenFigiClient({ fetchImpl: miss.fetchImpl }), ["79589L106"]);
    expect((await store.getCusip("79589L106"))?.ticker).toBeNull();

    // The security is now mappable (e.g. a recent listing): retry the miss.
    const hit = mockOpenFigi({ "79589L106": "SMPL" });
    const client = new OpenFigiClient({ fetchImpl: hit.fetchImpl });
    const without = await resolveCusips(store, client, ["79589L106"]);
    expect(without.get("79589L106")).toBeNull();
    expect(hit.batches).toHaveLength(0);

    const withRetry = await resolveCusips(store, client, ["79589L106"], { retryMisses: true });
    expect(withRetry.get("79589L106")).toBe("SMPL");
    expect(hit.batches).toEqual([["79589L106"]]);
    expect((await store.getCusip("79589L106"))?.ticker).toBe("SMPL");
    await store.close();
  });

  it("splits large batches to the keyless OpenFIGI batch size", async () => {
    const store = await AltDataStore.open(":memory:");
    const { fetchImpl, batches } = mockOpenFigi({});
    const client = new OpenFigiClient({ fetchImpl });
    const cusips = Array.from({ length: 12 }, (_, i) => `TEST${String(i).padStart(5, "0")}`);
    await resolveCusips(store, client, cusips);
    expect(batches.map((b) => b.length)).toEqual([10, 2]);
    await store.close();
  });
});

describe("AltDataStore CUSIP-resolution methods", () => {
  function seedRows() {
    return [
      makeThirteenfHolding({ id: "acc-1:0", cusip: "30303M102", ticker: null }),
      makeThirteenfHolding({ id: "acc-1:1", cusip: "30303M102", ticker: null, putCall: "put" }),
      makeThirteenfHolding({ id: "acc-1:2", cusip: "79589L106", ticker: null }),
      makeThirteenfHolding({ id: "acc-1:3", cusip: "11111Y111", ticker: "HAVE" }),
    ];
  }

  it("distinctUnresolvedCusips returns each unresolved CUSIP once, ordered, honoring the limit", async () => {
    const store = await AltDataStore.open(":memory:");
    await store.upsert(DATASETS["thirteenf-holdings"], seedRows());

    expect(await store.distinctUnresolvedCusips()).toEqual(["30303M102", "79589L106"]);
    expect(await store.distinctUnresolvedCusips(1)).toEqual(["30303M102"]);
    await store.close();
  });

  it("applyCusipTickers updates only unresolved rows, skips null tickers, and reports the row count", async () => {
    const store = await AltDataStore.open(":memory:");
    await store.upsert(DATASETS["thirteenf-holdings"], seedRows());

    const { updated } = await store.applyCusipTickers(
      new Map<string, string | null>([
        ["30303M102", "EXCO"],
        ["79589L106", null], // cached miss — must not touch rows
        ["11111Y111", "CLOB"], // already resolved — must not overwrite
      ]),
    );
    expect(updated).toBe(2);

    const byId = new Map<string, string | null>();
    for await (const row of store.iterate(DATASETS["thirteenf-holdings"])) {
      byId.set(row.id, row.ticker);
    }
    expect(byId.get("acc-1:0")).toBe("EXCO");
    expect(byId.get("acc-1:1")).toBe("EXCO");
    expect(byId.get("acc-1:2")).toBeNull();
    expect(byId.get("acc-1:3")).toBe("HAVE");

    expect(await store.distinctUnresolvedCusips()).toEqual(["79589L106"]);
    expect(await store.applyCusipTickers(new Map())).toEqual({ updated: 0 });
    await store.close();
  });
});
