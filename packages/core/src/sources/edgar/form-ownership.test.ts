import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOwnershipForm, OwnershipParseError } from "./form-ownership.js";
import { fixturePath, readFixture, readFixtureJson } from "../../test-helpers.js";

interface FixtureMeta {
  parseInput: {
    accessionNumber: string;
    filedAt: string;
    sourceUrl: string;
    retrievedAt: string;
  };
}

const CASES = readdirSync(fixturePath("edgar-form-ownership")).filter((d) => d.startsWith("case-"));

describe("parseOwnershipForm (goldens)", () => {
  it("has golden cases", () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  for (const caseName of CASES) {
    it(caseName, () => {
      const meta = readFixtureJson<FixtureMeta>("edgar-form-ownership", caseName, "meta.json");
      const expected = readFixtureJson<unknown>("edgar-form-ownership", caseName, "expected.json");
      const result = parseOwnershipForm({
        text: readFixture("edgar-form-ownership", caseName, "input.txt"),
        ...meta.parseInput,
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });
  }

  it("throws a typed error on submissions with no ownership XML", () => {
    expect(() =>
      parseOwnershipForm({
        text: "<SEC-DOCUMENT>nothing here</SEC-DOCUMENT>",
        accessionNumber: "0000000000-26-000000",
        filedAt: "2026-08-20",
        sourceUrl: "https://www.sec.gov/Archives/edgar/data/0/none-index.htm",
        retrievedAt: "2026-08-24T00:00:00.000Z",
      }),
    ).toThrow(OwnershipParseError);
  });

  it("flags every row for review when a filing lists multiple reporting owners", () => {
    const meta = readFixtureJson<FixtureMeta>(
      "edgar-form-ownership",
      "case-form4-multi-owner",
      "meta.json",
    );
    const result = parseOwnershipForm({
      text: readFixture("edgar-form-ownership", "case-form4-multi-owner", "input.txt"),
      ...meta.parseInput,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    // First-owner attribution is honest but lossy — every row must say so.
    expect(result.rows.every((row) => row.provenance.needsReview)).toBe(true);
    expect(result.rows[0]?.insider.name).toBe("Example Ventures GP LLC");
  });

  it("parses an ownership document with empty tables as zero rows, not an error", () => {
    const meta = readFixtureJson<FixtureMeta>(
      "edgar-form-ownership",
      "case-form3-no-securities",
      "meta.json",
    );
    const result = parseOwnershipForm({
      text: readFixture("edgar-form-ownership", "case-form3-no-securities", "input.txt"),
      ...meta.parseInput,
    });
    expect(result.rows).toEqual([]);
    expect(result.issuerCik).toBe("0000123456");
  });
});
