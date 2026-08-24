import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One symbol-day of FINRA Reg SHO daily short-sale volume.
 *
 * `shortRatio` is plain arithmetic (shortVolume / totalVolume), not a signal.
 * FINRA moved to decimal volume formats effective 2026-02-23; the parser
 * accepts both eras, so backfills and current files normalize identically.
 */

export const shortVolumeDaySchema = z.object({
  /** Natural key: `${date}:${ticker}:${market}`. */
  id: z.string().min(1),
  /** Trade date (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ticker: z.string().min(1),
  /** Market/file identifier as published by FINRA (e.g. "CNMS"), plus the per-row market field when present. */
  market: z.string().min(1),
  shortVolume: z.number().nonnegative(),
  shortExemptVolume: z.number().nonnegative(),
  totalVolume: z.number().nonnegative(),
  /** shortVolume / totalVolume, null when totalVolume is 0. */
  shortRatio: z.number().nullable(),
  provenance: provenanceSchema,
});

export type ShortVolumeDay = z.infer<typeof shortVolumeDaySchema>;

export function shortVolumeDayId(date: string, ticker: string, market: string): string {
  return `${date}:${ticker}:${market}`;
}
