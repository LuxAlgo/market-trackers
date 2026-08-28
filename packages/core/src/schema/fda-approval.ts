import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One drug-application submission event from openFDA's Drugs@FDA endpoint
 * (free; an optional free key raises rate limits). Rows are submission
 * events (original approvals and supplements) with their FDA status —
 * registry facts only, no editorial decision calendar.
 */

export const fdaApprovalSchema = z.object({
  /** Natural key: `${applicationNumber}:${submissionType}:${submissionNumber}`. */
  id: z.string().min(1),
  /** e.g. "NDA021436", "BLA125514". */
  applicationNumber: z.string().min(1),
  sponsor: z.object({
    name: z.string().min(1),
    tickers: z.array(z.string()),
  }),
  /** First-listed brand name where published; null otherwise. */
  brandName: z.string().nullable(),
  /** Raw submission type (e.g. "ORIG", "SUPPL"). */
  submissionType: z.string().min(1),
  submissionNumber: z.string().min(1),
  /** Raw FDA status code (e.g. "AP" approved, "TA" tentative approval); null when absent. */
  submissionStatus: z.string().nullable(),
  /** Status date (YYYY-MM-DD). */
  statusDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provenance: provenanceSchema,
});

export type FdaApproval = z.infer<typeof fdaApprovalSchema>;

export function fdaApprovalId(
  applicationNumber: string,
  submissionType: string,
  submissionNumber: string,
): string {
  return `${applicationNumber}:${submissionType}:${submissionNumber}`;
}
