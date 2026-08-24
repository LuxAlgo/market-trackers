import { describe, expect, it } from "vitest";
import { namesMatch, normalizeEntityName } from "./normalize.js";

describe("normalizeEntityName", () => {
  it.each([
    ["Apple Inc.", "APPLE"],
    ["APPLE INC /CA/", "APPLE"],
    ["Lockheed Martin Corporation", "LOCKHEED MARTIN"],
    ["Alphabet Inc. - Class A", "ALPHABET"],
    ["Berkshire Hathaway Inc CL B", "BERKSHIRE HATHAWAY"],
    ["Example Capital Management LP", "EXAMPLE CAPITAL MANAGEMENT"],
    ["Smith & Wesson Brands, Inc.", "SMITH AND WESSON BRANDS"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeEntityName(input)).toBe(expected);
  });

  it("keeps identity-bearing words like GROUP and HOLDINGS", () => {
    expect(normalizeEntityName("Example Holdings Inc")).toBe("EXAMPLE HOLDINGS");
    expect(normalizeEntityName("Sample Group PLC")).toBe("SAMPLE GROUP");
  });

  it("never strips a name down to nothing", () => {
    expect(normalizeEntityName("Inc")).toBe("INC");
    expect(normalizeEntityName("Co Inc")).toBe("CO");
  });

  it("matches across formatting differences", () => {
    expect(namesMatch("EXAMPLECORP INC", "ExampleCorp, Inc.")).toBe(true);
    expect(namesMatch("EXAMPLECORP INC", "OTHERCORP INC")).toBe(false);
  });
});
