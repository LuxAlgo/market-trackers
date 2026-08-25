import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One market-week of the CFTC Commitments of Traders report (legacy
 * futures-only), from the CFTC's public reporting Socrata API. Positions are
 * published numbers, verbatim; net positioning is left to the reader.
 */

export const cotReportSchema = z.object({
  /** Natural key: `${reportDate}:${contractCode}`. */
  id: z.string().min(1),
  /** Report date (YYYY-MM-DD, Tuesdays). */
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** CFTC contract market code, e.g. "067651". */
  contractCode: z.string().min(1),
  /** Market and exchange name verbatim, e.g. "CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE". */
  marketName: z.string().min(1),
  openInterest: z.number().nonnegative(),
  commercialLong: z.number().nonnegative(),
  commercialShort: z.number().nonnegative(),
  nonCommercialLong: z.number().nonnegative(),
  nonCommercialShort: z.number().nonnegative(),
  nonReportableLong: z.number().nonnegative(),
  nonReportableShort: z.number().nonnegative(),
  provenance: provenanceSchema,
});

export type CotReport = z.infer<typeof cotReportSchema>;

export function cotReportId(reportDate: string, contractCode: string): string {
  return `${reportDate}:${contractCode}`;
}
