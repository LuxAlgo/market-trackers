import type { DatasetId } from "../schema/datasets.js";
import type { SourceId } from "../schema/provenance.js";
import type { DocketConfig } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { CanaryCheck, CanaryStatus, DocketStore } from "../store/store.js";

/**
 * The source contract. Every ingestor implements this interface and is
 * registered in `registry.ts`; the sync engine, canary runner, CLI, and CI
 * treat all sources uniformly through it.
 */

export interface SourceContext {
  store: DocketStore;
  config: DocketConfig;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface SyncOptions {
  /** Re-walk from this date (YYYY-MM-DD) instead of the stored watermark. */
  since?: string;
  /** Ignore watermarks entirely and re-walk as deep as the source allows. */
  full?: boolean;
  /** Restrict to these datasets (a source may produce several). */
  datasets?: DatasetId[];
  /** Soft cap on documents fetched this run — for demos and smoke tests. */
  limit?: number;
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

export interface DocketSource {
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
