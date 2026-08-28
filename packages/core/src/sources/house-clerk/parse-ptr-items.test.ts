import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyAssetType,
  extractTicker,
  groupIntoLines,
  parsePtrItems,
} from "./parse-ptr-items.js";
import type { PositionedTextItem } from "./pdf-text.js";
import type { CongressTrade } from "../../schema/congress-trade.js";
import { fixturePath, readFixtureJson } from "../../test-helpers.js";

interface FixtureMeta {
  parseInput: {
    docId: string;
    filedAt: string;
    member: CongressTrade["member"];
    sourceUrl: string;
    retrievedAt: string;
  };
}

const CASES = readdirSync(fixturePath("house-clerk")).filter((d) => d.startsWith("case-ptr-"));

describe("parsePtrItems (goldens)", () => {
  it("has at least the three mandated golden cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3);
  });

  for (const caseName of CASES) {
    it(caseName, () => {
      const meta = readFixtureJson<FixtureMeta>("house-clerk", caseName, "meta.json");
      const items = readFixtureJson<PositionedTextItem[]>("house-clerk", caseName, "input.json");
      const expected = readFixtureJson<unknown>("house-clerk", caseName, "expected.json");
      const result = parsePtrItems({ items, ...meta.parseInput });
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });
  }
});

describe("parsePtrItems (structure)", () => {
  it("returns a null header signature when no transactions table exists", () => {
    const result = parsePtrItems({
      items: [
        { text: "PERIODIC TRANSACTION REPORT", x: 210, y: 744, page: 1 },
        { text: "No transactions reported.", x: 46, y: 600, page: 1 },
      ],
      docId: "20030000",
      filedAt: "2026-08-18",
      member: { name: "Hon. Robert Kestrel", bioguideId: null, party: null, state: null },
      sourceUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030000.pdf",
      retrievedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(result.headerSignature).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.stats).toEqual({ attempted: 0, succeeded: 0 });
  });

  it("groups items into visual lines by page and y tolerance, x-ordered", () => {
    const lines = groupIntoLines([
      { text: "b", x: 200, y: 700.4, page: 1 },
      { text: "a", x: 100, y: 701, page: 1 },
      { text: "next line", x: 100, y: 688, page: 1 },
      { text: "page2", x: 100, y: 701, page: 2 },
    ]);
    expect(lines.map((l) => l.items.map((i) => i.text))).toEqual([
      ["a", "b"],
      ["next line"],
      ["page2"],
    ]);
    expect(lines.map((l) => l.page)).toEqual([1, 1, 2]);
  });
});

describe("extractTicker", () => {
  it("takes the last parenthesized upper-case symbol and requires a letter", () => {
    expect(extractTicker("Microsoft Corporation (MSFT) [ST]")).toBe("MSFT");
    expect(extractTicker("Berkshire Hathaway Class B (BRK.B) [ST]")).toBe("BRK.B");
    expect(extractTicker("iShares (BLK) Core S&P 500 ETF (IVV)")).toBe("IVV");
    expect(extractTicker("U.S. Treasury Notes due (2026)")).toBeNull();
    expect(extractTicker("Held at Fidelity (brokerage)")).toBeNull();
    expect(extractTicker("Private placement, no symbol")).toBeNull();
  });
});

describe("classifyAssetType", () => {
  it("prefers the bracketed fd.house.gov tag over keywords", () => {
    expect(classifyAssetType("iShares Core U.S. Aggregate Bond ETF (AGG) [EF]", "AGG")).toBe(
      "fund",
    );
    expect(classifyAssetType("Ethereum (ETH) [CT]", "ETH")).toBe("crypto");
    expect(classifyAssetType("U.S. Treasury Bills due 11/2026 [GS]", null)).toBe("bond");
    expect(classifyAssetType("Apple Inc call options 01/2027 [OP]", "AAPL")).toBe("option");
  });

  it("falls back to keywords, then ticker presence, then other", () => {
    expect(classifyAssetType("Puts on Example Corp", null)).toBe("option");
    expect(classifyAssetType("Municipal revenue bond 2031", null)).toBe("bond");
    expect(classifyAssetType("Bitcoin held at exchange", null)).toBe("crypto");
    expect(classifyAssetType("Meridian Value Fund Class A", null)).toBe("fund");
    expect(classifyAssetType("Meridian Aviation Holdings plc (MAH.L)", "MAH.L")).toBe("stock");
    expect(classifyAssetType("Farmland, Ross County OH", null)).toBe("other");
  });
});
