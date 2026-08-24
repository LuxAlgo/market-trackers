import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One holding row from a 13F-HR information table (quarterly institutional
 * holdings, EDGAR).
 *
 * Natural key is accession + row index rather than accession + CUSIP:
 * real information tables can legitimately repeat a CUSIP (e.g. the same
 * security split across put/call columns or investment-discretion buckets).
 *
 * Note: `valueUsd` is normalized to whole dollars. Filings for periods before
 * 2023-01-01 report value in thousands; the parser normalizes by era.
 */

export const thirteenfHoldingSchema = z.object({
  /** Natural key: `${accessionNumber}:${rowIndex}`. */
  id: z.string().min(1),
  accessionNumber: z.string().min(1),
  managerCik: z.string().min(1),
  managerName: z.string().min(1),
  /** Reporting period end (YYYY-MM-DD). */
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cusip: z.string().min(1),
  /** Resolved via cached CUSIP→ticker mapping; null until resolvable. */
  ticker: z.string().nullable(),
  issuerName: z.string().min(1),
  /** SH (shares) or PRN (principal amount) — raw from the filing. */
  shareType: z.enum(["SH", "PRN"]).nullable(),
  shares: z.number(),
  valueUsd: z.number(),
  putCall: z.enum(["put", "call"]).nullable(),
  provenance: provenanceSchema,
});

export type ThirteenfHolding = z.infer<typeof thirteenfHoldingSchema>;

export function thirteenfHoldingId(accessionNumber: string, rowIndex: number): string {
  return `${accessionNumber}:${rowIndex}`;
}
