import { exportDumps, isDatasetId, type DatasetId } from "@luxalgo/alt-data-core";
import { openContext, printJson, type GlobalFlags } from "../context.js";

export interface ExportFlags extends GlobalFlags {
  out?: string;
  dataset?: string;
  snapshot?: boolean;
}

export async function exportCommand(flags: ExportFlags): Promise<number> {
  const ctx = await openContext(flags);
  try {
    const datasets = flags.dataset
      ? (flags.dataset.split(",").map((raw) => {
          const id = raw.trim();
          if (!isDatasetId(id)) throw new Error(`Unknown dataset '${id}'`);
          return id;
        }) as DatasetId[])
      : undefined;

    const summary = await exportDumps(ctx.store, {
      outDir: flags.out ?? "dumps",
      datasets,
      snapshot: flags.snapshot,
      logger: ctx.logger,
    });

    if (flags.json) {
      printJson(summary);
    } else {
      process.stdout.write(`exported ${summary.filesWritten.length} files to ${summary.outDir}\n`);
      for (const [dataset, rows] of Object.entries(summary.rowTotals)) {
        process.stdout.write(`  ${dataset}: ${rows} rows\n`);
      }
    }
    return 0;
  } finally {
    await ctx.close();
  }
}
