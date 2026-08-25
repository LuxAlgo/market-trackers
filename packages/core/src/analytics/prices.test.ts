import { describe, expect, it } from "vitest";
import { parsePriceCsv } from "./prices.js";

describe("parsePriceCsv", () => {
  it("parses well-formed rows and uppercases tickers", () => {
    const series = parsePriceCsv(
      "date,ticker,close\n2026-08-18,ACME,41.90\n2026-08-19,acme,42.50\n",
    );
    expect(series.warnings).toHaveLength(0);
    expect(series.size).toBe(2);
    expect(series.tickers()).toEqual(["ACME"]);
  });

  it("throws a friendly error naming the expected shape when the header is missing or wrong", () => {
    expect(() => parsePriceCsv("")).toThrow(/date,ticker,close/);
    expect(() => parsePriceCsv("nope,nope,nope\n1,2,3\n")).toThrow(/date,ticker,close/);
    expect(() => parsePriceCsv("date,ticker\n2026-08-18,ACME\n")).toThrow(/date,ticker,close/);
  });

  it("accepts a case-insensitive header and skips leading blank lines", () => {
    const series = parsePriceCsv("\n\nDate,Ticker,Close\n2026-08-18,ACME,10\n");
    expect(series.warnings).toHaveLength(0);
    expect(series.size).toBe(1);
  });

  it("collects malformed rows as warnings with 1-based line numbers, instead of guessing", () => {
    const csv = [
      "date,ticker,close", // line 1
      "2026-08-18,ACME,41.90", // line 2 — ok
      "2026-13-40,ACME,41.90", // line 3 — bad calendar date
      "not-a-date,ACME,41.90", // line 4 — bad date format
      "2026-08-19,,41.90", // line 5 — empty ticker
      "2026-08-20,ACME,-5", // line 6 — non-positive
      "2026-08-21,ACME,abc", // line 7 — non-numeric
      "2026-08-22,ACME", // line 8 — wrong field count
      "", // line 9 — blank, silently skipped (not a warning)
      "2026-08-23,ACME,43.10", // line 10 — ok
    ].join("\n");

    const series = parsePriceCsv(csv);
    expect(series.size).toBe(2);
    expect(series.warnings).toHaveLength(6);
    expect(series.warnings.map((w) => w.line)).toEqual([3, 4, 5, 6, 7, 8]);
    for (const w of series.warnings) {
      expect(w.reason.length).toBeGreaterThan(0);
      expect(w.raw.length).toBeGreaterThan(0);
    }
  });

  it("is case-insensitive when looking up a ticker", () => {
    const series = parsePriceCsv("date,ticker,close\n2026-08-18,acme,10\n");
    expect(series.closeOn("ACME", "2026-08-18").found).toBe(true);
    expect(series.closeOn("acme", "2026-08-18").found).toBe(true);
  });
});

describe("PriceSeries.closeOn", () => {
  const series = parsePriceCsv(
    ["date,ticker,close", "2026-08-17,ACME,40.00", "2026-08-21,ACME,44.00"].join("\n"),
  );

  it("finds an exact date without flagging it as forward-filled", () => {
    expect(series.closeOn("ACME", "2026-08-17")).toEqual({
      found: true,
      forwardFilled: false,
      point: { date: "2026-08-17", ticker: "ACME", close: 40 },
    });
  });

  it("misses when the exact date is absent and no forward search is requested", () => {
    expect(series.closeOn("ACME", "2026-08-18")).toEqual({
      found: false,
      reason: "no price for 'ACME' on 2026-08-18",
    });
  });

  it("forward-fills to the next available trading day within the window, and flags it", () => {
    expect(series.closeOn("ACME", "2026-08-18", { searchForwardDays: 5 })).toEqual({
      found: true,
      forwardFilled: true,
      point: { date: "2026-08-21", ticker: "ACME", close: 44 },
    });
  });

  it("still misses, with a reason naming the window, when the search doesn't reach far enough", () => {
    const miss = series.closeOn("ACME", "2026-08-18", { searchForwardDays: 2 });
    expect(miss).toEqual({
      found: false,
      reason: "no price for 'ACME' on 2026-08-18 or within 2 day(s) after",
    });
  });

  it("misses cleanly, and distinctly, for a ticker with no rows at all", () => {
    expect(series.closeOn("NOPE", "2026-08-17")).toEqual({
      found: false,
      reason: "no prices supplied for ticker 'NOPE'",
    });
  });
});
