import { describe, expect, it } from "vitest";
import {
  normalizePageviewItem,
  parseDailyTimestamp,
  parseViews,
  WIKIMEDIA_PARSER,
} from "./parser.js";
import type { WikimediaPageviewItem } from "./client.js";
import { readFixtureJson } from "../../test-helpers.js";
import type { WikiPageview } from "../../schema/wiki-pageview.js";

describe("parseDailyTimestamp", () => {
  it("parses a well-formed daily timestamp", () => {
    expect(parseDailyTimestamp("2026080100")).toBe("2026-08-01");
    expect(parseDailyTimestamp("2026123100")).toBe("2026-12-31");
  });

  it("rejects anything other than exactly 10 digits", () => {
    expect(parseDailyTimestamp("202608010")).toBeNull();
    expect(parseDailyTimestamp("20260801000")).toBeNull();
    expect(parseDailyTimestamp("")).toBeNull();
  });

  it("rejects a non-'00' hour suffix (this endpoint is daily granularity only)", () => {
    expect(parseDailyTimestamp("2026080112")).toBeNull();
  });

  it("rejects a calendar-invalid day that still matches the digit shape", () => {
    expect(parseDailyTimestamp("2026023100")).toBeNull(); // Feb 31 doesn't exist
    expect(parseDailyTimestamp("2026043100")).toBeNull(); // April 31 doesn't exist (30-day month)
  });

  it("rejects non-string input", () => {
    expect(parseDailyTimestamp(20260801)).toBeNull();
    expect(parseDailyTimestamp(null)).toBeNull();
    expect(parseDailyTimestamp(undefined)).toBeNull();
  });
});

describe("parseViews", () => {
  it("accepts a non-negative integer number", () => {
    expect(parseViews(0)).toBe(0);
    expect(parseViews(41823)).toBe(41823);
  });

  it("accepts a digit string", () => {
    expect(parseViews("41823")).toBe(41823);
  });

  it("rejects a negative number", () => {
    expect(parseViews(-1)).toBeNull();
  });

  it("rejects a non-integer number", () => {
    expect(parseViews(1.5)).toBeNull();
  });

  it("rejects a non-numeric string", () => {
    expect(parseViews("not-a-number")).toBeNull();
    expect(parseViews("")).toBeNull();
    expect(parseViews("  ")).toBeNull();
    expect(parseViews("12.5")).toBeNull();
  });

  it("rejects non-number, non-string input", () => {
    expect(parseViews(null)).toBeNull();
    expect(parseViews(undefined)).toBeNull();
    expect(parseViews({})).toBeNull();
  });
});

describe("normalizePageviewItem (golden: case-daily-window)", () => {
  const FIXTURE = readFixtureJson<{ items: WikimediaPageviewItem[] }>(
    "wikimedia",
    "case-daily-window",
    "input.json",
  );
  const EXPECTED = readFixtureJson<WikiPageview[]>(
    "wikimedia",
    "case-daily-window",
    "expected.json",
  );
  const SOURCE_URL =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Nvidia/daily/2026081800/2026082000";
  const RETRIEVED_AT = "2026-08-24T12:00:00.000Z";

  it("normalizes every item to the hand-verified expected row", () => {
    const rows = FIXTURE.items.map((raw) =>
      normalizePageviewItem(raw, {
        expectedProject: "en.wikipedia",
        expectedArticle: "Nvidia",
        tickers: ["NVDA"],
        sourceUrl: SOURCE_URL,
        retrievedAt: RETRIEVED_AT,
      }),
    );
    expect(rows).toEqual(EXPECTED);
  });

  it("carries every mapped ticker through, not just the first", () => {
    const [first] = FIXTURE.items;
    const row = normalizePageviewItem(first as WikimediaPageviewItem, {
      expectedProject: "en.wikipedia",
      expectedArticle: "Nvidia",
      tickers: ["GOOGL", "GOOG"],
      sourceUrl: SOURCE_URL,
      retrievedAt: RETRIEVED_AT,
    });
    expect(row.tickers).toEqual(["GOOGL", "GOOG"]);
  });
});

describe("normalizePageviewItem (golden: case-malformed-item)", () => {
  const FIXTURE = readFixtureJson<{ items: WikimediaPageviewItem[] }>(
    "wikimedia",
    "case-malformed-item",
    "input.json",
  );
  const EXPECTED = readFixtureJson<WikiPageview[]>(
    "wikimedia",
    "case-malformed-item",
    "expected.json",
  );
  const SOURCE_URL =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Ford_Motor_Company/daily/2026081800/2026082000";
  const RETRIEVED_AT = "2026-08-24T12:00:00.000Z";

  it("normalizes the two valid items and fails the other two, matching the fixture's stats", () => {
    const rows: WikiPageview[] = [];
    let attempted = 0;
    let succeeded = 0;
    for (const raw of FIXTURE.items) {
      attempted += 1;
      try {
        rows.push(
          normalizePageviewItem(raw, {
            expectedProject: "en.wikipedia",
            expectedArticle: "Ford_Motor_Company",
            tickers: ["F"],
            sourceUrl: SOURCE_URL,
            retrievedAt: RETRIEVED_AT,
          }),
        );
        succeeded += 1;
      } catch {
        // Expected for the malformed items; counted below.
      }
    }
    expect({ attempted, succeeded }).toEqual({ attempted: 4, succeeded: 2 });
    expect(rows).toEqual(EXPECTED);
  });

  it("fails the whole item on a non-numeric views value, never zeroing it", () => {
    const badViewsItem = FIXTURE.items[1] as WikimediaPageviewItem;
    expect(() =>
      normalizePageviewItem(badViewsItem, {
        expectedProject: "en.wikipedia",
        expectedArticle: "Ford_Motor_Company",
        tickers: ["F"],
        sourceUrl: SOURCE_URL,
        retrievedAt: RETRIEVED_AT,
      }),
    ).toThrow(/views/);
  });

  it("fails an item whose echoed article does not match the requested article", () => {
    const mismatchedItem = FIXTURE.items[3] as WikimediaPageviewItem;
    expect(mismatchedItem.article).toBe("General_Motors");
    expect(() =>
      normalizePageviewItem(mismatchedItem, {
        expectedProject: "en.wikipedia",
        expectedArticle: "Ford_Motor_Company",
        tickers: ["F"],
        sourceUrl: SOURCE_URL,
        retrievedAt: RETRIEVED_AT,
      }),
    ).toThrow(/does not match/);
  });
});

describe("normalizePageviewItem — integrity guards", () => {
  const BASE: WikimediaPageviewItem = {
    project: "en.wikipedia",
    article: "Nvidia",
    granularity: "daily",
    timestamp: "2026081800",
    access: "all-access",
    agent: "user",
    views: 100,
  };
  const INPUT = {
    expectedProject: "en.wikipedia",
    expectedArticle: "Nvidia",
    tickers: ["NVDA"],
    sourceUrl: "https://example.org/probe",
    retrievedAt: "2026-08-24T12:00:00.000Z",
  };

  it("fails when the echoed project does not match the requested project", () => {
    expect(() => normalizePageviewItem({ ...BASE, project: "de.wikipedia" }, INPUT)).toThrow(
      /does not match/,
    );
  });

  it("sets parser identity, confidence 1, needsReview false", () => {
    const row = normalizePageviewItem(BASE, INPUT);
    expect(row.provenance.parser).toBe(WIKIMEDIA_PARSER);
    expect(row.provenance.confidence).toBe(1);
    expect(row.provenance.needsReview).toBe(false);
    expect(row.provenance.source).toBe("wikimedia");
  });

  it("builds the id via the project:article:day natural key", () => {
    const row = normalizePageviewItem(BASE, INPUT);
    expect(row.id).toBe("en.wikipedia:Nvidia:2026-08-18");
  });
});
