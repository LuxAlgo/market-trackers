import { isSourceId, runBackfill, selectSources, type SourceId } from "@luxalgo/docket-core";
import { openContext, printJson, type GlobalFlags } from "../context.js";

export interface BackfillFlags extends GlobalFlags {
  source?: string;
  from?: string;
  to?: string;
  chunkDays?: string;
  limit?: string;
  full?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseSources(input?: string): SourceId[] {
  if (!input) return selectSources().map((s) => s.id);
  return input.split(",").map((raw) => {
    const id = raw.trim();
    if (!isSourceId(id)) throw new Error(`Unknown source '${id}'`);
    return id;
  });
}

function parseDate(label: string, value: string): string {
  if (!DATE_RE.test(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD date, got '${value}'`);
  }
  return value;
}

function parsePositiveInt(label: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

/**
 * Deep-history backfill orchestrator: chunked, resumable, watermark-driven
 * walks as far back as each free source's history allows (see
 * docs/backfill.md). All the chunking/resume logic lives in
 * `runBackfill` (`packages/core/src/backfill/engine.ts`) — this command is
 * just flag parsing and reporting.
 */
export async function backfillCommand(flags: BackfillFlags): Promise<number> {
  if (!flags.from) {
    throw new Error("--from is required (YYYY-MM-DD) — see docs/backfill.md");
  }
  const sources = parseSources(flags.source);
  const from = parseDate("--from", flags.from);
  const to = flags.to ? parseDate("--to", flags.to) : undefined;
  if (to && to < from) {
    throw new Error(`--to (${to}) is before --from (${from})`);
  }
  const chunkDays = flags.chunkDays ? parsePositiveInt("--chunk-days", flags.chunkDays) : undefined;
  const limit = flags.limit ? parsePositiveInt("--limit", flags.limit) : undefined;

  const ctx = await openContext(flags);
  try {
    const summary = await runBackfill(ctx, {
      sources,
      from,
      to,
      chunkDays,
      limit,
      full: flags.full,
    });

    if (flags.json) {
      printJson(summary);
    } else {
      process.stdout.write(
        `backfill ${summary.from}..${summary.to} (chunkDays=${summary.chunkDays})\n`,
      );
      for (const result of summary.sources) {
        if (result.skipped) {
          process.stdout.write(`${result.source.padEnd(20)} skipped — ${result.skippedReason}\n`);
          continue;
        }
        const status = result.complete ? "complete" : `stopped early (${result.stoppedReason})`;
        process.stdout.write(
          `${result.source.padEnd(20)} ${String(result.chunks.length).padStart(3)} chunk(s), ` +
            `${result.rowsUpserted} rows upserted — ${status}` +
            (result.completedThrough ? `, resumable from ${result.completedThrough}` : "") +
            "\n",
        );
      }
      if (!summary.ok) {
        process.stdout.write(
          "\nStopped before reaching --to. Re-run the same command (same --from) to resume — " +
            "each source picks up right after its last completed chunk.\n",
        );
      }
    }
    return summary.ok ? 0 : 1;
  } finally {
    await ctx.close();
  }
}
