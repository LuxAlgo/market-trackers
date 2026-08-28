import { z } from "zod";

/**
 * Every record LuxAlgo Alt Data stores or publishes carries provenance: which primary
 * source it came from, a deep link to the primary document, when it was
 * retrieved, which parser produced it, and how much that parser is trusted.
 *
 * This is the credibility contract of the whole project. Rows without a
 * working primary-source URL do not ship.
 */

export const SOURCE_IDS = [
  "edgar",
  "senate-efd",
  "house-clerk",
  "usaspending",
  "lda",
  "finra",
  "congress-legislators",
  "patentsview",
  "clinicaltrials",
  "openfda",
  "cftc",
  "wikimedia",
  "govinfo",
  "fec",
  "govinfo-hearings",
  "federalreserve",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export const sourceIdSchema = z.enum(SOURCE_IDS);

/**
 * Parser confidence tiers:
 *  - 1    structured data (XML/JSON straight from the source)
 *  - 0.9  layout-parsed (HTML tables, text-layer PDFs with a known layout)
 *  - 0.7  OCR/LLM-assisted extraction from scans — always `needsReview`-eligible
 */
export const confidenceSchema = z.union([z.literal(1), z.literal(0.9), z.literal(0.7)]);

export const provenanceSchema = z.object({
  source: sourceIdSchema,
  /** Deep link to the primary document this row was extracted from. */
  sourceUrl: z.string().url(),
  /** ISO-8601 timestamp of the fetch that produced this row. */
  retrievedAt: z.string().datetime(),
  /** Parser identity + version, e.g. "form-ownership-xml@1" — bump on behavior change. */
  parser: z.string().min(1),
  confidence: confidenceSchema,
  /** True when a human (or higher-confidence re-parse) should verify this row. */
  needsReview: z.boolean(),
});

export type Provenance = z.infer<typeof provenanceSchema>;
