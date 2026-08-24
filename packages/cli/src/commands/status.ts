import { freshnessReport, ALL_SOURCES } from "@luxalgo/docket-core";
import { openContext, printJson, printTable, type GlobalFlags } from "../context.js";

export async function statusCommand(flags: GlobalFlags): Promise<number> {
  const ctx = await openContext(flags);
  try {
    const report = await freshnessReport(ctx.store);
    if (flags.json) {
      printJson(report);
      return 0;
    }

    process.stdout.write(`store: ${ctx.config.db}\n\ndatasets\n`);
    printTable(
      ["dataset", "rows", "last ingested", "age (h)", "window (h)", "state"],
      report.datasets.map((d) => [
        d.dataset,
        String(d.rowCount),
        d.lastIngestedAt ?? "—",
        d.ageHours === null ? "—" : String(d.ageHours),
        String(d.freshnessWindowHours),
        d.rowCount === 0 ? "empty" : d.stale ? "stale" : "fresh",
      ]),
    );

    process.stdout.write("\nsources\n");
    printTable(
      ["source", "implemented", "last sync", "sync ok", "parse rate", "last canary"],
      report.sources.map((s) => {
        const impl = ALL_SOURCES.find((src) => src.id === s.source)?.implemented ?? false;
        const parseRate =
          s.lastSync && s.lastSync.parseAttempted > 0
            ? `${((s.lastSync.parseSucceeded / s.lastSync.parseAttempted) * 100).toFixed(1)}%`
            : "—";
        return [
          s.source,
          impl ? "yes" : "not yet",
          s.lastSync?.startedAt ?? "—",
          s.lastSync === null ? "—" : s.lastSync.ok === null ? "running" : String(s.lastSync.ok),
          parseRate,
          s.lastCanary ? `${s.lastCanary.status} (${s.lastCanary.ranAt})` : "—",
        ];
      }),
    );

    const watermarks = report.sources.flatMap((s) =>
      s.watermarks.map((w) => [s.source, w.key, w.value] as string[]),
    );
    if (watermarks.length > 0) {
      process.stdout.write("\nwatermarks\n");
      printTable(["source", "key", "value"], watermarks);
    }
    return 0;
  } finally {
    await ctx.close();
  }
}
