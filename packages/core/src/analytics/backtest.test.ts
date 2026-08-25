import { describe, expect, it } from "vitest";
import { parsePriceCsv } from "./prices.js";
import type { AnalyticsEvent } from "./event-returns.js";
import { ANALYTICS_DISCLAIMER } from "./event-returns.js";
import {
  runBacktest,
  BACKTEST_DATA_NOTES,
  BACKTEST_ENTRY_RULE,
  type BacktestEventRowPriced,
} from "./backtest.js";

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    ticker: "ACME",
    eventDate: "2026-08-18",
    label: "test event",
    citation: "https://example.gov/doc/1",
    ...overrides,
  };
}

describe("runBacktest", () => {
  const prices = parsePriceCsv(
    [
      "date,ticker,close",
      "2026-08-18,ACME,40.00",
      "2026-09-17,ACME,44.00", // +30 days, +10%
      "2026-08-18,OTHR,100.00",
      // no OTHR price 30 days later at all
    ].join("\n"),
  );

  it("prices a fully-priced event and always carries the disclaimer and data notes", () => {
    const result = runBacktest({ events: [event()], prices, windowDays: 30 });
    expect(result.disclaimer).toBe(ANALYTICS_DISCLAIMER);
    expect(result.dataNotes).toBe(BACKTEST_DATA_NOTES);
    expect(result.dataNotes.length).toBeGreaterThan(0);
    expect(result.windowDays).toBe(30);
    expect(result.entry).toBe(BACKTEST_ENTRY_RULE);
    expect(result.rows).toHaveLength(1);

    const row = result.rows[0];
    if (row?.status !== "priced") throw new Error("expected a priced row");
    expect(row.entry).toEqual({ date: "2026-08-18", close: 40, forwardFilled: false });
    expect(row.exit).toEqual({ date: "2026-09-17", close: 44, forwardFilled: false });
    expect(row.changePct).toBeCloseTo(0.1, 10);
    expect(result.aggregate).toEqual({
      events: 1,
      priced: 1,
      skipped: 0,
      meanChangePct: row.changePct,
      medianChangePct: row.changePct,
      winRate: 1,
      bestChangePct: row.changePct,
      worstChangePct: row.changePct,
    });
  });

  it("never drops an event — every event is priced or skipped-with-reason", () => {
    const events = [
      event({ ticker: "ACME" }),
      event({ ticker: "OTHR" }),
      event({ ticker: "NOPE" }),
    ];
    const result = runBacktest({ events, prices, windowDays: 30 });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.status)).toEqual(["priced", "skipped", "skipped"]);

    const otherRow = result.rows[1];
    if (otherRow?.status !== "skipped") throw new Error("expected a skipped row");
    expect(otherRow.reason).toContain("exit price unavailable");

    const nopeRow = result.rows[2];
    if (nopeRow?.status !== "skipped") throw new Error("expected a skipped row");
    expect(nopeRow.reason).toContain("entry price unavailable");
  });

  it("still returns the disclaimer and data notes when every event is skipped", () => {
    const result = runBacktest({ events: [event({ ticker: "NOPE" })], prices, windowDays: 30 });
    expect(result.rows[0]?.status).toBe("skipped");
    expect(result.aggregate.priced).toBe(0);
    expect(result.aggregate.meanChangePct).toBeNull();
    expect(result.aggregate.medianChangePct).toBeNull();
    expect(result.aggregate.winRate).toBeNull();
    expect(result.aggregate.bestChangePct).toBeNull();
    expect(result.aggregate.worstChangePct).toBeNull();
    expect(result.disclaimer).toBe(ANALYTICS_DISCLAIMER);
    expect(result.dataNotes.length).toBeGreaterThan(0);
  });

  it("flags a forward-filled entry or exit close per event, without hiding it", () => {
    const gapPrices = parsePriceCsv(
      ["date,ticker,close", "2026-08-14,GAP,50", "2026-08-18,GAP,55"].join("\n"),
    );
    // exit requested date = 2026-08-14 + 3 = 2026-08-17, which has no row;
    // forward search reaches the 2026-08-18 row instead.
    const result = runBacktest({
      events: [event({ ticker: "GAP", eventDate: "2026-08-14" })],
      prices: gapPrices,
      windowDays: 3,
      searchForwardDays: 3,
    });
    const row = result.rows[0];
    if (row?.status !== "priced") throw new Error("expected a priced row");
    expect(row.entry).toEqual({ date: "2026-08-14", close: 50, forwardFilled: false });
    expect(row.exit).toEqual({ date: "2026-08-18", close: 55, forwardFilled: true });
  });

  it("computes winRate/mean/median/best/worst on a hand-computable 3-event fixture", () => {
    // +10%, -5%, +20% => mean 0.25/3, median 0.10, winRate 2/3, best 0.20, worst -0.05.
    const threePointPrices = parsePriceCsv(
      [
        "date,ticker,close",
        "2026-08-18,A,10",
        "2026-09-17,A,11", // +10%
        "2026-08-18,B,10",
        "2026-09-17,B,9.5", // -5%
        "2026-08-18,C,10",
        "2026-09-17,C,12", // +20%
      ].join("\n"),
    );
    const events = [event({ ticker: "A" }), event({ ticker: "B" }), event({ ticker: "C" })];
    const result = runBacktest({ events, prices: threePointPrices, windowDays: 30 });

    expect(result.aggregate.priced).toBe(3);
    expect(result.aggregate.skipped).toBe(0);
    expect(result.aggregate.meanChangePct).toBeCloseTo(0.25 / 3, 10);
    expect(result.aggregate.medianChangePct).toBeCloseTo(0.1, 10);
    expect(result.aggregate.winRate).toBeCloseTo(2 / 3, 10);
    expect(result.aggregate.bestChangePct).toBeCloseTo(0.2, 10);
    expect(result.aggregate.worstChangePct).toBeCloseTo(-0.05, 10);

    // determinism: identical input (even reordered) produces identical aggregates.
    const again = runBacktest({ events, prices: threePointPrices, windowDays: 30 });
    expect(again).toEqual(result);
    const reordered = runBacktest({
      events: [...events].reverse(),
      prices: threePointPrices,
      windowDays: 30,
    });
    expect(reordered.aggregate).toEqual(result.aggregate);
  });

  it("winRate is null (not 0 or NaN) when nothing priced", () => {
    const result = runBacktest({ events: [event({ ticker: "NOPE" })], prices, windowDays: 30 });
    expect(result.aggregate.winRate).toBeNull();
  });

  it("treats a zero changePct as not a win", () => {
    const flatPrices = parsePriceCsv(
      ["date,ticker,close", "2026-08-18,FLAT,10", "2026-09-17,FLAT,10"].join("\n"),
    );
    const result = runBacktest({
      events: [event({ ticker: "FLAT" })],
      prices: flatPrices,
      windowDays: 30,
    });
    const row = result.rows[0] as BacktestEventRowPriced;
    expect(row.changePct).toBe(0);
    expect(result.aggregate.winRate).toBe(0);
  });

  it("defaults entry to 'filed-close' and accepts it explicitly, but rejects any other value", () => {
    const implicit = runBacktest({ events: [event()], prices, windowDays: 30 });
    expect(implicit.entry).toBe("filed-close");
    const explicit = runBacktest({
      events: [event()],
      prices,
      windowDays: 30,
      entry: "filed-close",
    });
    expect(explicit.entry).toBe("filed-close");

    expect(() =>
      runBacktest({
        events: [event()],
        prices,
        windowDays: 30,
        // @ts-expect-error — only "filed-close" is a valid entry rule.
        entry: "next-open",
      }),
    ).toThrow(/filed-close/);
  });

  it("defaults searchForwardDays to 7, same as eventPriceChange", () => {
    const gapPrices = parsePriceCsv(
      ["date,ticker,close", "2026-08-14,GAP,50", "2026-08-24,GAP,60"].join("\n"),
    );
    // exit requested date = 2026-08-14 + 3 = 2026-08-17; nearest available row
    // is 2026-08-24 — exactly 7 days later, the default search window.
    const result = runBacktest({
      events: [event({ ticker: "GAP", eventDate: "2026-08-14" })],
      prices: gapPrices,
      windowDays: 3,
    });
    expect(result.rows[0]?.status).toBe("priced");
  });

  it("never uses the disclosed amount range for sizing — events carry no amount at all", () => {
    // AnalyticsEvent has no amount/size field; this is a structural
    // guarantee, not a runtime check, but assert the row shape stays that way.
    const result = runBacktest({ events: [event()], prices, windowDays: 30 });
    const row = result.rows[0] as BacktestEventRowPriced;
    expect(Object.keys(row.event)).toEqual(["ticker", "eventDate", "label", "citation"]);
  });
});
