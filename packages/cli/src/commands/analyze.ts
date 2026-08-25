import type { GlobalFlags } from "../context.js";

export interface AnalyzeFlags extends GlobalFlags {
  prices?: string;
  dataset?: string;
  ticker?: string;
  member?: string;
  since?: string;
  window?: string;
  out?: string;
}

/**
 * Bring-your-own-prices factual joins (e.g. price change since a disclosed
 * trade's filing date, computed from a user-supplied prices file). Docket
 * ships no price data and no scores — this command only does arithmetic
 * between public-record rows and the caller's own price series.
 * Command stub — the analytics module lands with the implementation.
 */
export async function analyzeCommand(_what: string, _flags: AnalyzeFlags): Promise<number> {
  process.stderr.write(
    "docket analyze is not implemented in this build yet — see docs/analytics.md\n",
  );
  return 1;
}
