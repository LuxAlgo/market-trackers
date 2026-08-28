import { describe, expect, it } from "vitest";
import { isOwnershipForm, isThirteenfForm, parseMasterIndex } from "./daily-index.js";
import { accessionFromPath, dailyIndexUrl, filingIndexUrl, filingTxtUrl } from "./client.js";
import { readFixture } from "../../test-helpers.js";

describe("parseMasterIndex", () => {
  const { entries, headerLines } = parseMasterIndex(
    readFixture("edgar-daily-index", "master-sample.idx"),
  );

  it("parses every data row and skips the preamble", () => {
    expect(entries).toHaveLength(5);
    expect(entries[1]).toEqual({
      cik: "123456",
      companyName: "EXAMPLECORP INC",
      formType: "4",
      dateFiled: "2026-08-20",
      path: "edgar/data/123456/0001127602-26-019876.txt",
    });
  });

  it("captures header lines for fingerprinting", () => {
    expect(headerLines[0]).toMatch(/^Description:/);
  });

  it("classifies form types", () => {
    const forms = entries.map((e) => e.formType);
    expect(forms.filter(isOwnershipForm)).toEqual(["4", "3"]);
    expect(forms.filter(isThirteenfForm)).toEqual(["13F-HR"]);
  });

  // Regression: old-era indexes (roughly pre-2011) write Date Filed as bare
  // YYYYMMDD. Un-normalized it fails the schema's filedAt regex on every
  // row-producing filing — a 2004 backfill shift once parsed 57k filings
  // and ingested zero rows because of exactly this.
  it("normalizes the old-era YYYYMMDD Date Filed column to dashed form", () => {
    const oldEra = [
      "Description:           Master Index of EDGAR Dissemination Feed",
      "-------------------",
      "878736|EXAMPLECORP INC|4|20040211|edgar/data/878736/0000878736-04-000079.txt",
      "878736|EXAMPLECORP INC|4|2026-08-20|edgar/data/878736/0000878736-26-000079.txt",
    ].join("\n");
    const parsed = parseMasterIndex(oldEra);
    expect(parsed.entries.map((e) => e.dateFiled)).toEqual(["2004-02-11", "2026-08-20"]);
  });
});

describe("EDGAR url builders", () => {
  it("builds daily index urls with the right quarter", () => {
    expect(dailyIndexUrl("2026-08-20")).toBe(
      "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/master.20260820.idx",
    );
    expect(dailyIndexUrl("2026-01-05")).toContain("/QTR1/master.20260105.idx");
  });

  it("derives filing txt/index urls and accession numbers from index paths", () => {
    const path = "edgar/data/123456/0001127602-26-019876.txt";
    expect(filingTxtUrl(path)).toBe(
      "https://www.sec.gov/Archives/edgar/data/123456/0001127602-26-019876.txt",
    );
    expect(filingIndexUrl(path)).toBe(
      "https://www.sec.gov/Archives/edgar/data/123456/0001127602-26-019876-index.htm",
    );
    expect(accessionFromPath(path)).toBe("0001127602-26-019876");
    expect(accessionFromPath("edgar/data/1/weird.htm")).toBeNull();
  });
});
