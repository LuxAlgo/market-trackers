import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * A federal award from USAspending. Recipient→ticker mapping is best-effort
 * against a curated map of public-company subsidiaries; unmatched recipients
 * are stored with an empty `tickers` array — resolution improves over time
 * without re-ingesting.
 */

export const govContractAwardSchema = z.object({
  /** Natural key: USAspending generated internal award id. */
  id: z.string().min(1),
  /** Human-facing award id (PIID/FAIN) when available. */
  awardId: z.string().nullable(),
  awardType: z.string().nullable(),
  agency: z.string().min(1),
  subAgency: z.string().nullable(),
  recipient: z.object({
    name: z.string().min(1),
    uei: z.string().nullable(),
    /** Public-company tickers this recipient maps to; empty when unresolved. */
    tickers: z.array(z.string()),
  }),
  /** Total obligated amount in USD. */
  amountUsd: z.number().nullable(),
  /**
   * Award date (YYYY-MM-DD): the signing date of the award's base transaction
   * (USAspending "Base Obligation Date"), falling back to the
   * period-of-performance start when the record carries no signing date.
   */
  actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().nullable(),
  naicsCode: z.string().nullable(),
  naicsDescription: z.string().nullable(),
  provenance: provenanceSchema,
});

export type GovContractAward = z.infer<typeof govContractAwardSchema>;
