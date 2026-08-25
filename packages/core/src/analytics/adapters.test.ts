import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { DATASETS } from "../schema/datasets.js";
import { DocketStore } from "../store/store.js";
import { makeCongressTrade, makeInsiderTransaction } from "../test-helpers.js";
import { congressTradeEvents, insiderTradeEvents } from "./adapters.js";

let store: DocketStore;

beforeAll(async () => {
  store = await DocketStore.open(":memory:");

  await store.upsert(DATASETS["congress-trades"], [
    makeCongressTrade({
      id: "senate:doc-1:0",
      ticker: "ACME",
      filedAt: "2026-08-20",
      transactedAt: "2026-08-01",
    }),
    makeCongressTrade({
      id: "senate:doc-1:1",
      rowIndex: 1,
      ticker: null,
      assetDescription: "Unresolvable Corp — private placement",
      filedAt: "2026-08-20",
      transactedAt: "2026-08-02",
    }),
  ]);

  await store.upsert(DATASETS["insider-transactions"], [
    makeInsiderTransaction({ id: "acc1:nd:0", ticker: "ACME", filedAt: "2026-08-21" }),
    makeInsiderTransaction({ id: "acc1:nd:1", ticker: null, filedAt: "2026-08-21" }),
  ]);
});

afterAll(async () => {
  await store.close();
});

describe("congressTradeEvents", () => {
  it("builds one event per ticketed trade, using filedAt (not transactedAt) as eventDate", async () => {
    const events = await congressTradeEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticker: "ACME",
      eventDate: "2026-08-20",
      citation: "https://example.gov/primary/document/1",
    });
  });

  it("excludes trades with no resolved ticker rather than guessing one", async () => {
    const events = await congressTradeEvents(store);
    expect(events.some((e) => e.label.includes("Unresolvable"))).toBe(false);
  });

  it("forwards filters to the query layer", async () => {
    expect(await congressTradeEvents(store, { ticker: "nope" })).toHaveLength(0);
    expect(await congressTradeEvents(store, { ticker: "acme" })).toHaveLength(1);
  });
});

describe("insiderTradeEvents", () => {
  it("builds one event per ticketed transaction, using filedAt as eventDate", async () => {
    const events = await insiderTradeEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticker: "ACME", eventDate: "2026-08-21" });
  });

  it("forwards filters to the query layer", async () => {
    expect(await insiderTradeEvents(store, { ticker: "nope" })).toHaveLength(0);
  });
});
