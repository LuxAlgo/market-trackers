import { describe, expect, it } from "vitest";
import { parseWikiArticleMap, wikiArticleMap } from "./article-map.js";

describe("parseWikiArticleMap", () => {
  it("accepts a well-formed map", () => {
    const map = parseWikiArticleMap({
      version: 1,
      entries: [{ project: "en.wikipedia", article: "Nvidia", tickers: ["NVDA"] }],
    });
    expect(map.entries).toHaveLength(1);
  });

  it("accepts a dotted multi-class ticker (e.g. BRK.B)", () => {
    const map = parseWikiArticleMap({
      version: 1,
      entries: [
        { project: "en.wikipedia", article: "Berkshire_Hathaway", tickers: ["BRK.A", "BRK.B"] },
      ],
    });
    expect(map.entries[0]?.tickers).toEqual(["BRK.A", "BRK.B"]);
  });

  it("rejects a duplicate (project, article) pair", () => {
    expect(() =>
      parseWikiArticleMap({
        version: 1,
        entries: [
          { project: "en.wikipedia", article: "Nvidia", tickers: ["NVDA"] },
          { project: "en.wikipedia", article: "Nvidia", tickers: ["NVDA"] },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("allows the same article title across two different projects", () => {
    const map = parseWikiArticleMap({
      version: 1,
      entries: [
        { project: "en.wikipedia", article: "Nvidia", tickers: ["NVDA"] },
        { project: "de.wikipedia", article: "Nvidia", tickers: ["NVDA"] },
      ],
    });
    expect(map.entries).toHaveLength(2);
  });

  it("rejects a lowercase ticker", () => {
    expect(() =>
      parseWikiArticleMap({
        version: 1,
        entries: [{ project: "en.wikipedia", article: "Nvidia", tickers: ["nvda"] }],
      }),
    ).toThrow();
  });

  it("rejects whitespace in an article title", () => {
    expect(() =>
      parseWikiArticleMap({
        version: 1,
        entries: [{ project: "en.wikipedia", article: "Apple Inc.", tickers: ["AAPL"] }],
      }),
    ).toThrow(/whitespace/);
  });

  it("rejects an entry with no tickers", () => {
    expect(() =>
      parseWikiArticleMap({
        version: 1,
        entries: [{ project: "en.wikipedia", article: "Nvidia", tickers: [] }],
      }),
    ).toThrow();
  });

  it("rejects an empty article title", () => {
    expect(() =>
      parseWikiArticleMap({
        version: 1,
        entries: [{ project: "en.wikipedia", article: "", tickers: ["NVDA"] }],
      }),
    ).toThrow();
  });
});

describe("the shipped wiki-articles map", () => {
  it("parses and stays within the curated-size range (60–100 companies)", () => {
    const map = wikiArticleMap();
    expect(map.version).toBe(1);
    expect(map.entries.length).toBeGreaterThanOrEqual(60);
    expect(map.entries.length).toBeLessThanOrEqual(100);
  });

  it("every (project, article) pair is unique", () => {
    const map = wikiArticleMap();
    const keys = map.entries.map((e) => `${e.project}:${e.article}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every ticker is uppercase", () => {
    const map = wikiArticleMap();
    for (const entry of map.entries) {
      for (const ticker of entry.tickers) {
        expect(ticker).toBe(ticker.toUpperCase());
      }
    }
  });

  it("no article title contains whitespace", () => {
    const map = wikiArticleMap();
    for (const entry of map.entries) {
      expect(/\s/.test(entry.article)).toBe(false);
    }
  });

  it("never ships a bare ambiguous title for a company with a disambiguated one", () => {
    // The exact traps this project is required to avoid: a short, common
    // name that collides with another Wikipedia topic.
    const articles = new Set(wikiArticleMap().entries.map((e) => e.article));
    expect(articles.has("Apple")).toBe(false);
    expect(articles.has("Amazon")).toBe(false);
    expect(articles.has("Ford")).toBe(false);
    // The disambiguated forms are the ones actually shipped.
    expect(articles.has("Apple_Inc.")).toBe(true);
    expect(articles.has("Amazon_(company)")).toBe(true);
    expect(articles.has("Ford_Motor_Company")).toBe(true);
  });
});
