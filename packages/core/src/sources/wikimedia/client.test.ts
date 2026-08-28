import { describe, expect, it } from "vitest";
import {
  createWikimediaFetch,
  fetchArticleRange,
  pageviewItemFingerprint,
  pageviewsUrl,
  WIKIMEDIA_API_BASE,
  wikimediaPageviewsResponseSchema,
} from "./client.js";
import { HttpError } from "../../lib/http.js";
import { readFixtureJson } from "../../test-helpers.js";

describe("pageviewsUrl", () => {
  it("builds the exact per-article ranged request URL", () => {
    expect(pageviewsUrl("en.wikipedia", "Nvidia", "2026-08-18", "2026-08-20")).toBe(
      `${WIKIMEDIA_API_BASE}/metrics/pageviews/per-article/en.wikipedia/all-access/user/Nvidia/daily/2026081800/2026082000`,
    );
  });

  it("percent-encodes punctuation in the article title (never breaks the path)", () => {
    expect(pageviewsUrl("en.wikipedia", "AT&T", "2026-08-18", "2026-08-18")).toBe(
      `${WIKIMEDIA_API_BASE}/metrics/pageviews/per-article/en.wikipedia/all-access/user/AT%26T/daily/2026081800/2026081800`,
    );
    expect(pageviewsUrl("en.wikipedia", "S&P_Global", "2026-08-18", "2026-08-18")).toContain(
      "S%26P_Global",
    );
    expect(pageviewsUrl("en.wikipedia", "Nike,_Inc.", "2026-08-18", "2026-08-18")).toContain(
      "Nike%2C_Inc.",
    );
  });

  it("fixes agent-type=user and access=all-access — never configurable per call", () => {
    const url = pageviewsUrl("en.wikipedia", "Nvidia", "2026-08-18", "2026-08-18");
    expect(url).toContain("/all-access/user/");
  });
});

describe("fetchArticleRange", () => {
  const FIXTURE = readFixtureJson<{ items: unknown[] }>(
    "wikimedia",
    "case-daily-window",
    "input.json",
  );
  const URL = pageviewsUrl("en.wikipedia", "Nvidia", "2026-08-18", "2026-08-20");

  it("returns found:true with the parsed items on 200", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch;
    const politeFetch = createWikimediaFetch({ userAgent: "test/1", fetchImpl });
    const result = await fetchArticleRange(politeFetch, {
      project: "en.wikipedia",
      article: "Nvidia",
      start: "2026-08-18",
      end: "2026-08-20",
    });
    expect(result).toEqual({ found: true, items: FIXTURE.items });
  });

  it("requests the exact URL pageviewsUrl builds", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    const politeFetch = createWikimediaFetch({ userAgent: "test/1", fetchImpl });
    await fetchArticleRange(politeFetch, {
      project: "en.wikipedia",
      article: "Nvidia",
      start: "2026-08-18",
      end: "2026-08-20",
    });
    expect(requested).toEqual([URL]);
  });

  it("returns found:false on 404 — no data is a real answer, not a failure", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const politeFetch = createWikimediaFetch({ userAgent: "test/1", fetchImpl });
    const result = await fetchArticleRange(politeFetch, {
      project: "en.wikipedia",
      article: "Nvidia",
      start: "2026-08-18",
      end: "2026-08-20",
    });
    expect(result).toEqual({ found: false });
  });

  it("throws HttpError on a non-404 error status", async () => {
    // 400 is not in politeFetch's default retry set, so this throws immediately.
    const fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const politeFetch = createWikimediaFetch({ userAgent: "test/1", fetchImpl });
    await expect(
      fetchArticleRange(politeFetch, {
        project: "en.wikipedia",
        article: "Nvidia",
        start: "2026-08-18",
        end: "2026-08-20",
      }),
    ).rejects.toThrow(HttpError);
  });
});

describe("wikimediaPageviewsResponseSchema", () => {
  it("tolerates an item missing optional fields (only real validation happens in the normalizer)", () => {
    expect(() => wikimediaPageviewsResponseSchema.parse({ items: [{}] })).not.toThrow();
  });

  it("rejects a response with no items array at all", () => {
    expect(() => wikimediaPageviewsResponseSchema.parse({})).toThrow();
  });
});

describe("pageviewItemFingerprint", () => {
  it("is stable for the same field set regardless of key order", () => {
    const a = pageviewItemFingerprint({ project: "p", article: "a", views: 1 });
    const b = pageviewItemFingerprint({ views: 1, article: "a", project: "p" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the field set changes", () => {
    const a = pageviewItemFingerprint({ project: "p", article: "a", views: 1 });
    const b = pageviewItemFingerprint({ project: "p", article: "a", views: 1, "access-site": "x" });
    expect(a).not.toBe(b);
  });
});
