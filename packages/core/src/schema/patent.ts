import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One granted US patent from the PatentsView PatentSearch API (USPTO data;
 * a free API key is required by the provider). Assignee→ticker mapping is
 * best-effort via the curated public-company map; unmapped assignees keep
 * `tickers: []`.
 */

export const patentSchema = z.object({
  /** Natural key: the PatentsView patent_id (the patent number). */
  id: z.string().min(1),
  patentId: z.string().min(1),
  title: z.string().min(1),
  /** Grant date (YYYY-MM-DD). */
  grantDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignee: z.object({
    /** First-listed assignee organization; null for unassigned/individual patents. */
    name: z.string().nullable(),
    tickers: z.array(z.string()),
  }),
  /** Total assignees on the patent. */
  assigneeCount: z.number().int().nonnegative(),
  /** Patent kind code as published (e.g. "B2"); null when absent. */
  kind: z.string().nullable(),
  /** First CPC section/class id where published (e.g. "H04"); null when absent. */
  cpcClass: z.string().nullable(),
  provenance: provenanceSchema,
});

export type Patent = z.infer<typeof patentSchema>;
