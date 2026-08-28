import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShortVolumeFile } from "./parser.js";
import { fixturePath, readFixture, readFixtureJson } from "../../test-helpers.js";

interface FixtureMeta {
  parseInput: { market: string; sourceUrl: string; retrievedAt: string };
  expectedStats: { attempted: number; succeeded: number };
}

const CASES = readdirSync(fixturePath("finra-shortvol")).filter((d) => d.startsWith("case-"));

describe("parseShortVolumeFile (goldens)", () => {
  for (const caseName of CASES) {
    it(caseName, () => {
      const meta = readFixtureJson<FixtureMeta>("finra-shortvol", caseName, "meta.json");
      const result = parseShortVolumeFile({
        text: readFixture("finra-shortvol", caseName, "input.txt"),
        ...meta.parseInput,
      });
      expect(result.stats).toEqual(meta.expectedStats);
      expect(result.headerLine).toMatch(/^Date\|Symbol/);
      for (const row of result.rows) {
        expect(row.provenance.sourceUrl).toBe(meta.parseInput.sourceUrl);
      }
    });
  }

  it("normalizes both eras to the same shape", () => {
    const integerEra = parseShortVolumeFile({
      text: readFixture("finra-shortvol", "case-integer-era", "input.txt"),
      market: "CNMS",
      sourceUrl: "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20220601.txt",
      retrievedAt: "2026-08-24T00:00:00.000Z",
    });
    const decimalEra = parseShortVolumeFile({
      text: readFixture("finra-shortvol", "case-decimal-era", "input.txt"),
      market: "CNMS",
      sourceUrl: "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260302.txt",
      retrievedAt: "2026-08-24T00:00:00.000Z",
    });
    const oldAapl = integerEra.rows.find((r) => r.ticker === "AAPL");
    const newAapl = decimalEra.rows.find((r) => r.ticker === "AAPL");
    expect(oldAapl?.shortVolume).toBe(7_523_848);
    expect(newAapl?.shortVolume).toBe(7_523_848);
    expect(oldAapl?.shortRatio).toBeCloseTo(0.571659, 5);
    expect(newAapl?.shortRatio).toEqual(oldAapl?.shortRatio);
    // Decimal era carries real fractions.
    expect(decimalEra.rows.find((r) => r.ticker === "GME")?.shortVolume).toBe(1_000_000.5);
  });

  it("stores null shortRatio when total volume is zero — never invents a number", () => {
    const result = parseShortVolumeFile({
      text: readFixture("finra-shortvol", "case-integer-era", "input.txt"),
      market: "CNMS",
      sourceUrl: "https://cdn.finra.org/x",
      retrievedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(result.rows.find((r) => r.ticker === "ZVZZT")?.shortRatio).toBeNull();
  });
});
