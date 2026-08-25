import { describe, expect, it } from "vitest";
import { parseBillStatusXml } from "./bill-xml.js";

const CTX = { congress: 119, billType: "hr", billNumber: 1234 };

function wrap(bill: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><billStatus>${bill}</billStatus>`;
}

const FULL_BILL = wrap(`
  <bill>
    <congress>119</congress>
    <type>HR</type>
    <number>1234</number>
    <introducedDate>2025-02-10</introducedDate>
    <sponsors>
      <item>
        <bioguideId>E000001</bioguideId>
        <fullName>Rep. Example, Jane [D-VT-1]</fullName>
      </item>
    </sponsors>
    <cosponsors>
      <item><bioguideId>E000002</bioguideId><fullName>Second Cosponsor</fullName></item>
      <item><bioguideId>E000003</bioguideId><fullName>Third Cosponsor</fullName></item>
    </cosponsors>
    <latestAction>
      <actionDate>2026-08-12</actionDate>
      <text>Referred to the Subcommittee on Example Matters.</text>
    </latestAction>
    <title>Example Data Transparency &amp; Modernization Act</title>
    <titles>
      <item>
        <titleType>Display Title</titleType>
        <title>Example Data Transparency &amp; Modernization Act</title>
      </item>
      <item>
        <titleType>Short Title(s) as Introduced</titleType>
        <title>A DIFFERENT NESTED TITLE THAT MUST NOT BE PICKED</title>
      </item>
    </titles>
    <policyArea>
      <name>Science, Technology, Communications</name>
    </policyArea>
  </bill>
`);

describe("parseBillStatusXml", () => {
  it("parses every field from a fully populated document", () => {
    expect(parseBillStatusXml(FULL_BILL, CTX)).toEqual({
      congress: 119,
      billType: "hr",
      billNumber: 1234,
      title: "Example Data Transparency & Modernization Act",
      introducedDate: "2025-02-10",
      latestActionDate: "2026-08-12",
      latestActionText: "Referred to the Subcommittee on Example Matters.",
      sponsorBioguideId: "E000001",
      sponsorName: "Rep. Example, Jane [D-VT-1]",
      policyArea: "Science, Technology, Communications",
      cosponsorCount: 2,
    });
  });

  it("picks the top-level <title>, never a nested <titles><item><title> variant", () => {
    const swapped = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <titles>
          <item><title>NESTED — must not be picked</title></item>
        </titles>
        <title>Correct Top-Level Title</title>
      </bill>
    `);
    expect(parseBillStatusXml(swapped, CTX).title).toBe("Correct Top-Level Title");
  });

  it("unwraps a CDATA-wrapped title", () => {
    const cdata = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <title><![CDATA[Example Minimal Reporting Act]]></title>
      </bill>
    `);
    expect(parseBillStatusXml(cdata, CTX).title).toBe("Example Minimal Reporting Act");
  });

  it("slices a full-timestamp introducedDate/actionDate down to YYYY-MM-DD", () => {
    const timestamped = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2026-07-01T00:00:00Z</introducedDate>
        <title>Timestamp Handling Act</title>
        <latestAction>
          <actionDate>2026-08-01T14:22:00-04:00</actionDate>
          <text>Some action.</text>
        </latestAction>
      </bill>
    `);
    const parsed = parseBillStatusXml(timestamped, CTX);
    expect(parsed.introducedDate).toBe("2026-07-01");
    expect(parsed.latestActionDate).toBe("2026-08-01");
  });

  it("treats missing optional sections as null/zero, not a parse failure", () => {
    const sparse = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2026-07-01</introducedDate>
        <title>Sparse Bill Act</title>
      </bill>
    `);
    expect(parseBillStatusXml(sparse, CTX)).toEqual({
      congress: 119,
      billType: "hr",
      billNumber: 1234,
      title: "Sparse Bill Act",
      introducedDate: "2026-07-01",
      latestActionDate: null,
      latestActionText: null,
      sponsorBioguideId: null,
      sponsorName: null,
      policyArea: null,
      cosponsorCount: 0,
    });
  });

  it("counts zero cosponsors for an empty-but-present <cosponsors> tag", () => {
    const empty = wrap(`
      <bill>
        <congress>119</congress>
        <type>S</type>
        <number>200</number>
        <introducedDate>2025-03-05</introducedDate>
        <title>Empty Cosponsors Act</title>
        <cosponsors></cosponsors>
      </bill>
    `);
    expect(
      parseBillStatusXml(empty, { congress: 119, billType: "s", billNumber: 200 }).cosponsorCount,
    ).toBe(0);
  });

  it("throws when there is no <bill> element", () => {
    expect(() => parseBillStatusXml("<billStatus></billStatus>", CTX)).toThrow(/no <bill>/);
  });

  it("throws when <title> is missing", () => {
    const noTitle = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>9999</number>
        <introducedDate>2026-06-01</introducedDate>
      </bill>
    `);
    expect(() => parseBillStatusXml(noTitle, { ...CTX, billNumber: 9999 })).toThrow(/title/);
  });

  it("throws when <introducedDate> is missing or unusable", () => {
    const noDate = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <title>No Date Act</title>
      </bill>
    `);
    expect(() => parseBillStatusXml(noDate, CTX)).toThrow(/introducedDate/);
  });

  it("throws when the document's congress disagrees with the request", () => {
    const wrongCongress = wrap(`
      <bill>
        <congress>118</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <title>Wrong Congress Act</title>
      </bill>
    `);
    expect(() => parseBillStatusXml(wrongCongress, CTX)).toThrow(/congress/);
  });

  it("throws when the document's type disagrees with the request", () => {
    const wrongType = wrap(`
      <bill>
        <congress>119</congress>
        <type>S</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <title>Wrong Type Act</title>
      </bill>
    `);
    expect(() => parseBillStatusXml(wrongType, CTX)).toThrow(/type/);
  });

  it("throws on an unrecognized bill type, even if it agreed with the request", () => {
    const bogus = wrap(`
      <bill>
        <congress>119</congress>
        <type>ZZZ</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <title>Bogus Type Act</title>
      </bill>
    `);
    expect(() => parseBillStatusXml(bogus, { ...CTX, billType: "zzz" })).toThrow(/unrecognized/);
  });

  it("throws when the document's number disagrees with the request", () => {
    const wrongNumber = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>4321</number>
        <introducedDate>2025-02-10</introducedDate>
        <title>Wrong Number Act</title>
      </bill>
    `);
    expect(() => parseBillStatusXml(wrongNumber, CTX)).toThrow(/number/);
  });

  it("reads only the first sponsor when somehow more than one item is present", () => {
    const twoSponsors = wrap(`
      <bill>
        <congress>119</congress>
        <type>HR</type>
        <number>1234</number>
        <introducedDate>2025-02-10</introducedDate>
        <title>Two Sponsors Act</title>
        <sponsors>
          <item><bioguideId>E000001</bioguideId><fullName>First</fullName></item>
          <item><bioguideId>E000009</bioguideId><fullName>Second</fullName></item>
        </sponsors>
      </bill>
    `);
    const parsed = parseBillStatusXml(twoSponsors, CTX);
    expect(parsed.sponsorBioguideId).toBe("E000001");
    expect(parsed.sponsorName).toBe("First");
  });
});
