import { describe, expect, it } from "vitest";
import {
  addDays,
  compactDate,
  eachDayInclusive,
  expandCompactDate,
  isWeekend,
  quarterOf,
} from "./dates.js";

describe("dates", () => {
  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("eachDayInclusive is inclusive on both ends", () => {
    expect(eachDayInclusive("2026-08-21", "2026-08-24")).toEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(eachDayInclusive("2026-08-24", "2026-08-21")).toEqual([]);
  });

  it("isWeekend", () => {
    expect(isWeekend("2026-08-22")).toBe(true); // Saturday
    expect(isWeekend("2026-08-23")).toBe(true); // Sunday
    expect(isWeekend("2026-08-24")).toBe(false); // Monday
  });

  it("compact date round-trips", () => {
    expect(compactDate("2026-08-24")).toBe("20260824");
    expect(expandCompactDate("20260824")).toBe("2026-08-24");
    expect(expandCompactDate("2026082")).toBeNull();
  });

  it("quarterOf", () => {
    expect(quarterOf("2026-01-15")).toBe(1);
    expect(quarterOf("2026-06-30")).toBe(2);
    expect(quarterOf("2026-08-24")).toBe(3);
    expect(quarterOf("2026-12-31")).toBe(4);
  });
});
