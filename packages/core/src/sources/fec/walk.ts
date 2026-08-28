import type { Logger } from "../../lib/logger.js";

/**
 * Batch size for upserts while walking a large pipe-delimited bulk file —
 * `itpas2.txt` can be hundreds of thousands of lines, so this keeps memory
 * bounded to one batch of parsed records at a time rather than holding the
 * whole file's rows in an array before storing any of them.
 */
export const WALK_BATCH_SIZE = 2_000;

export interface WalkOutcome {
  attempted: number;
  succeeded: number;
  upserted: number;
  /** True when `limit` stopped the walk before EOF — callers must not
   *  advance any completed-walk watermark when this is true. */
  limitHit: boolean;
  /** The first non-empty line seen, for fingerprinting — captured even
   *  when `limit` is 0 and nothing is actually attempted. */
  firstLine: string | null;
}

/**
 * Parses `text` line by line (blank lines skipped), normalizing each with
 * `normalize` and flushing successfully-parsed rows to `upsertBatch` every
 * {@link WALK_BATCH_SIZE} rows, so the caller never holds more than one
 * batch of parsed records in memory regardless of the file's total size.
 *
 * A line that throws is counted as attempted-but-not-succeeded and logged
 * — never re-thrown — so one malformed line can never abort an otherwise
 * good multi-hundred-thousand-line file.
 */
export async function walkPipeFile<T>(
  text: string,
  limit: number,
  normalize: (line: string) => T,
  upsertBatch: (rows: T[]) => Promise<number>,
  logger: Logger,
): Promise<WalkOutcome> {
  const outcome: WalkOutcome = {
    attempted: 0,
    succeeded: 0,
    upserted: 0,
    limitHit: false,
    firstLine: null,
  };
  let batch: T[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (outcome.firstLine === null) outcome.firstLine = line;
    if (outcome.attempted >= limit) {
      outcome.limitHit = true;
      break;
    }
    outcome.attempted += 1;
    try {
      batch.push(normalize(line));
      outcome.succeeded += 1;
    } catch (error) {
      logger.warn("row failed to normalize", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (batch.length >= WALK_BATCH_SIZE) {
      outcome.upserted += await upsertBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    outcome.upserted += await upsertBatch(batch);
  }
  return outcome;
}
