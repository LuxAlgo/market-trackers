import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseThirteenf, ThirteenfParseError } from "./thirteenf.js";
import { fixturePath, readFixture, readFixtureJson } from "../../test-helpers.js";

interface FixtureMeta {
  parseInput: {
    accessionNumber: string;
    filedAt: string;
    sourceUrl: string;
    retrievedAt: string;
  };
}

const CASES = readdirSync(fixturePath("edgar-thirteenf")).filter((d) => d.startsWith("case-"));

describe("parseThirteenf (goldens)", () => {
  for (const caseName of CASES) {
    it(caseName, () => {
      const meta = readFixtureJson<FixtureMeta>("edgar-thirteenf", caseName, "meta.json");
      const expected = readFixtureJson<unknown>("edgar-thirteenf", caseName, "expected.json");
      const result = parseThirteenf({
        text: readFixture("edgar-thirteenf", caseName, "input.txt"),
        ...meta.parseInput,
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });
  }

  it("normalizes pre-2023 values from thousands to whole dollars", () => {
    const input = readFixture("edgar-thirteenf", "case-13f-2026", "input.txt")
      .replace("CONFORMED PERIOD OF REPORT:	20260630", "CONFORMED PERIOD OF REPORT:	20221231")
      .replace("FILED AS OF DATE:		20260814", "FILED AS OF DATE:		20230214");
    const result = parseThirteenf({
      text: input,
      accessionNumber: "0009876543-23-000001",
      filedAt: "2023-02-14",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/9876543/0009876543-23-000001-index.htm",
      retrievedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(result.periodEnd).toBe("2022-12-31");
    // 104,650,000 (reported in thousands) → 104.65B in whole dollars.
    expect(result.rows[0]?.valueUsd).toBe(104_650_000_000);
  });

  it("throws a typed error when no information table exists", () => {
    expect(() =>
      parseThirteenf({
        text: "ACCESSION NUMBER: x\nCONFORMED PERIOD OF REPORT: 20260630\nFILED AS OF DATE: 20260814\nCOMPANY CONFORMED NAME: X\nCENTRAL INDEX KEY: 0000000001\n",
        accessionNumber: "0000000001-26-000000",
        filedAt: "2026-08-14",
        sourceUrl: "https://www.sec.gov/none",
        retrievedAt: "2026-08-24T00:00:00.000Z",
      }),
    ).toThrow(ThirteenfParseError);
  });
});
