import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * A lobbying disclosure filing from the Senate LDA REST API.
 * Client→ticker mapping follows the same curated-map approach as contracts.
 */

export const lobbyingFilingSchema = z.object({
  /** Natural key: LDA filing UUID. */
  id: z.string().min(1),
  filingUuid: z.string().min(1),
  registrant: z.object({
    name: z.string().min(1),
  }),
  client: z.object({
    name: z.string().min(1),
    /** Public-company tickers this client maps to; empty when unresolved. */
    tickers: z.array(z.string()),
  }),
  /** Reported income or expenses in USD; null when the filing reports none. */
  amountUsd: z.number().nullable(),
  filingYear: z.number().int(),
  /** Filing period exactly as coded by the LDA (e.g. "first_quarter"). */
  filingPeriod: z.string().min(1),
  filingType: z.string().nullable(),
  /** General issue codes lobbied on (e.g. "TAX", "HCR"). */
  issues: z.array(z.string()),
  provenance: provenanceSchema,
});

export type LobbyingFiling = z.infer<typeof lobbyingFilingSchema>;
