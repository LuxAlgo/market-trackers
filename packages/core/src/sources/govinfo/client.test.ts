import { describe, expect, it } from "vitest";
import {
  billstatusListingUrl,
  fetchBillstatusListing,
  GovinfoListingDriftError,
  toIsoInstant,
} from "./client.js";
import type { PoliteFetch } from "../../lib/http.js";

/**
 * `fetchBillstatusListing` unit tests, isolated from the full source walk
 * covered in `source.test.ts`: the live listing shape, the drift guard that
 * fails loudly when a row's fields can't be extracted, and the
 * `toIsoInstant` formatted-timestamp conversion the live shape depends on.
 */

function jsonResponse(body: unknown, status = 200): PoliteFetch {
  return (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as PoliteFetch;
}

describe("toIsoInstant", () => {
  it("canonicalizes the live listing's formatted timestamp", () => {
    // This suite (like CI) runs under UTC, where "DD-Mon-YYYY HH:MM" has no
    // separate offset to lose, so the instant equals the literal reading.
    expect(toIsoInstant("13-Jul-2026 23:36")).toBe("2026-07-13T23:36:00.000Z");
    expect(toIsoInstant("01-Jan-2026 00:00")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for missing, blank, or unparseable input", () => {
    expect(toIsoInstant(undefined)).toBeNull();
    expect(toIsoInstant(null)).toBeNull();
    expect(toIsoInstant("")).toBeNull();
    expect(toIsoInstant("   ")).toBeNull();
    expect(toIsoInstant("not a date")).toBeNull();
  });
});

describe("fetchBillstatusListing", () => {
  const URL = billstatusListingUrl(119, "hr");

  it("extracts the live field shape — justFileName + formattedLastModifiedTime — skipping folders", async () => {
    const politeFetch = jsonResponse({
      files: [
        {
          displayLabel: "some-subfolder/",
          fileExtension: "",
          folder: true,
          formattedLastModifiedTime: "01-Jan-2026 00:00",
          formattedSize: "-",
          justFileName: "some-subfolder",
          link: "https://www.govinfo.gov/bulkdata/json/BILLSTATUS/119/hr/some-subfolder",
          mimeType: "",
          name: "some-subfolder",
          size: 0,
        },
        {
          displayLabel: "BILLSTATUS-119hr152.xml",
          fileExtension: "xml",
          folder: false,
          formattedLastModifiedTime: "13-Jul-2026 23:36",
          formattedSize: "17.6 KB",
          justFileName: "BILLSTATUS-119hr152.xml",
          link: "https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr152.xml",
          mimeType: "application/xml",
          name: "BILLSTATUS-119hr152.xml",
          size: 18015,
        },
      ],
    });

    const result = await fetchBillstatusListing(politeFetch, 119, "hr");
    expect(result.entries).toEqual([
      { fileName: "BILLSTATUS-119hr152.xml", lastModified: "2026-07-13T23:36:00.000Z" },
    ]);
    expect(result.sampleRow).toMatchObject({ justFileName: "some-subfolder" });
  });

  it("still accepts the legacy fileName/lastModified fixture shape", async () => {
    const politeFetch = jsonResponse({
      files: [
        { folder: false, fileName: "BILLSTATUS-119hr9.xml", lastModified: "2026-08-01T00:00:00Z" },
      ],
    });
    const result = await fetchBillstatusListing(politeFetch, 119, "hr");
    expect(result.entries).toEqual([
      { fileName: "BILLSTATUS-119hr9.xml", lastModified: "2026-08-01T00:00:00.000Z" },
    ]);
  });

  it("throws GovinfoListingDriftError, naming the URL and first row's fields, when every non-folder row fails extraction", async () => {
    const politeFetch = jsonResponse({
      files: [{ folder: false, someRenamedField: "BILLSTATUS-119hr1.xml" }],
    });

    await expect(fetchBillstatusListing(politeFetch, 119, "hr")).rejects.toThrow(
      GovinfoListingDriftError,
    );
    await expect(fetchBillstatusListing(politeFetch, 119, "hr")).rejects.toThrow(URL);
    await expect(fetchBillstatusListing(politeFetch, 119, "hr")).rejects.toThrow(
      "someRenamedField",
    );
  });

  it("does not treat a genuinely empty listing as drift", async () => {
    const politeFetch = jsonResponse({ files: [] });
    const result = await fetchBillstatusListing(politeFetch, 119, "hr");
    expect(result.entries).toEqual([]);
    expect(result.sampleRow).toBeNull();
  });

  it("does not treat an all-folders listing as drift", async () => {
    const politeFetch = jsonResponse({
      files: [
        { folder: true, justFileName: "sub", formattedLastModifiedTime: "01-Jan-2026 00:00" },
      ],
    });
    const result = await fetchBillstatusListing(politeFetch, 119, "hr");
    expect(result.entries).toEqual([]);
  });

  it("reads a 404 as an empty listing, never an error or drift", async () => {
    const politeFetch = jsonResponse({}, 404);
    const result = await fetchBillstatusListing(politeFetch, 119, "hr");
    expect(result.entries).toEqual([]);
    expect(result.sampleRow).toBeNull();
  });
});
