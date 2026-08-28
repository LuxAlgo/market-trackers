import type { DatasetId } from "../schema/datasets.js";
import type { SourceId } from "../schema/provenance.js";
import type { TrackerSource, SourceContext, SourceSyncResult } from "./types.js";
import { emptySyncResult } from "./types.js";

/**
 * Factory for sources whose ingestors aren't built yet. They participate in
 * the registry, sync as an explicit no-op (never silently), and canary as
 * `skip` — so `market-trackers status` and the health board always tell the truth
 * about what this build ingests.
 */
export function scaffoldSource(options: {
  id: SourceId;
  title: string;
  datasets: DatasetId[];
}): TrackerSource {
  return {
    id: options.id,
    title: options.title,
    datasets: options.datasets,
    implemented: false,

    async sync(ctx: SourceContext): Promise<SourceSyncResult> {
      const result = emptySyncResult(options.id, false);
      result.notes.push(`source '${options.id}' is not implemented in this build yet`);
      ctx.logger.warn(`skipping '${options.id}': ingestor not implemented yet`);
      return result;
    },

    async canary() {
      return { checks: [] };
    },
  };
}
