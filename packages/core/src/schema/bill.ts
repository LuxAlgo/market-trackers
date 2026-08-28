import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One piece of federal legislation, from GPO GovInfo's bulk BILLSTATUS XML
 * (keyless). Status facts only, verbatim from the record — no odds of
 * passage, no editorial summaries.
 */

export const billSchema = z.object({
  /** Natural key: `${congress}-${billType}-${billNumber}`, e.g. "119-hr-1234". */
  id: z.string().min(1),
  congress: z.number().int().positive(),
  /** Lowercase bill type as GovInfo codes it: hr, s, hjres, sjres, hconres, sconres, hres, sres. */
  billType: z.string().regex(/^[a-z]+$/),
  billNumber: z.number().int().positive(),
  /** Official title, verbatim (long). */
  title: z.string().min(1),
  introducedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  latestActionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Latest action text verbatim from the status record. */
  latestActionText: z.string().nullable(),
  sponsorBioguideId: z.string().nullable(),
  sponsorName: z.string().nullable(),
  /** CRS policy area, verbatim (e.g. "Armed Forces and National Security"). */
  policyArea: z.string().nullable(),
  cosponsorCount: z.number().int().nonnegative(),
  provenance: provenanceSchema,
});

export type Bill = z.infer<typeof billSchema>;

export function billId(congress: number, billType: string, billNumber: number): string {
  return `${congress}-${billType}-${billNumber}`;
}

/**
 * Normalized bill token used to link other datasets (e.g. lobbying filings)
 * to legislation by textual reference: `"hr1234"`, `"s567"`, `"hjres45"`.
 * Congress-agnostic on purpose — free-text mentions rarely say which
 * congress, so the token matches by type+number and consumers scope by year.
 */
export function billReferenceToken(billType: string, billNumber: number): string {
  return `${billType.toLowerCase()}${billNumber}`;
}
