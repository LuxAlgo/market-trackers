import { describe, expect, it } from "vitest";
import {
  officeFromCandidateId,
  parseFecAmount,
  parseFecCompactDate,
  parseFecNullableNumber,
  parseFecSlashDate,
} from "./normalize.js";

describe("parseFecSlashDate", () => {
  it("parses MM/DD/YYYY", () => {
    expect(parseFecSlashDate("06/30/2026")).toBe("2026-06-30");
    expect(parseFecSlashDate("1/5/2026")).toBe("2026-01-05");
  });

  it("blank or garbage → null, never fabricated", () => {
    expect(parseFecSlashDate("")).toBeNull();
    expect(parseFecSlashDate("  ")).toBeNull();
    expect(parseFecSlashDate(undefined)).toBeNull();
    expect(parseFecSlashDate("00/00/0000")).toBeNull();
    expect(parseFecSlashDate("13/01/2026")).toBeNull();
    expect(parseFecSlashDate("06/32/2026")).toBeNull();
    expect(parseFecSlashDate("not a date")).toBeNull();
    expect(parseFecSlashDate("20260630")).toBeNull();
  });
});

describe("parseFecCompactDate", () => {
  it("parses MMDDYYYY", () => {
    expect(parseFecCompactDate("05142026")).toBe("2026-05-14");
    expect(parseFecCompactDate("01052026")).toBe("2026-01-05");
  });

  it("blank or garbage → null, never fabricated", () => {
    expect(parseFecCompactDate("")).toBeNull();
    expect(parseFecCompactDate(undefined)).toBeNull();
    expect(parseFecCompactDate("00000000")).toBeNull();
    expect(parseFecCompactDate("13012026")).toBeNull();
    expect(parseFecCompactDate("06/30/2026")).toBeNull();
    expect(parseFecCompactDate("2026")).toBeNull();
  });
});

describe("parseFecNullableNumber", () => {
  it("parses plain numbers, including negative and decimal", () => {
    expect(parseFecNullableNumber("1250000.50")).toBe(1250000.5);
    expect(parseFecNullableNumber("-500")).toBe(-500);
    expect(parseFecNullableNumber("0")).toBe(0);
  });

  it("blank AND garbage both degrade to null, never a fabricated zero", () => {
    expect(parseFecNullableNumber("")).toBeNull();
    expect(parseFecNullableNumber("  ")).toBeNull();
    expect(parseFecNullableNumber(undefined)).toBeNull();
    expect(parseFecNullableNumber("N/A")).toBeNull();
  });
});

describe("parseFecAmount (required field)", () => {
  it("parses plain numbers, preserving a negative sign (refunds stay negative)", () => {
    expect(parseFecAmount("5000", "TRANSACTION_AMT")).toBe(5000);
    expect(parseFecAmount("2500.75", "TRANSACTION_AMT")).toBe(2500.75);
    expect(parseFecAmount("-500.00", "TRANSACTION_AMT")).toBe(-500);
  });

  it("throws on blank or garbage rather than returning null or zero", () => {
    expect(() => parseFecAmount("", "TRANSACTION_AMT")).toThrow(/missing/);
    expect(() => parseFecAmount(undefined, "TRANSACTION_AMT")).toThrow(/missing/);
    expect(() => parseFecAmount("abc", "TRANSACTION_AMT")).toThrow(/unparseable/);
  });
});

describe("officeFromCandidateId", () => {
  it("reads the office letter from the first character", () => {
    expect(officeFromCandidateId("H6VT01234")).toBe("H");
    expect(officeFromCandidateId("S6CA00123")).toBe("S");
    expect(officeFromCandidateId("P60003456")).toBe("P");
  });

  it("rejects anything else instead of guessing", () => {
    expect(officeFromCandidateId("Z6AZ00333")).toBeNull();
    expect(officeFromCandidateId("")).toBeNull();
    expect(officeFromCandidateId("h6VT01234")).toBeNull();
  });
});
