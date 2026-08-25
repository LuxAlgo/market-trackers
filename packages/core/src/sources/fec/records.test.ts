import { describe, expect, it } from "vitest";
import {
  buildCandidateNameMap,
  buildCommitteeNameMap,
  FEC_PARSER,
  normalizeCandidateLine,
  normalizeContributionLine,
} from "./records.js";
import { makeFecCandidate, makeFecContribution, readFixture } from "../../test-helpers.js";

const RETRIEVED_AT = "2026-08-25T12:00:00.000Z";
const CYCLE = 2026;

const weballLines = readFixture("fec", "case-cycle-2026", "weball26.txt").trim().split("\n");
const pas2Lines = readFixture("fec", "case-cycle-2026", "itpas2.txt").trim().split("\n");
const cnText = readFixture("fec", "case-cycle-2026", "cn.txt");
const cmText = readFixture("fec", "case-cycle-2026", "cm.txt");

describe("normalizeCandidateLine", () => {
  it("row 1 matches the makeFecCandidate() test-helper defaults exactly", () => {
    const record = normalizeCandidateLine({
      line: weballLines[0] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(record).toEqual(
      makeFecCandidate({
        provenance: {
          source: "fec",
          sourceUrl: "https://www.fec.gov/data/candidate/H6VT01234/?cycle=2026",
          retrievedAt: RETRIEVED_AT,
          parser: FEC_PARSER,
          confidence: 1,
          needsReview: false,
        },
      }),
    );
  });

  it("a Senate/President row with a blank district maps to district: null", () => {
    const senate = normalizeCandidateLine({
      line: weballLines[1] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(senate.office).toBe("S");
    expect(senate.district).toBeNull();

    const president = normalizeCandidateLine({
      line: weballLines[2] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(president.office).toBe("P");
    expect(president.state).toBe("US");
    expect(president.district).toBeNull();
  });

  it("blank party/receipts/coverage-end-date all become null, not fabricated", () => {
    const record = normalizeCandidateLine({
      line: weballLines[3] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(record.candidateId).toBe("H2NY00111");
    expect(record.party).toBeNull();
    expect(record.totalReceipts).toBeNull();
    expect(record.coverageEndDate).toBeNull();
    expect(record.totalDisbursements).toBe(500_000);
  });

  it("garbage (non-blank) on a nullable numeric field becomes null, not a thrown row", () => {
    const record = normalizeCandidateLine({
      line: weballLines[4] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(record.candidateId).toBe("S4TX00222");
    expect(record.totalDisbursements).toBeNull();
  });

  it("throws when the candidate id's first character isn't H/S/P", () => {
    expect(() =>
      normalizeCandidateLine({
        line: weballLines[5] as string,
        cycle: CYCLE,
        retrievedAt: RETRIEVED_AT,
      }),
    ).toThrow(/office/i);
  });

  it("sets provenance to the FEC.gov candidate detail page, this parser, confidence 1", () => {
    const record = normalizeCandidateLine({
      line: weballLines[0] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
    });
    expect(record.provenance).toEqual({
      source: "fec",
      sourceUrl: "https://www.fec.gov/data/candidate/H6VT01234/?cycle=2026",
      retrievedAt: RETRIEVED_AT,
      parser: FEC_PARSER,
      confidence: 1,
      needsReview: false,
    });
  });
});

describe("buildCandidateNameMap / buildCommitteeNameMap", () => {
  const candidateNames = buildCandidateNameMap(cnText);
  const committeeNames = buildCommitteeNameMap(cmText);

  it("maps every well-formed master row", () => {
    expect(candidateNames.get("H6VT01234")).toBe("EXAMPLE, JANE");
    expect(committeeNames.get("C00123456")).toBe("EXAMPLE INDUSTRY PAC");
  });

  it("deliberately-absent ids are simply missing, not mapped to null", () => {
    expect(candidateNames.has("H9WA00777")).toBe(false);
    expect(committeeNames.has("C00555555")).toBe(false);
  });
});

describe("normalizeContributionLine", () => {
  const candidateNames = buildCandidateNameMap(cnText);
  const committeeNames = buildCommitteeNameMap(cmText);

  function normalize(index: number) {
    return normalizeContributionLine({
      line: pas2Lines[index] as string,
      cycle: CYCLE,
      retrievedAt: RETRIEVED_AT,
      candidateNames,
      committeeNames,
    });
  }

  it("row A matches the makeFecContribution() test-helper defaults exactly", () => {
    expect(normalize(0)).toEqual(
      makeFecContribution({
        provenance: {
          source: "fec",
          sourceUrl: "https://www.fec.gov/data/committee/C00123456/?cycle=2026",
          retrievedAt: RETRIEVED_AT,
          parser: FEC_PARSER,
          confidence: 1,
          needsReview: false,
        },
      }),
    );
  });

  it("a refund row keeps its negative amount, verbatim as filed", () => {
    const refund = normalize(2);
    expect(refund.amountUsd).toBe(-500);
    expect(refund.transactionType).toBe("24R");
  });

  it("a blank TRANSACTION_DT becomes date: null", () => {
    expect(normalize(3).date).toBeNull();
  });

  it("an unresolvable committee id leaves committeeName null; the candidate still resolves", () => {
    const record = normalize(4);
    expect(record.committeeId).toBe("C00555555");
    expect(record.committeeName).toBeNull();
    expect(record.candidateName).toBe("EXAMPLE, DAN");
  });

  it("an unresolvable candidate id leaves candidateName null; the committee still resolves", () => {
    const record = normalize(7);
    expect(record.candidateId).toBe("H9WA00777");
    expect(record.candidateName).toBeNull();
    expect(record.committeeName).toBe("EXAMPLE INDUSTRY PAC");
  });

  it("throws when CAND_ID is blank", () => {
    expect(() => normalize(8)).toThrow(/CAND_ID/);
  });

  it("throws when TRANSACTION_AMT is non-numeric garbage (a required field)", () => {
    expect(() => normalize(9)).toThrow(/TRANSACTION_AMT/);
  });

  it("sets provenance to the FEC.gov committee detail page, this parser, confidence 1", () => {
    expect(normalize(0).provenance).toEqual({
      source: "fec",
      sourceUrl: "https://www.fec.gov/data/committee/C00123456/?cycle=2026",
      retrievedAt: RETRIEVED_AT,
      parser: FEC_PARSER,
      confidence: 1,
      needsReview: false,
    });
  });
});
