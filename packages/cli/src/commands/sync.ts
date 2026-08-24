import {
  runSync,
  isSourceId,
  isDatasetId,
  type DatasetId,
  type SourceId,
} from "@luxalgo/docket-core";
import { openContext, printJson, type GlobalFlags } from "../context.js";

export interface SyncFlags extends GlobalFlags {
  source?: string;
  dataset?: string;
  since?: string;
  full?: boolean;
  limit?: string;
}

function parseSources(input?: string): SourceId[] | undefined {
  if (!input) return undefined;
  return input.split(",").map((raw) => {
    const id = raw.trim();
    if (!isSourceId(id)) throw new Error(`Unknown source '${id}'`);
    return id;
  });
}

function parseDatasets(input?: string): DatasetId[] | undefined {
  if (!input) return undefined;
  return input.split(",").map((raw) => {
    const id = raw.trim();
    if (!isDatasetId(id)) throw new Error(`Unknown dataset '${id}'`);
    return id;
  });
}

export async function syncCommand(flags: SyncFlags): Promise<number> {
  const ctx = await openContext(flags);
  try {
    const summary = await runSync(ctx, {
      sources: parseSources(flags.source),
      datasets: parseDatasets(flags.dataset),
      since: flags.since,
      full: flags.full,
      limit: flags.limit ? Number(flags.limit) : undefined,
    });
    if (flags.json) {
      printJson(summary);
    } else {
      for (const result of summary.results) {
        const status = result.error
          ? `FAILED: ${result.error}`
          : result.implemented
            ? `${result.rowsUpserted} rows upserted`
            : "skipped (not implemented yet)";
        process.stdout.write(`${result.source.padEnd(12)} ${status}\n`);
        for (const note of result.notes) process.stdout.write(`${"".padEnd(12)} note: ${note}\n`);
      }
    }
    return summary.ok ? 0 : 1;
  } finally {
    await ctx.close();
  }
}
