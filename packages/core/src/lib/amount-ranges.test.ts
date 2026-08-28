import { describe, expect, it } from "vitest";
import { parseAmountRange } from "./amount-ranges.js";

describe("parseAmountRange", () => {
  it.each([
    ["$1,001 - $15,000", { min: 1_001, max: 15_000 }],
    ["$15,001 - $50,000", { min: 15_001, max: 50_000 }],
    ["$50,001 - $100,000", { min: 50_001, max: 100_000 }],
    ["$250,001 - $500,000", { min: 250_001, max: 500_000 }],
    ["$1,000,001 - $5,000,000", { min: 1_000_001, max: 5_000_000 }],
    ["$25,000,001 - $50,000,000", { min: 25_000_001, max: 50_000_000 }],
    ["Over $50,000,000", { min: 50_000_000, max: null }],
    ["$50,000,000 +", { min: 50_000_000, max: null }],
    ["$1,000,000+", { min: 1_000_000, max: null }],
    ["None (or less than $1,001)", { min: 0, max: 1_000 }],
    // en-dash variant seen on rendered pages
    ["$1,001 – $15,000", { min: 1_001, max: 15_000 }],
  ])("parses %s", (text, expected) => {
    expect(parseAmountRange(text)).toEqual(expected);
  });

  it("returns null on unrecognizable text — never guesses", () => {
    expect(parseAmountRange("")).toBeNull();
    expect(parseAmountRange("call for details")).toBeNull();
    expect(parseAmountRange("$15,000 - $1,001")).toBeNull(); // inverted bounds
    expect(parseAmountRange("about $10,000")).toBeNull();
  });
});
