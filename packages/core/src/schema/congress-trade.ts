import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * A single transaction row from a congressional Periodic Transaction Report
 * (Senate eFD or House Clerk financial disclosures).
 *
 * Disclosed amounts are ranges, not exact values. LuxAlgo Market Trackers stores the range
 * bounds verbatim and never fabricates a midpoint — `amountMax` is null for
 * open-ended top ranges ("Over $50,000,000").
 */

export const CHAMBERS = ["senate", "house"] as const;
export type Chamber = (typeof CHAMBERS)[number];

export const congressAssetTypeSchema = z.enum([
  "stock",
  "option",
  "bond",
  "crypto",
  "fund",
  "other",
]);

export const congressTradeSchema = z.object({
  /** Natural key: `${chamber}:${docId}:${rowIndex}`. */
  id: z.string().min(1),
  chamber: z.enum(CHAMBERS),
  /** Filing document id as assigned by the source system. */
  docId: z.string().min(1),
  /** 0-based row index within the filing. */
  rowIndex: z.number().int().nonnegative(),
  member: z.object({
    /** Name as printed on the filing, verbatim. */
    name: z.string().min(1),
    /** Canonical id from the unitedstates/congress-legislators dataset; null when unresolved. */
    bioguideId: z.string().nullable(),
    party: z.string().nullable(),
    state: z.string().nullable(),
  }),
  /** Date the report was filed (YYYY-MM-DD). */
  filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Date the transaction occurred (YYYY-MM-DD). */
  transactedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Heuristically extracted ticker; null when the asset description is unresolvable. */
  ticker: z.string().nullable(),
  /** Asset description verbatim from the filing. */
  assetDescription: z.string().min(1),
  assetType: congressAssetTypeSchema,
  side: z.enum(["buy", "sell", "exchange"]),
  amountRange: z.object({
    min: z.number().nonnegative(),
    /** Null for open-ended ranges ("Over $50,000,000"). */
    max: z.number().nonnegative().nullable(),
    /** The range exactly as printed on the filing. */
    text: z.string().min(1),
  }),
  owner: z.enum(["self", "spouse", "joint", "dependent"]).nullable(),
  provenance: provenanceSchema,
});

export type CongressTrade = z.infer<typeof congressTradeSchema>;

export function congressTradeId(chamber: Chamber, docId: string, rowIndex: number): string {
  return `${chamber}:${docId}:${rowIndex}`;
}
