import {
  fecCandidateId,
  fecCandidateSchema,
  type FecCandidate,
} from "../../schema/fec-candidate.js";
import { fecContributionSchema, type FecContribution } from "../../schema/fec-contribution.js";
import { CM, CN, PAS2, WEBALL } from "./fields.js";
import {
  officeFromCandidateId,
  parseFecAmount,
  parseFecCompactDate,
  parseFecNullableNumber,
  parseFecSlashDate,
} from "./normalize.js";
import { fecCandidateUrl, fecCommitteeUrl, splitPipeLine } from "./client.js";

/** Bump on any behavior change to how a bulk row becomes a stored record. */
export const FEC_PARSER = "fec-bulk@1";

/** Trimmed field at `index`, or undefined past the end of a short/malformed line. */
function field(fields: string[], index: number): string | undefined {
  return fields[index]?.trim();
}

/** Blank string → null; a non-blank string is kept verbatim. */
function nullableField(fields: string[], index: number): string | null {
  return field(fields, index) || null;
}

export interface NormalizeCandidateInput {
  line: string;
  cycle: number;
  retrievedAt: string;
}

/**
 * Parses one `weball{yy}.txt` data line into a {@link FecCandidate}. Throws
 * on any required-field problem — a missing candidate id, a missing name,
 * or a candidate id whose first character isn't a recognized H/S/P office
 * — so the row is counted as a parse failure and skipped rather than
 * stored with a guessed or blank identity.
 */
export function normalizeCandidateLine(input: NormalizeCandidateInput): FecCandidate {
  const fields = splitPipeLine(input.line);

  const candidateId = field(fields, WEBALL.CAND_ID);
  if (!candidateId) throw new Error("CAND_ID: missing");
  const office = officeFromCandidateId(candidateId);
  if (!office) {
    throw new Error(`CAND_ID '${candidateId}': first character is not a recognized office (H/S/P)`);
  }
  const name = field(fields, WEBALL.CAND_NAME);
  if (!name) throw new Error(`${candidateId}: missing CAND_NAME`);

  const record: FecCandidate = {
    id: fecCandidateId(candidateId, input.cycle),
    candidateId,
    cycle: input.cycle,
    name,
    party: nullableField(fields, WEBALL.CAND_PTY_AFFILIATION),
    office,
    state: nullableField(fields, WEBALL.CAND_OFFICE_ST),
    district: nullableField(fields, WEBALL.CAND_OFFICE_DISTRICT),
    incumbentChallenger: nullableField(fields, WEBALL.CAND_ICI),
    totalReceipts: parseFecNullableNumber(field(fields, WEBALL.TTL_RECEIPTS)),
    totalDisbursements: parseFecNullableNumber(field(fields, WEBALL.TTL_DISB)),
    cashOnHand: parseFecNullableNumber(field(fields, WEBALL.COH_COP)),
    coverageEndDate: parseFecSlashDate(field(fields, WEBALL.CVG_END_DT)),
    provenance: {
      source: "fec",
      sourceUrl: fecCandidateUrl(candidateId, input.cycle),
      retrievedAt: input.retrievedAt,
      parser: FEC_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
  return fecCandidateSchema.parse(record);
}

export interface NormalizeContributionInput {
  line: string;
  cycle: number;
  retrievedAt: string;
  /** CAND_ID → display name, from `cn.txt`; a miss leaves `candidateName: null`. */
  candidateNames: Map<string, string>;
  /** CMTE_ID → display name, from `cm.txt`; a miss leaves `committeeName: null`. */
  committeeNames: Map<string, string>;
}

/**
 * Parses one `itpas2.txt` data line into a {@link FecContribution}. Throws
 * on any required-field problem — a missing SUB_ID, CMTE_ID, CAND_ID,
 * TRANSACTION_TP, or an unparseable TRANSACTION_AMT — never filling one in.
 * `TRANSACTION_DT` is the one nullable field: blank or garbage there
 * becomes `date: null` without failing the row.
 */
export function normalizeContributionLine(input: NormalizeContributionInput): FecContribution {
  const fields = splitPipeLine(input.line);

  const id = field(fields, PAS2.SUB_ID);
  if (!id) throw new Error("SUB_ID: missing");
  const committeeId = field(fields, PAS2.CMTE_ID);
  if (!committeeId) throw new Error(`${id}: missing CMTE_ID`);
  const candidateId = field(fields, PAS2.CAND_ID);
  if (!candidateId) throw new Error(`${id}: missing CAND_ID`);
  const transactionType = field(fields, PAS2.TRANSACTION_TP);
  if (!transactionType) throw new Error(`${id}: missing TRANSACTION_TP`);
  const amountUsd = parseFecAmount(field(fields, PAS2.TRANSACTION_AMT), `${id}: TRANSACTION_AMT`);

  const record: FecContribution = {
    id,
    committeeId,
    committeeName: input.committeeNames.get(committeeId) ?? null,
    candidateId,
    candidateName: input.candidateNames.get(candidateId) ?? null,
    amountUsd,
    date: parseFecCompactDate(field(fields, PAS2.TRANSACTION_DT)),
    transactionType,
    cycle: input.cycle,
    provenance: {
      source: "fec",
      sourceUrl: fecCommitteeUrl(committeeId, input.cycle),
      retrievedAt: input.retrievedAt,
      parser: FEC_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
  return fecContributionSchema.parse(record);
}

/**
 * Builds a CAND_ID → CAND_NAME lookup from `cn.txt`. A master row missing
 * either half is skipped silently — this map is a best-effort display-name
 * join, not a validated/stored dataset, so a bad master row simply means
 * the affected contribution rows keep `candidateName: null`.
 */
export function buildCandidateNameMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = splitPipeLine(line);
    const id = field(fields, CN.CAND_ID);
    const name = field(fields, CN.CAND_NAME);
    if (id && name) map.set(id, name);
  }
  return map;
}

/** Builds a CMTE_ID → CMTE_NM lookup from `cm.txt`. See {@link buildCandidateNameMap}. */
export function buildCommitteeNameMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = splitPipeLine(line);
    const id = field(fields, CM.CMTE_ID);
    const name = field(fields, CM.CMTE_NM);
    if (id && name) map.set(id, name);
  }
  return map;
}
