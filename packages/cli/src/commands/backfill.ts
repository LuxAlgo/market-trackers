import type { GlobalFlags } from "../context.js";

export interface BackfillFlags extends GlobalFlags {
  source?: string;
  from?: string;
  to?: string;
  chunkDays?: string;
  limit?: string;
}

/**
 * Deep-history backfill orchestrator (chunked, resumable, watermark-driven).
 * Command stub — the engine lands with the backfill implementation.
 */
export async function backfillCommand(_flags: BackfillFlags): Promise<number> {
  process.stderr.write(
    "docket backfill is not implemented in this build yet — see docs/backfill.md\n",
  );
  return 1;
}
