import { describe, expect, it } from "vitest";
import { extractBillReferences } from "./bill-refs.js";

describe("extractBillReferences", () => {
  it("returns an empty list for text with no bill references", () => {
    expect(extractBillReferences("General appropriations and tax policy issues.")).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(extractBillReferences("")).toEqual([]);
  });

  describe("simple bills — hr, s", () => {
    it("matches the dotted form with and without a space before the number", () => {
      expect(extractBillReferences("Support for H.R. 1234.")).toEqual(["hr1234"]);
      expect(extractBillReferences("Support for H.R.1234.")).toEqual(["hr1234"]);
      expect(extractBillReferences("Opposed to S. 567.")).toEqual(["s567"]);
      expect(extractBillReferences("Opposed to S.567.")).toEqual(["s567"]);
    });

    it("matches the dotless form with exactly one space", () => {
      expect(extractBillReferences("Support for HR 1234.")).toEqual(["hr1234"]);
      expect(extractBillReferences("Opposed to S 567.")).toEqual(["s567"]);
    });

    it("does not match the dotless form with no separator at all", () => {
      expect(extractBillReferences("Support for HR1234.")).toEqual([]);
      expect(extractBillReferences("Opposed to S567.")).toEqual([]);
    });

    it("does not match the dotless form with two or more spaces", () => {
      expect(extractBillReferences("Support for HR  1234.")).toEqual([]);
    });

    it("does not match the dotted form with two or more spaces before the number", () => {
      expect(extractBillReferences("Support for H.R.  1234.")).toEqual([]);
    });
  });

  describe("joint, concurrent, and simple resolutions", () => {
    it("matches every resolution type, dotted", () => {
      expect(extractBillReferences("See H.J.Res. 45 for details.")).toEqual(["hjres45"]);
      expect(extractBillReferences("See S.J.Res. 12 for details.")).toEqual(["sjres12"]);
      expect(extractBillReferences("See H.Con.Res. 3 for details.")).toEqual(["hconres3"]);
      expect(extractBillReferences("See S.Con.Res. 7 for details.")).toEqual(["sconres7"]);
      expect(extractBillReferences("See H.Res. 12 for details.")).toEqual(["hres12"]);
      expect(extractBillReferences("See S.Res. 9 for details.")).toEqual(["sres9"]);
    });

    it("matches every resolution type, dotless", () => {
      expect(extractBillReferences("See HJRes 45 for details.")).toEqual(["hjres45"]);
      expect(extractBillReferences("See SJRes 12 for details.")).toEqual(["sjres12"]);
      expect(extractBillReferences("See HConRes 3 for details.")).toEqual(["hconres3"]);
      expect(extractBillReferences("See SConRes 7 for details.")).toEqual(["sconres7"]);
      expect(extractBillReferences("See HRes 12 for details.")).toEqual(["hres12"]);
      expect(extractBillReferences("See SRes 9 for details.")).toEqual(["sres9"]);
    });

    it("normalizes S.Con.Res. to the sconres token, not hconres", () => {
      // A Senate concurrent resolution is a different bill type from a
      // House one — the token must track which chamber it actually is.
      expect(extractBillReferences("S.Con.Res. 7")).toEqual(["sconres7"]);
      expect(extractBillReferences("H.Con.Res. 7")).toEqual(["hconres7"]);
    });

    it("matches H.R. within a resolution-heavy passage without confusing the two", () => {
      expect(
        extractBillReferences("H.R. 10 and H.Res. 11 and H.Con.Res. 12 were all discussed."),
      ).toEqual(["hr10", "hres11", "hconres12"]);
    });
  });

  describe("near-misses that must not match", () => {
    it("does not match HRS (three letters, not the standalone HR token)", () => {
      expect(extractBillReferences("Client discussed HRS 200 policy.")).toEqual([]);
    });

    it("does not match the S inside US", () => {
      expect(extractBillReferences("Compliance with US 101 regulations.")).toEqual([]);
    });

    it("does not match SB, the state-bill style prefix", () => {
      expect(extractBillReferences("Tracking state SB 5 in committee.")).toEqual([]);
    });

    it("does not match a lowercase s, even with a plausible-looking number after it", () => {
      expect(extractBillReferences("Projected cost is s 100 million over five years.")).toEqual([]);
    });

    it("does not match any lowercase type token", () => {
      expect(extractBillReferences("see h.r. 1234, hr 1234, s. 200, hres 9")).toEqual([]);
    });

    it("does not match a bill number longer than 5 digits", () => {
      expect(extractBillReferences("Tracking number H.R. 123456 in our system.")).toEqual([]);
    });

    it("matches a 5-digit bill number at the boundary", () => {
      expect(extractBillReferences("H.R. 12345")).toEqual(["hr12345"]);
    });

    it("requires the type token to be its own word, not a suffix of a longer word", () => {
      expect(extractBillReferences("WHRes 12 is not a thing.")).toEqual([]);
    });
  });

  describe("ordering and deduplication", () => {
    it("preserves first-seen order across mixed bill types", () => {
      expect(
        extractBillReferences("Discussed S. 200 first, then H.R. 100, then S.Res. 9."),
      ).toEqual(["s200", "hr100", "sres9"]);
    });

    it("deduplicates repeated references to the same bill, keeping the first position", () => {
      expect(
        extractBillReferences("H.R. 1234 was reintroduced. See also HR 1234 and H.R.1234."),
      ).toEqual(["hr1234"]);
    });

    it("dedupes across a full realistic specific-issues narrative", () => {
      const text =
        "Lobbied in support of H.R. 3684, the surface transportation bill, and monitored " +
        "S. 686 on data privacy. Also tracked H.R. 3684 in the Senate companion process.";
      expect(extractBillReferences(text)).toEqual(["hr3684", "s686"]);
    });
  });
});
