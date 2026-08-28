import type { SourceId } from "../schema/provenance.js";
import type { SourceContext } from "../sources/types.js";
import { deriveCanaryStatus } from "../sources/types.js";
import { ALL_SOURCES, sourceById } from "../sources/registry.js";
import type { CanaryRunRecord, CanaryStatus } from "../store/store.js";

/**
 * The canary runner — the maintenance machine that keeps rot visible.
 * Per source: fetch probes, parse-success-rate assertions, structural
 * fingerprints (format drift turns red before a parser silently misparses),
 * and dataset freshness. Results are recorded in the store and reported as
 * JSON for CI to publish and act on.
 */

export interface CanaryReport {
  generatedAt: string;
  overall: CanaryStatus;
  sources: CanaryRunRecord[];
}

function worst(statuses: CanaryStatus[]): CanaryStatus {
  if (statuses.includes("red")) return "red";
  if (statuses.includes("amber")) return "amber";
  if (statuses.includes("green")) return "green";
  return "skip";
}

export async function runCanaries(
  ctx: SourceContext,
  options: { sources?: SourceId[] } = {},
): Promise<CanaryReport> {
  const sources = options.sources ? options.sources.map((id) => sourceById(id)) : ALL_SOURCES;

  const records: CanaryRunRecord[] = [];
  for (const source of sources) {
    let record: CanaryRunRecord;
    try {
      const outcome = await source.canary(ctx);
      const status = deriveCanaryStatus(source.implemented, outcome.checks);
      record = await ctx.store.recordCanaryRun({
        source: source.id,
        status,
        checks: outcome.checks.map(({ name, ok, note }) => ({
          name,
          ok,
          ...(note ? { note } : {}),
        })),
      });
    } catch (error) {
      record = await ctx.store.recordCanaryRun({
        source: source.id,
        status: source.implemented ? "red" : "skip",
        checks: [
          {
            name: "canary-exec",
            ok: false,
            note: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
    ctx.logger.info(`canary ${source.id}: ${record.status}`);
    records.push(record);
  }

  return {
    generatedAt: new Date().toISOString(),
    overall: worst(records.map((r) => r.status)),
    sources: records,
  };
}
