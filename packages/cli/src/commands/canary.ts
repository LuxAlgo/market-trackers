import { writeFileSync } from "node:fs";
import { runCanaries, isSourceId, type SourceId } from "@luxalgo/alt-data-core";
import { openContext, printJson, printTable, type GlobalFlags } from "../context.js";

export interface CanaryFlags extends GlobalFlags {
  source?: string;
  out?: string;
}

export async function canaryCommand(flags: CanaryFlags): Promise<number> {
  const ctx = await openContext(flags);
  try {
    const sources = flags.source
      ? (flags.source.split(",").map((raw) => {
          const id = raw.trim();
          if (!isSourceId(id)) throw new Error(`Unknown source '${id}'`);
          return id;
        }) as SourceId[])
      : undefined;

    const report = await runCanaries(ctx, { sources });
    if (flags.out) writeFileSync(flags.out, JSON.stringify(report, null, 2) + "\n");

    if (flags.json) {
      printJson(report);
    } else {
      printTable(
        ["source", "status", "checks"],
        report.sources.map((s) => [
          s.source,
          s.status,
          s.checks
            .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.note ? ` (${c.note})` : ""}`)
            .join("; ") || "—",
        ]),
      );
      process.stdout.write(`\noverall: ${report.overall}\n`);
    }
    // Red is a failure for CI; amber (stale-but-working) and skip are not.
    return report.overall === "red" ? 1 : 0;
  } finally {
    await ctx.close();
  }
}
