import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fecCandidateMasterZipUrl,
  fecCandidateUrl,
  fecCommitteeMasterZipUrl,
  fecCommitteeUrl,
  fecPas2ZipUrl,
  fecWeballZipUrl,
  fetchBulkTextFile,
  FecBulkFileError,
  firstNonEmptyLine,
  pipeColumnFingerprint,
  splitPipeLine,
  weballEntryName,
} from "./client.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { fixturePath } from "../../test-helpers.js";

const WEBALL_ZIP = new Uint8Array(
  readFileSync(fixturePath("fec", "case-cycle-2026", "weball26.zip")),
);
const WEBALL_TEXT = readFileSync(fixturePath("fec", "case-cycle-2026", "weball26.txt"), "utf8");

describe("URL builders", () => {
  it("builds the four per-cycle bulk ZIP URLs", () => {
    expect(fecWeballZipUrl(2026)).toBe(
      "https://www.fec.gov/files/bulk-downloads/2026/weball26.zip",
    );
    expect(fecPas2ZipUrl(2026)).toBe("https://www.fec.gov/files/bulk-downloads/2026/pas226.zip");
    expect(fecCandidateMasterZipUrl(2026)).toBe(
      "https://www.fec.gov/files/bulk-downloads/2026/cn26.zip",
    );
    expect(fecCommitteeMasterZipUrl(2026)).toBe(
      "https://www.fec.gov/files/bulk-downloads/2026/cm26.zip",
    );
  });

  it("pads the cycle suffix and names weball's entry per-cycle", () => {
    expect(weballEntryName(2026)).toBe("weball26.txt");
    expect(fecWeballZipUrl(2008)).toBe(
      "https://www.fec.gov/files/bulk-downloads/2008/weball08.zip",
    );
  });

  it("builds the FEC.gov public detail-page provenance URLs", () => {
    expect(fecCandidateUrl("H6VT01234", 2026)).toBe(
      "https://www.fec.gov/data/candidate/H6VT01234/?cycle=2026",
    );
    expect(fecCommitteeUrl("C00123456", 2026)).toBe(
      "https://www.fec.gov/data/committee/C00123456/?cycle=2026",
    );
  });
});

describe("fetchBulkTextFile", () => {
  function stubFetch(response: Response): PoliteFetch {
    return async () => response;
  }

  it("downloads and unzips the one named text entry", async () => {
    const politeFetch = stubFetch(new Response(WEBALL_ZIP, { status: 200 }));
    const text = await fetchBulkTextFile(
      politeFetch,
      "https://example/weball26.zip",
      "weball26.txt",
    );
    expect(text).toBe(WEBALL_TEXT);
  });

  it("throws HttpError on a non-2xx response", async () => {
    const politeFetch = stubFetch(new Response("nope", { status: 500 }));
    await expect(
      fetchBulkTextFile(politeFetch, "https://example/weball26.zip", "weball26.txt"),
    ).rejects.toThrow(HttpError);
  });

  it("throws FecBulkFileError when the wanted entry isn't inside the ZIP", async () => {
    const politeFetch = stubFetch(new Response(WEBALL_ZIP, { status: 200 }));
    await expect(
      fetchBulkTextFile(politeFetch, "https://example/weball26.zip", "itpas2.txt"),
    ).rejects.toThrow(FecBulkFileError);
  });
});

describe("pipeColumnFingerprint / firstNonEmptyLine / splitPipeLine", () => {
  it("counts pipes on the first non-empty line", () => {
    expect(firstNonEmptyLine("\n\nA|B|C\nD|E")).toBe("A|B|C");
    expect(pipeColumnFingerprint("A|B|C")).toBe("2");
    expect(pipeColumnFingerprint("A")).toBe("0");
  });

  it("returns null for text with no non-empty line", () => {
    expect(firstNonEmptyLine("")).toBeNull();
    expect(firstNonEmptyLine("\n\n")).toBeNull();
  });

  it("splits a pipe-delimited line without trimming", () => {
    expect(splitPipeLine("A| B |C")).toEqual(["A", " B ", "C"]);
  });
});
