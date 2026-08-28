import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One article-day of Wikipedia pageviews, from the Wikimedia REST pageviews
 * API (keyless; the underlying counts are released under CC0). Attention is
 * a public, measurable fact — what it means is left to the reader.
 */

export const wikiPageviewSchema = z.object({
  /** Natural key: `${project}:${article}:${day}`. */
  id: z.string().min(1),
  /** Wikimedia project, e.g. "en.wikipedia". */
  project: z.string().min(1),
  /** Canonical article title in URL form (underscores), e.g. "Nvidia". */
  article: z.string().min(1),
  /** The day the views were counted (YYYY-MM-DD, UTC). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  views: z.number().int().nonnegative(),
  /** Tickers this article maps to via the curated article map; empty when unmapped. */
  tickers: z.array(z.string()),
  provenance: provenanceSchema,
});

export type WikiPageview = z.infer<typeof wikiPageviewSchema>;

export function wikiPageviewId(project: string, article: string, day: string): string {
  return `${project}:${article}:${day}`;
}
