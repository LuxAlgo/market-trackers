import { describe, expect, it } from "vitest";
import { parsePriceCsv } from "./prices.js";
import { ANALYTICS_DISCLAIMER, eventPriceChange, type AnalyticsEvent } from "./event-returns.js";

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    ticker: "ACME",
    eventDate: "2026-08-18",
    label: "test event",
    citation: "https://example.gov/doc/1",
    ...overrides,
  };
}

describe("eventPriceChange", () => {
  const prices = parsePriceCsv(
    [
      "date,ticker,close",
      "2026-08-18,ACME,40.00",
      "2026-09-17,ACME,44.00", // +30 days, +10%
      "2026-08-18,OTHR,100.00",
      // no OTHR price 30 days later at all
    ].join("\n"),
  );

  it("computes changePct for a fully priced event and always includes the disclaimer", () => {
    const result = eventPriceChange([event()], prices, { windowDays: 30 });
    expect(result.disclaimer).toBe(ANALYTICS_DISCLAIMER);
    expect(result.windowDays).toBe(30);
    expect(result.rows).toHaveLength(1);

    const row = result.rows[0];
    if (row?.status !== "ok") throw new Error("expected an ok row");
    expect(row.base).toEqual({ date: "2026-08-18", close: 40 });
    expect(row.later).toEqual({ date: "2026-09-17", close: 44 });
    expect(row.changePct).toBeCloseTo(0.1, 10);
    expect(result.aggregate).toEqual({
      eventsTotal: 1,
      eventsOk: 1,
      eventsSkipped: 0,
      meanChangePct: row.changePct,
      medianChangePct: row.changePct,
    });
  });

  it("reports a missing later price as skipped with a reason, never dropping the row", () => {
    const result = eventPriceChange([event({ ticker: "OTHR" })], prices, { windowDays: 30 });
    expect(result.rows).toHaveLength(1);

    const row = result.rows[0];
    if (row?.status !== "skipped") throw new Error("expected a skipped row");
    expect(row.reason).toContain("later price unavailable");
    expect(result.aggregate).toEqual({
      eventsTotal: 1,
      eventsOk: 0,
      eventsSkipped: 1,
      meanChangePct: null,
      medianChangePct: null,
    });
  });

  it("reports a missing base price as skipped when the ticker has no prices at all", () => {
    const result = eventPriceChange([event({ ticker: "NOPE" })], prices, { windowDays: 30 });
    const row = result.rows[0];
    if (row?.status !== "skipped") throw new Error("expected a skipped row");
    expect(row.reason).toContain("base price unavailable");
  });

  it("never drops an event — one row of output per event, ok or skipped", () => {
    const events = [
      event({ ticker: "ACME" }),
      event({ ticker: "OTHR" }),
      event({ ticker: "NOPE" }),
    ];
    const result = eventPriceChange(events, prices, { windowDays: 30 });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.status)).toEqual(["ok", "skipped", "skipped"]);
  });

  it("computes descriptive mean/median across a mix of ok and skipped events, deterministically", () => {
    const threePointPrices = parsePriceCsv(
      [
        "date,ticker,close",
        "2026-08-18,A,10",
        "2026-09-17,A,11", // +10%
        "2026-08-18,B,10",
        "2026-09-17,B,12", // +20%
        "2026-08-18,C,10",
        "2026-09-17,C,13", // +30%
      ].join("\n"),
    );
    const events = [
      event({ ticker: "C", label: "c" }),
      event({ ticker: "A", label: "a" }),
      event({ ticker: "NOPE", label: "skip-me" }),
      event({ ticker: "B", label: "b" }),
    ];
    const result = eventPriceChange(events, threePointPrices, { windowDays: 30 });
    expect(result.aggregate.eventsOk).toBe(3);
    expect(result.aggregate.eventsSkipped).toBe(1);
    expect(result.aggregate.meanChangePct).toBeCloseTo(0.2, 10);
    expect(result.aggregate.medianChangePct).toBeCloseTo(0.2, 10);

    // determinism: identical inputs (even reordered) produce identical aggregates.
    const reordered = eventPriceChange([...events].reverse(), threePointPrices, {
      windowDays: 30,
    });
    expect(reordered.aggregate).toEqual(result.aggregate);
    const again = eventPriceChange(events, threePointPrices, { windowDays: 30 });
    expect(again).toEqual(result);
  });

  it("uses searchForwardDays to bridge a gap when the exact later date has no row", () => {
    const gapPrices = parsePriceCsv(
      ["date,ticker,close", "2026-08-14,GAP,50", "2026-08-18,GAP,55"].join("\n"),
    );
    // later requested date = 2026-08-14 + 3 = 2026-08-17, which has no row;
    // forward search within 3 more days reaches the 2026-08-18 row.
    const result = eventPriceChange(
      [event({ ticker: "GAP", eventDate: "2026-08-14" })],
      gapPrices,
      { windowDays: 3, searchForwardDays: 3 },
    );
    const row = result.rows[0];
    if (row?.status !== "ok") throw new Error("expected an ok row");
    expect(row.base).toEqual({ date: "2026-08-14", close: 50 });
    expect(row.later).toEqual({ date: "2026-08-18", close: 55 });
  });

  it("defaults to a 7-day forward search when none is specified", () => {
    const gapPrices = parsePriceCsv(
      ["date,ticker,close", "2026-08-14,GAP,50", "2026-08-24,GAP,60"].join("\n"),
    );
    // later requested date = 2026-08-14 + 3 = 2026-08-17; the nearest available
    // row is 2026-08-24 — exactly 7 days later, the default search window.
    const result = eventPriceChange(
      [event({ ticker: "GAP", eventDate: "2026-08-14" })],
      gapPrices,
      { windowDays: 3 },
    );
    expect(result.rows[0]?.status).toBe("ok");
  });
});
