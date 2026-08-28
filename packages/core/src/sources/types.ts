import type { DatasetId } from "../schema/datasets.js";
import type { SourceId } from "../schema/provenance.js";
import type { TrackerConfig } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { CanaryCheck, CanaryStatus, TrackerStore } from "../store/store.js";

/**
 * The source contract. Every ingestor implements this interface and is
 * registered in `registry.ts`; the sync engine, canary runner, CLI, and CI
 * treat all sources uniformly through it.
 */

export interface SourceContext {
  store: TrackerStore;
  config: TrackerConfig;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface SyncOptions {
  /** Re-walk from this date (YYYY-MM-DD) instead of the stored watermark. */
  since?: string;
  /**
   * Stop walking at this date (YYYY-MM-DD, inclusive) — used by the backfill
   * engine to run bounded chunks. Sources that don't walk by date may ignore
   * it; date-walking sources must honor it.
   */
  until?: string;
  /** Ignore watermarks entirely and re-walk as deep as the source allows. */
  full?: boolean;
  /** Restrict to these datasets (a source may produce several). */
  datasets?: DatasetId[];
  /** Soft cap on documents fetched this run — for demos and smoke tests. */
  limit?: number;
  /**
   * Stop starting new work at this epoch-ms deadline and return cleanly,
   * reporting the stop via `SourceSyncResult.stoppedEarly`. The backfill
   * engine sets this so a slow chunk stops INSIDE the run's time budget
   * instead of overrunning into the CI job's hard kill (which forfeits the
   * export, archive, and store-cache save). Sources whose whole sync is one
   * short pass may ignore it; long document-walking sources must honor it.
   */
  deadlineMs?: number;
}

export interface ParseStats {
  attempted: number;
  succeeded: number;
}

export interface SourceSyncResult {
  source: SourceId;
  implemented: boolean;
  rowsUpserted: number;
  parse: ParseStats;
  perDataset: Partial<Record<DatasetId, number>>;
  notes: string[];
  /**
   * Set when the sync stopped itself before covering its whole window: at
   * `SyncOptions.deadlineMs` ("deadline") or at `SyncOptions.limit`
   * ("limit"). Callers that treat a sync as ground covered — the backfill
   * engine advancing `backfill.completedThrough` — must check this instead
   * of assuming a clean return means the window is done.
   */
  stoppedEarly?: "deadline" | "limit";
  /**
   * With `stoppedEarly`, for date-walking sources: the last date
   * (YYYY-MM-DD) fully covered before stopping — the caller's safe resume
   * point. Null when the stop landed before the first day completed.
   */
  completedThrough?: string | null;
}

/**
 * Canary checks carry a severity: a failing `hard` check (fetch broke, parse
 * rate collapsed, page structure fingerprint changed) turns the source red;
 * a failing `soft` check (data older than its freshness window) turns it
 * amber. Green means all checks pass.
 */
export interface SourceCanaryCheck extends CanaryCheck {
  severity: "hard" | "soft";
}

export interface SourceCanaryOutcome {
  checks: SourceCanaryCheck[];
}

export interface TrackerSource {
  id: SourceId;
  title: string;
  datasets: DatasetId[];
  /** False for scaffolded sources that don't ingest yet; they sync as a no-op and canary as `skip`. */
  implemented: boolean;
  sync(ctx: SourceContext, opts?: SyncOptions): Promise<SourceSyncResult>;
  canary(ctx: SourceContext): Promise<SourceCanaryOutcome>;
}

export function emptySyncResult(source: SourceId, implemented: boolean): SourceSyncResult {
  return {
    source,
    implemented,
    rowsUpserted: 0,
    parse: { attempted: 0, succeeded: 0 },
    perDataset: {},
    notes: [],
  };
}

export function deriveCanaryStatus(
  implemented: boolean,
  checks: SourceCanaryCheck[],
): CanaryStatus {
  if (!implemented) return "skip";
  if (checks.some((c) => !c.ok && c.severity === "hard")) return "red";
  if (checks.some((c) => !c.ok)) return "amber";
  return "green";
}
