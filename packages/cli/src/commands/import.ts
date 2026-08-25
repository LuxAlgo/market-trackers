import { importDumps, isDatasetId, type DatasetId } from "@luxalgo/alt-data-core";
import { openContext, printJson, type GlobalFlags } from "../context.js";

export interface ImportFlags extends GlobalFlags {
  dataset?: string;
}

/**
 * Rebuild (or top up) a store from published dumps: an alt-datasets checkout,
 * a dataset directory, or a single delta/snapshot file. The mirror image of
 * `alt-data export` — together they make the published data the durable
 * archive.
 */
export async function importCommand(path: string, flags: ImportFlags): Promise<number> {
  const ctx = await openContext(flags);
  try {
    let dataset: DatasetId | undefined;
    if (flags.dataset) {
      if (!isDatasetId(flags.dataset)) throw new Error(`Unknown dataset '${flags.dataset}'`);
      dataset = flags.dataset;
    }
    const summary = await importDumps(ctx.store, path, { dataset, logger: ctx.logger });
    if (flags.json) {
      printJson(summary);
    } else {
      process.stdout.write(`imported ${summary.rows} rows from ${summary.files} files\n`);
      for (const [id, rows] of Object.entries(summary.perDataset)) {
        process.stdout.write(`  ${id}: ${rows} rows\n`);
      }
    }
    return 0;
  } finally {
    await ctx.close();
  }
}
