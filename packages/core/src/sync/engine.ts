import type { SourceId } from "../schema/provenance.js";
import type {
  DocketSource,
  SourceContext,
  SourceSyncResult,
  SyncOptions,
} from "../sources/types.js";
import { ALL_SOURCES, sourceById } from "../sources/registry.js";

/**
 * The sync engine: runs sources sequentially (rate limits are per-origin;
 * parallel sources would still be polite, but sequential keeps logs and
 * failure attribution readable), records every run in the store, and never
 * lets one source's failure stop the others.
 */

export interface SyncSummary {
  ok: boolean;
  results: (SourceSyncResult & { error?: string })[];
}

export interface RunSyncOptions extends SyncOptions {
  /** Restrict to these sources; defaults to all implemented sources. */
  sources?: SourceId[];
}

export function selectSources(sourceIds?: SourceId[]): DocketSource[] {
  if (!sourceIds || sourceIds.length === 0) {
    return ALL_SOURCES.filter((s) => s.implemented);
  }
  return sourceIds.map((id) => sourceById(id));
}

export async function runSync(ctx: SourceContext, opts: RunSyncOptions = {}): Promise<SyncSummary> {
  const sources = selectSources(opts.sources);
  const results: (SourceSyncResult & { error?: string })[] = [];
  let ok = true;

  for (const source of sources) {
    const runId = await ctx.store.startSyncRun(source.id);
    try {
      const result = await source.sync(ctx, opts);
      await ctx.store.finishSyncRun(runId, {
        ok: true,
        rowsUpserted: result.rowsUpserted,
        parseAttempted: result.parse.attempted,
        parseSucceeded: result.parse.succeeded,
        details: { perDataset: result.perDataset, notes: result.notes },
      });
      results.push(result);
      ctx.logger.info(
        `${source.id}: ${result.rowsUpserted} rows upserted` +
          (result.notes.length ? ` (${result.notes.join("; ")})` : ""),
      );
    } catch (error) {
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      await ctx.store.finishSyncRun(runId, {
        ok: false,
        rowsUpserted: 0,
        parseAttempted: 0,
        parseSucceeded: 0,
        error: message,
      });
      ctx.logger.error(`${source.id}: sync failed — ${message}`);
      results.push({
        source: source.id,
        implemented: source.implemented,
        rowsUpserted: 0,
        parse: { attempted: 0, succeeded: 0 },
        perDataset: {},
        notes: [],
        error: message,
      });
    }
  }

  return { ok, results };
}
