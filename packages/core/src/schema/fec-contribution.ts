import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One committee→candidate contribution from the FEC's keyless bulk downloads
 * (the "contributions to candidates from committees" file). Amounts are the
 * filed numbers, verbatim; refunds appear as negative amounts, as filed.
 */

export const fecContributionSchema = z.object({
  /** Natural key: the FEC's unique record id for the transaction (SUB_ID). */
  id: z.string().min(1),
  committeeId: z.string().min(1),
  /** Committee name from the committee master file; null when unjoined. */
  committeeName: z.string().nullable(),
  candidateId: z.string().min(1),
  /** Candidate name from the candidate master file; null when unjoined. */
  candidateName: z.string().nullable(),
  amountUsd: z.number(),
  /** Transaction date; null when the bulk record's date is blank or invalid. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** FEC transaction type code verbatim (e.g. "24K"). */
  transactionType: z.string().min(1),
  /** Two-year election cycle the bulk file covers (even year). */
  cycle: z.number().int(),
  provenance: provenanceSchema,
});

export type FecContribution = z.infer<typeof fecContributionSchema>;
