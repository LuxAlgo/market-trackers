import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One transaction (or holding) row parsed from a SEC Form 3, 4, or 5
 * ownership document — the primary XML inside the EDGAR filing archive,
 * never the HTML rendering.
 *
 * Transaction codes are kept raw (P, S, A, M, G, F, C, …); consumers get a
 * legend rather than a lossy re-classification.
 */

export const insiderTransactionSchema = z.object({
  /** Natural key: `${accessionNumber}:${nd|d}:${rowIndex}` (non-derivative vs derivative table). */
  id: z.string().min(1),
  /** EDGAR accession number, dashed form (e.g. "0000320193-24-000001"). */
  accessionNumber: z.string().min(1),
  formType: z.enum(["3", "4", "5", "3/A", "4/A", "5/A"]),
  /** Issuer trading symbol as reported; resolved from CIK when the filing omits it. */
  ticker: z.string().nullable(),
  issuerCik: z.string().min(1),
  issuerName: z.string().min(1),
  insider: z.object({
    name: z.string().min(1),
    cik: z.string().min(1),
    title: z.string().nullable(),
    isDirector: z.boolean(),
    isOfficer: z.boolean(),
    isTenPctOwner: z.boolean(),
  }),
  /** Transaction date (YYYY-MM-DD); null on Form 3 initial-holding rows. */
  transactedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Filing date (YYYY-MM-DD). */
  filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Raw SEC transaction code (P, S, A, M, G, F, C, …); null on Form 3 holding rows. */
  code: z.string().nullable(),
  /** Raw acquired/disposed flag from the filing. */
  acquiredDisposed: z.enum(["A", "D"]).nullable(),
  securityTitle: z.string().min(1),
  shares: z.number().nullable(),
  pricePerShare: z.number().nullable(),
  sharesOwnedAfter: z.number().nullable(),
  ownership: z.enum(["direct", "indirect"]),
  isDerivative: z.boolean(),
  provenance: provenanceSchema,
});

export type InsiderTransaction = z.infer<typeof insiderTransactionSchema>;

export function insiderTransactionId(
  accessionNumber: string,
  table: "nd" | "d",
  rowIndex: number,
): string {
  return `${accessionNumber}:${table}:${rowIndex}`;
}

/**
 * The SEC's transaction-code legend, shipped with the data so consumers never
 * have to guess. Source: SEC Forms 3/4/5 instructions.
 */
export const INSIDER_TRANSACTION_CODES: Record<string, string> = {
  P: "Open market or private purchase of securities",
  S: "Open market or private sale of securities",
  V: "Transaction voluntarily reported earlier than required",
  A: "Grant, award, or other acquisition",
  D: "Sale (or disposition) back to the issuer",
  F: "Payment of exercise price or tax liability by delivering or withholding securities",
  I: "Discretionary transaction, which is an order to the broker to execute the transaction at the best possible price",
  M: "Exercise or conversion of derivative security",
  C: "Conversion of derivative security",
  E: "Expiration of short derivative position",
  H: "Expiration (or cancellation) of long derivative position with value received",
  O: "Exercise of out-of-the-money derivative security",
  X: "Exercise of in-the-money or at-the-money derivative security",
  G: "Bona fide gift",
  L: "Small acquisition",
  W: "Acquisition or disposition by will or the laws of descent and distribution",
  Z: "Deposit into or withdrawal from voting trust",
  J: "Other acquisition or disposition (described in footnotes)",
  K: "Transaction in equity swap or similar instrument",
  U: "Disposition pursuant to a tender of shares in a change of control transaction",
};
