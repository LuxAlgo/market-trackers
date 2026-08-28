import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One candidate-cycle of FEC campaign-finance summary data, from the FEC's
 * keyless bulk downloads (candidate master + "all candidates" summary).
 * Totals are the FEC's own published numbers, verbatim.
 */

export const fecCandidateSchema = z.object({
  /** Natural key: `${candidateId}:${cycle}`, e.g. "H8CA05035:2026". */
  id: z.string().min(1),
  /** FEC candidate id. */
  candidateId: z.string().min(1),
  /** Two-year election cycle (even year). */
  cycle: z.number().int(),
  name: z.string().min(1),
  /** Party code verbatim from the FEC (e.g. "DEM", "REP"); null when absent. */
  party: z.string().nullable(),
  /** Office sought: H (House), S (Senate), P (President). */
  office: z.enum(["H", "S", "P"]),
  state: z.string().nullable(),
  district: z.string().nullable(),
  /** Incumbent/challenger/open-seat code verbatim ("I"/"C"/"O"); null when absent. */
  incumbentChallenger: z.string().nullable(),
  totalReceipts: z.number().nullable(),
  totalDisbursements: z.number().nullable(),
  cashOnHand: z.number().nullable(),
  coverageEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  provenance: provenanceSchema,
});

export type FecCandidate = z.infer<typeof fecCandidateSchema>;

export function fecCandidateId(candidateId: string, cycle: number): string {
  return `${candidateId}:${cycle}`;
}
