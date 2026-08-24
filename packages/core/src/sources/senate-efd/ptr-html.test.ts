import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EfdParseError, mapAssetType, mapOwner, parsePtrHtml } from "./ptr-html.js";
import { fixturePath, readFixture, readFixtureJson } from "../../test-helpers.js";

interface FixtureMeta {
  parseInput: {
    docId: string;
    memberName: string;
    filedAt: string;
    sourceUrl: string;
    retrievedAt: string;
  };
}

const CASES = readdirSync(fixturePath("senate-efd")).filter((d) => d.startsWith("case-"));

describe("parsePtrHtml (goldens)", () => {
  it("has golden cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3);
  });

  for (const caseName of CASES) {
    it(caseName, () => {
      const meta = readFixtureJson<FixtureMeta>("senate-efd", caseName, "meta.json");
      const expected = readFixtureJson<unknown>("senate-efd", caseName, "expected.json");
      const result = parsePtrHtml({
        html: readFixture("senate-efd", caseName, "input.html"),
        ...meta.parseInput,
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });
  }

  it("throws a typed error on pages without a transactions table", () => {
    expect(() =>
      parsePtrHtml({
        html: "<html><body><p>Annual Report</p><table><thead><tr><th>Part</th></tr></thead></table></body></html>",
        docId: "00000000-0000-4000-8000-000000000000",
        memberName: "Nobody Nowhere",
        filedAt: "2026-08-14",
        sourceUrl:
          "https://efdsearch.senate.gov/search/view/ptr/00000000-0000-4000-8000-000000000000/",
        retrievedAt: "2026-08-24T00:00:00.000Z",
      }),
    ).toThrow(EfdParseError);
  });

  it("throws a typed error on unrecognized transaction types", () => {
    const html = readFixture("senate-efd", "case-ptr-clean-multirow", "input.html").replace(
      ">Purchase<",
      ">Gifted<",
    );
    expect(() =>
      parsePtrHtml({
        html,
        docId: "3f9b1c2e-8a4d-4e5f-9b6a-7c8d9e0f1a2b",
        memberName: "Sheldon Whitehouse",
        filedAt: "2026-08-12",
        sourceUrl:
          "https://efdsearch.senate.gov/search/view/ptr/3f9b1c2e-8a4d-4e5f-9b6a-7c8d9e0f1a2b/",
        retrievedAt: "2026-08-24T00:00:00.000Z",
      }),
    ).toThrow(EfdParseError);
  });
});

describe("owner and asset-type heuristics", () => {
  it("maps owners and leaves the rest null", () => {
    expect(mapOwner("Self")).toBe("self");
    expect(mapOwner("Spouse")).toBe("spouse");
    expect(mapOwner("Joint")).toBe("joint");
    expect(mapOwner("Child")).toBe("dependent");
    expect(mapOwner("Dependent Child")).toBe("dependent");
    expect(mapOwner("--")).toBeNull();
    expect(mapOwner("")).toBeNull();
    expect(mapOwner("Trustee")).toBeNull();
  });

  it("maps asset types with option winning over stock", () => {
    expect(mapAssetType("Stock")).toBe("stock");
    expect(mapAssetType("Non-Public Stock")).toBe("stock");
    expect(mapAssetType("Stock Option")).toBe("option");
    expect(mapAssetType("Corporate Bond")).toBe("bond");
    expect(mapAssetType("Municipal Security")).toBe("bond");
    expect(mapAssetType("U.S. Treasury Security")).toBe("bond");
    expect(mapAssetType("Cryptocurrency")).toBe("crypto");
    expect(mapAssetType("Mutual Fund")).toBe("fund");
    expect(mapAssetType("Exchange Traded Fund (ETF)")).toBe("fund");
    expect(mapAssetType("Other Securities")).toBe("other");
  });
});
