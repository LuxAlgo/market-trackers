import { describe, expect, it } from "vitest";
// (GovinfoHearingsDriftError is deliberately unused here: every parse failure is a per-document skip.)
import { HearingModsParseError, attrValue, parseHearingMods } from "./mods-xml.js";
import { readFixture } from "../../test-helpers.js";

const CASE = ["govinfo-hearings", "case-chrg-sitemap-and-mods"];

describe("attrValue", () => {
  it("reads an attribute off the opening tag only, entity-decoded", () => {
    const block = `<congCommittee authorityId="hsex00" note="A &amp; B"><name authorityId="nested">X</name></congCommittee>`;
    expect(attrValue(block, "authorityId")).toBe("hsex00");
    expect(attrValue(block, "note")).toBe("A & B");
    expect(attrValue(block, "missing")).toBeNull();
  });

  it("matches attribute names case-insensitively (bioGuideId vs bioguideid)", () => {
    const block = `<congMember bioGuideId="E000001"></congMember>`;
    expect(attrValue(block, "bioguideid")).toBe("E000001");
  });
});

describe("parseHearingMods — rich house package", () => {
  const fields = parseHearingMods(
    readFixture(...CASE, "CHRG-119hhrg90001-mods.xml"),
    "CHRG-119hhrg90001",
  );

  it("extracts the package-level fields verbatim", () => {
    expect(fields.title).toBe("OVERSIGHT OF THE EXAMPLE DATA BUREAU & ITS PROGRAMS");
    expect(fields.chamber).toBe("house");
    expect(fields.docClass).toBe("HHRG");
    expect(fields.congress).toBe(119);
    expect(fields.session).toBe(2);
    expect(fields.heldDate).toBe("2026-06-10");
    expect(fields.citation).toBe("Serial No. 119-42");
    expect(fields.detailUrl).toBe("https://www.govinfo.gov/app/details/CHRG-119hhrg90001");
    expect(fields.htmlUrl).toBe(
      "https://www.govinfo.gov/content/pkg/CHRG-119hhrg90001/html/CHRG-119hhrg90001.htm",
    );
    expect(fields.pdfUrl).toBe(
      "https://www.govinfo.gov/content/pkg/CHRG-119hhrg90001/pdf/CHRG-119hhrg90001.pdf",
    );
  });

  it("collects committees (authority-standard name + authorityId), witnesses, and member bioguide ids", () => {
    expect(fields.committees).toEqual([
      { name: "Committee on Example Matters", authorityId: "hsex00" },
    ]);
    expect(fields.witnesses).toEqual([
      "Jane Q. Witness, Director, Example Data Bureau",
      "Robert R. Witness, Inspector General, Example Data Bureau",
    ]);
    expect(fields.memberBioguideIds).toEqual(["E000001", "E000002"]);
  });

  it("never reads granule-level (<relatedItem>) metadata into the package row", () => {
    expect(fields.title).not.toMatch(/GRANULE/);
    expect(fields.witnesses.join(" ")).not.toMatch(/Granule Witness/);
    expect(fields.memberBioguideIds).not.toContain("Z999999");
    expect(fields.heldDate).not.toBe("1999-01-01");
  });
});

describe("parseHearingMods — lenient absences", () => {
  it("senate minimal: CDATA title, dateIssued fallback, null/empty optionals", () => {
    const fields = parseHearingMods(
      readFixture(...CASE, "CHRG-119shrg90002-mods.xml"),
      "CHRG-119shrg90002",
    );
    expect(fields.title).toBe("EXAMPLE NOMINATIONS OF 2026");
    expect(fields.chamber).toBe("senate");
    expect(fields.docClass).toBe("SHRG");
    expect(fields.session).toBeNull();
    // No <heldDate> in the record — the publication date stands in.
    expect(fields.heldDate).toBe("2026-05-20");
    expect(fields.citation).toBeNull();
    expect(fields.committees).toEqual([]);
    expect(fields.witnesses).toEqual([]);
    expect(fields.memberBioguideIds).toEqual([]);
    expect(fields.htmlUrl).toBeNull();
    expect(fields.pdfUrl).toBe(
      "https://www.govinfo.gov/content/pkg/CHRG-119shrg90002/pdf/CHRG-119shrg90002.pdf",
    );
  });

  it("joint hearing: JOINT chamber → null (docClass keeps the raw code), first heldDate wins, authority-short fallback", () => {
    const fields = parseHearingMods(
      readFixture(...CASE, "CHRG-119jhrg80001-mods.xml"),
      "CHRG-119jhrg80001",
    );
    expect(fields.chamber).toBeNull();
    expect(fields.docClass).toBe("JHRG");
    expect(fields.heldDate).toBe("2025-09-17");
    expect(fields.committees).toEqual([{ name: "Example Joint Economic", authorityId: "jsec00" }]);
  });

  it("falls back to the package id's embedded congress when the extension omits <congress>", () => {
    const xml =
      `<mods><titleInfo><title>T</title></titleInfo>` +
      `<extension><accessId>CHRG-117shrg1</accessId><heldDate>2021-05-01</heldDate></extension></mods>`;
    const fields = parseHearingMods(xml, "CHRG-117shrg1");
    expect(fields.congress).toBe(117);
    expect(fields.docClass).toBeNull();
    // No Content Detail url in the record either — constructed from the id.
    expect(fields.detailUrl).toBe("https://www.govinfo.gov/app/details/CHRG-117shrg1");
  });
});

describe("parseHearingMods — hard edges", () => {
  it("throws HearingModsParseError when the accessId disagrees with the requested package", () => {
    const xml = readFixture(...CASE, "CHRG-119hhrg90001-mods.xml");
    expect(() => parseHearingMods(xml, "CHRG-119hhrg55555")).toThrow(HearingModsParseError);
    expect(() => parseHearingMods(xml, "CHRG-119hhrg55555")).toThrow(/does not match/);
  });

  it("throws HearingModsParseError for a document with an accessId but no title", () => {
    const xml = readFixture(...CASE, "CHRG-119hhrg99999-mods.xml");
    expect(() => parseHearingMods(xml, "CHRG-119hhrg99999")).toThrow(HearingModsParseError);
    expect(() => parseHearingMods(xml, "CHRG-119hhrg99999")).toThrow(/missing <titleInfo>/);
  });

  it("throws HearingModsParseError when no usable heldDate or dateIssued exists", () => {
    const xml =
      `<mods><titleInfo><title>T</title></titleInfo>` +
      `<extension><accessId>CHRG-119hhrg1</accessId><congress>119</congress></extension></mods>`;
    expect(() => parseHearingMods(xml, "CHRG-119hhrg1")).toThrow(HearingModsParseError);
    expect(() => parseHearingMods(xml, "CHRG-119hhrg1")).toThrow(/heldDate/);
  });

  it("throws HearingModsParseError (a skip, not run-stopping drift) when NEITHER title nor accessId exists", () => {
    // GPO really serves such stubs (observed live: CHRG-105jhrg), so one of
    // them must never stop a 30-year walk — systemic drift is the caller's
    // zero-parse tripwire's job.
    const xml = `<mods><location><url displayLabel="PDF rendition">x</url></location></mods>`;
    expect(() => parseHearingMods(xml, "CHRG-119hhrg1")).toThrow(HearingModsParseError);
    expect(() => parseHearingMods(xml, "CHRG-119hhrg1")).toThrow(/neither/);
  });
});
