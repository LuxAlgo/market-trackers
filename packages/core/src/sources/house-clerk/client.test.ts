import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  extractYearIndexXml,
  fetchYearIndex,
  HouseClerkIndexError,
  houseClerkYearIndexUrl,
  housePtrPdfUrl,
  normalizeIndexDate,
  parseYearIndexXml,
} from "./client.js";
import { HttpError, type PoliteFetch, type PoliteRequestInit } from "../../lib/http.js";
import { DocketStore } from "../../store/store.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";

const INDEX_XML = readFixture("house-clerk", "case-index-2026", "input.xml");

describe("house clerk URLs", () => {
  it("builds the yearly index and per-filing PTR PDF URLs", () => {
    expect(houseClerkYearIndexUrl(2026)).toBe(
      "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip",
    );
    expect(housePtrPdfUrl(2026, "20031234")).toBe(
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20031234.pdf",
    );
  });
});

describe("parseYearIndexXml (golden)", () => {
  it("case-index-2026", () => {
    const expected = readFixtureJson<unknown>("house-clerk", "case-index-2026", "expected.json");
    const result = parseYearIndexXml(INDEX_XML);
    expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
  });

  it("throws a typed error when the index structure is absent", () => {
    expect(() => parseYearIndexXml("<html>maintenance page</html>")).toThrow(HouseClerkIndexError);
  });
});

describe("normalizeIndexDate", () => {
  it("normalizes M/D/YYYY and passes ISO through", () => {
    expect(normalizeIndexDate("8/5/2026")).toBe("2026-08-05");
    expect(normalizeIndexDate("12/31/2025")).toBe("2025-12-31");
    expect(normalizeIndexDate("2026-08-05")).toBe("2026-08-05");
  });

  it("rejects implausible dates instead of fabricating them", () => {
    expect(normalizeIndexDate("31/12/2026")).toBeNull();
    expect(normalizeIndexDate("0/10/2026")).toBeNull();
    expect(normalizeIndexDate("August 5, 2026")).toBeNull();
  });
});

describe("extractYearIndexXml", () => {
  it("finds {YYYY}FD.xml anywhere in the ZIP, case-insensitively", () => {
    const flat = zipSync({
      "2026FD.txt": strToU8("tab-delimited variant, ignored"),
      "2026FD.xml": strToU8(INDEX_XML),
    });
    expect(extractYearIndexXml(flat, 2026)).toBe(INDEX_XML);

    const nested = zipSync({ "disclosures/2026FD.XML": strToU8(INDEX_XML) });
    expect(extractYearIndexXml(nested, 2026)).toBe(INDEX_XML);
  });

  it("throws a typed error when the XML entry is missing or the bytes are not a ZIP", () => {
    const wrongYear = zipSync({ "2025FD.xml": strToU8(INDEX_XML) });
    expect(() => extractYearIndexXml(wrongYear, 2026)).toThrow(HouseClerkIndexError);
    expect(() => extractYearIndexXml(strToU8("not a zip"), 2026)).toThrow(HouseClerkIndexError);
  });
});

describe("fetchYearIndex (conditional GET via fetch_cache)", () => {
  const url = houseClerkYearIndexUrl(2026);
  const zipBytes = zipSync({ "2026FD.xml": strToU8(INDEX_XML) });

  function stubFetch(seen: PoliteRequestInit[]): PoliteFetch {
    return async (requested, init) => {
      expect(requested).toBe(url);
      seen.push(init ?? {});
      if (init?.headers?.["if-none-match"] === 'W/"idx-1"') {
        return new Response(null, { status: 304 });
      }
      return new Response(new Uint8Array(zipBytes), {
        status: 200,
        headers: { etag: 'W/"idx-1"', "last-modified": "Tue, 18 Aug 2026 20:00:00 GMT" },
      });
    };
  }

  it("sends validators only once cached, and reports 304 as not-modified", async () => {
    const store = await DocketStore.open(":memory:");
    const seen: PoliteRequestInit[] = [];
    const politeFetch = stubFetch(seen);

    const first = await fetchYearIndex(politeFetch, store, 2026);
    expect(first.status).toBe("ok");
    if (first.status === "ok") {
      expect(first.xml).toBe(INDEX_XML);
      expect(first.etag).toBe('W/"idx-1"');
      expect(first.lastModified).toBe("Tue, 18 Aug 2026 20:00:00 GMT");
    }
    expect(seen[0]?.headers?.["if-none-match"]).toBeUndefined();

    // The caller persists validators only after a complete walk.
    await store.setFetchCache(url, {
      etag: 'W/"idx-1"',
      lastModified: "Tue, 18 Aug 2026 20:00:00 GMT",
    });

    const second = await fetchYearIndex(politeFetch, store, 2026);
    expect(second.status).toBe("not-modified");
    expect(seen[1]?.headers?.["if-none-match"]).toBe('W/"idx-1"');
    expect(seen[1]?.headers?.["if-modified-since"]).toBe("Tue, 18 Aug 2026 20:00:00 GMT");

    // conditional: false must bypass the cache (used by --full/--since and canaries).
    const third = await fetchYearIndex(politeFetch, store, 2026, { conditional: false });
    expect(third.status).toBe("ok");
    expect(seen[2]?.headers?.["if-none-match"]).toBeUndefined();

    await store.close();
  });

  it("maps 404 to not-found and other failures to HttpError", async () => {
    const store = await DocketStore.open(":memory:");
    const notFound: PoliteFetch = async () => new Response("nope", { status: 404 });
    expect((await fetchYearIndex(notFound, store, 2026)).status).toBe("not-found");

    const broken: PoliteFetch = async () => new Response("boom", { status: 500 });
    await expect(fetchYearIndex(broken, store, 2026)).rejects.toThrow(HttpError);
    await store.close();
  });
});
