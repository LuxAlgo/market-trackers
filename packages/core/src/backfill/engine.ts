import type { DatasetId } from "../schema/datasets.js";
import type { SourceId } from "../schema/provenance.js";
import type { ParseStats, SourceContext, SourceSyncResult } from "../sources/types.js";
import { addDays, toDateString } from "../lib/dates.js";
import { runSync, type RunSyncOptions, type SyncSummary } from "../sync/engine.js";

/**
 * Deep-history backfill: the same `runSync` the daily incremental sync uses,
 * driven in bounded, resumable chunks instead of one open-ended walk. A
 * source's regular watermark (e.g. `usaspending.lastActionDate`) is what
 * incremental `market-trackers sync` advances; backfill tracks its OWN progress
 * separately — `backfill.completedThrough`, namespaced per source — so the
 * two never fight over the same cursor, and a backfill can walk historical
 * ground the live watermark has long since passed without regressing it
 * (each source's own sync only ever advances its live watermark forward).
 *
 * Chunking exists for one reason: a single unbounded historical walk can
 * run for hours and has no resume point if it dies partway. Bounding each
 * `runSync` call with `since`/`until` turns that into a sequence of small,
 * independently-resumable steps.
 */

export const BACKFILL_WATERMARK_KEY = "backfill.completedThrough";

export const DEFAULT_CHUNK_DAYS = 30;

/**
 * Sources whose sync ignores date bounds entirely — datasets that replace
 * wholesale on every run: current state (`congress-legislators`) or a
 * whole-history bulk release (`patentsview`, whose one completed sync
 * already covers 1976→present). Chunking one of these would just repeat
 * the same full replace `chunkDays` times over for no benefit, so backfill
 * skips it outright with an explanatory note.
 */
export const DATE_UNBOUNDED_SOURCES: ReadonlySet<SourceId> = new Set([
  "congress-legislators",
  "patentsview",
]);

/**
 * Sources whose entire free history arrives in one small whole-feed pass
 * (`federalreserve`: the Board's JSON feeds are the coverage — every sync
 * re-reads them in full). Unlike `DATE_UNBOUNDED_SOURCES` these aren't
 * skipped: `backfill --source federalreserve` should still perform that
 * full-feed pass — but chunking it would repeat the identical fetch once
 * per chunk, so the window is walked as a single `[from, to]` chunk (one
 * honest full pass, resumable like any other).
 */
export const SINGLE_PASS_SOURCES: ReadonlySet<SourceId> = new Set(["federalreserve"]);

export type RunSyncFn = (ctx: SourceContext, opts: RunSyncOptions) => Promise<SyncSummary>;

export interface BackfillOptions {
  /** Sources to backfill; each is walked independently, in order. */
  sources: SourceId[];
  /** Start of the window (YYYY-MM-DD), required. */
  from: string;
  /** End of the window (YYYY-MM-DD), inclusive. Defaults to today. */
  to?: string;
  /** Calendar days per resumable chunk. Defaults to 30, minimum 1. */
  chunkDays?: number;
  /** Soft cap on documents fetched per source this run (see `SyncOptions.limit`). */
  limit?: number;
  /** Ignore any recorded `backfill.completedThrough` progress and restart at `from`. */
  full?: boolean;
  /** Injectable clock, for tests. Defaults to `ctx.now` then the real clock. */
  now?: () => Date;
  /** Injectable sync function, for tests. Defaults to the real `runSync`. */
  runSyncFn?: RunSyncFn;
  /** Cooldown before the one in-run retry of a failed chunk (ms). Defaults to 60s. */
  chunkRetryDelayMs?: number;
  /** Injectable sleep, for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Stop starting new chunks after this many minutes and exit cleanly with
   * `stoppedReason: "budget"`. A CI job with a hard timeout needs the walk
   * to stop BEFORE that kill so the run still exports, archives, and
   * resumes — a hard kill mid-chunk forfeits all of that. Unset = no budget.
   */
  budgetMinutes?: number;
}

export interface BackfillChunkOutcome {
  chunkStart: string;
  chunkEnd: string;
  rowsUpserted: number;
  parse: ParseStats;
  perDataset: Partial<Record<DatasetId, number>>;
  notes: string[];
  error: string | null;
  /** The source stopped itself inside this chunk (deadline or limit). */
  stoppedEarly?: "deadline" | "limit";
  /** With `stoppedEarly`: the last date the source fully covered, if it says. */
  completedThrough?: string | null;
}

export interface BackfillSourceResult {
  source: SourceId;
  from: string;
  to: string;
  /** True for a source whose sync ignores date bounds (see `DATE_UNBOUNDED_SOURCES`). */
  skipped: boolean;
  skippedReason: string | null;
  chunks: BackfillChunkOutcome[];
  rowsUpserted: number;
  parse: ParseStats;
  perDataset: Partial<Record<DatasetId, number>>;
  /** The `backfill.completedThrough` watermark after this run; null if nothing completed. */
  completedThrough: string | null;
  /** True when the window through `to` is fully covered (or the source was validly skipped). */
  complete: boolean;
  /** Why the walk stopped short of `to`, when it did. */
  stoppedReason: "limit" | "error" | "budget" | null;
}

export interface BackfillSummary {
  ok: boolean;
  from: string;
  to: string;
  chunkDays: number;
  sources: BackfillSourceResult[];
}

function addChunkResult(
  target: {
    rowsUpserted: number;
    parse: ParseStats;
    perDataset: Partial<Record<DatasetId, number>>;
  },
  chunk: BackfillChunkOutcome,
): void {
  target.rowsUpserted += chunk.rowsUpserted;
  target.parse.attempted += chunk.parse.attempted;
  target.parse.succeeded += chunk.parse.succeeded;
  for (const key of Object.keys(chunk.perDataset) as DatasetId[]) {
    target.perDataset[key] = (target.perDataset[key] ?? 0) + (chunk.perDataset[key] ?? 0);
  }
}

async function backfillOneSource(
  ctx: SourceContext,
  source: SourceId,
  from: string,
  to: string,
  chunkDays: number,
  limit: number | undefined,
  full: boolean,
  runSyncFn: RunSyncFn,
  chunkRetryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
  deadlineMs: number | null,
): Promise<BackfillSourceResult> {
  const logger = ctx.logger.child("backfill");
  const base: BackfillSourceResult = {
    source,
    from,
    to,
    skipped: false,
    skippedReason: null,
    chunks: [],
    rowsUpserted: 0,
    parse: { attempted: 0, succeeded: 0 },
    perDataset: {},
    completedThrough: null,
    complete: false,
    stoppedReason: null,
  };

  if (DATE_UNBOUNDED_SOURCES.has(source)) {
    base.skipped = true;
    base.skippedReason = `'${source}' replaces its dataset wholesale on every sync and ignores date bounds; backfill is a no-op for it`;
    base.complete = true;
    logger.info(`${source}: skipped — ${base.skippedReason}`);
    return base;
  }

  const resumeFrom = full ? null : await ctx.store.getWatermark(source, BACKFILL_WATERMARK_KEY);
  const effectiveFrom = resumeFrom && resumeFrom >= from ? addDays(resumeFrom, 1) : from;
  base.completedThrough = resumeFrom;

  if (effectiveFrom > to) {
    // A prior run already backfilled this source through `to`.
    base.complete = true;
    logger.info(`${source}: already backfilled through ${resumeFrom} — nothing to do`);
    return base;
  }

  let remaining = limit ?? Number.POSITIVE_INFINITY;
  let lastCompletedThrough = resumeFrom;
  let chunkStart = effectiveFrom;
  let retriedChunkStart: string | null = null;

  try {
    while (chunkStart <= to) {
      if (deadlineMs !== null && now().getTime() >= deadlineMs) {
        base.stoppedReason = "budget";
        logger.info(`${source}: time budget reached — stopping cleanly before chunk ${chunkStart}`);
        break;
      }
      if (remaining <= 0) {
        base.stoppedReason = "limit";
        break;
      }
      const naiveEnd = SINGLE_PASS_SOURCES.has(source) ? to : addDays(chunkStart, chunkDays - 1);
      const chunkEnd = naiveEnd > to ? to : naiveEnd;

      const summary = await runSyncFn(ctx, {
        sources: [source],
        since: chunkStart,
        until: chunkEnd,
        limit: Number.isFinite(remaining) ? remaining : undefined,
        // Long-walking sources stop themselves at the deadline mid-chunk;
        // the between-chunk check above alone can't keep one heavy chunk
        // from overrunning the budget into the CI job's hard kill.
        deadlineMs: deadlineMs ?? undefined,
      });
      const result: (SourceSyncResult & { error?: string }) | undefined = summary.results[0];

      const outcome: BackfillChunkOutcome = {
        chunkStart,
        chunkEnd,
        rowsUpserted: result?.rowsUpserted ?? 0,
        parse: result?.parse ?? { attempted: 0, succeeded: 0 },
        perDataset: result?.perDataset ?? {},
        notes: result?.notes ?? [],
        error: result?.error ?? null,
        stoppedEarly: result?.stoppedEarly,
        completedThrough: result?.completedThrough,
      };
      base.chunks.push(outcome);
      addChunkResult(base, outcome);
      logger.info(
        `${source}: chunk ${chunkStart}..${chunkEnd} — ${outcome.rowsUpserted} rows upserted` +
          (outcome.error ? ` (FAILED: ${outcome.error})` : ""),
      );

      if (Number.isFinite(remaining)) remaining -= outcome.parse.attempted;

      if (outcome.error) {
        // Heavy upstream APIs shed connections transiently under sustained
        // load (observed live: usaspending's award search failing one chunk
        // after two clean 20k-row chunks). One cooled-down retry of the
        // failed chunk keeps a multi-hour run alive through a blip without
        // masking a real outage — the SAME chunk failing twice in a row
        // still stops the run, leaving the normal re-dispatch resume.
        if (retriedChunkStart !== chunkStart) {
          retriedChunkStart = chunkStart;
          logger.warn(
            `${source}: chunk ${chunkStart}..${chunkEnd} failed (${outcome.error}); retrying it once after cooldown`,
          );
          await sleep(chunkRetryDelayMs);
          continue;
        }
        base.stoppedReason = "error";
        break;
      }
      if (outcome.stoppedEarly) {
        // The source stopped itself inside the chunk (its deadline or limit
        // hit mid-walk). Bank exactly the ground it says it covered —
        // day-granular — so the next dispatch resumes where this one
        // actually stopped instead of re-walking the whole chunk.
        const covered = outcome.completedThrough ?? null;
        if (
          covered &&
          covered >= chunkStart &&
          (!lastCompletedThrough || covered > lastCompletedThrough)
        ) {
          lastCompletedThrough = covered;
          await ctx.store.setWatermark(source, BACKFILL_WATERMARK_KEY, covered);
        }
        base.stoppedReason = outcome.stoppedEarly === "deadline" ? "budget" : "limit";
        logger.info(
          `${source}: ${outcome.stoppedEarly} stop inside chunk ${chunkStart}..${chunkEnd}` +
            (covered ? ` — banked progress through ${covered}` : ""),
        );
        break;
      }
      if (outcome.notes.some((n) => n.includes("--limit"))) {
        // Sources without `stoppedEarly` reporting still flag limit stops
        // in a note; treat that as the same signal.
        base.stoppedReason = "limit";
        break;
      }

      // This chunk fully reached its end date — advance the resume point
      // and move on to the next chunk. Persisted per chunk, not only at the
      // end of the run: a walk killed from outside (a CI job's hard
      // timeout) must still resume from its last completed chunk instead of
      // re-walking the whole window from scratch every run.
      lastCompletedThrough = chunkEnd;
      await ctx.store.setWatermark(source, BACKFILL_WATERMARK_KEY, chunkEnd);
      chunkStart = addDays(chunkEnd, 1);
    }
  } catch (error) {
    // Defense-in-depth: runSyncFn (the real runSync) never throws — it
    // catches per-source failures itself — but a caller-supplied injectable
    // might. One source misbehaving unexpectedly must not take others down.
    base.stoppedReason = "error";
    base.chunks.push({
      chunkStart,
      chunkEnd: chunkStart,
      rowsUpserted: 0,
      parse: { attempted: 0, succeeded: 0 },
      perDataset: {},
      notes: [],
      error: error instanceof Error ? error.message : String(error),
    });
    logger.error(`${source}: backfill chunk threw`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (lastCompletedThrough && (!resumeFrom || lastCompletedThrough > resumeFrom)) {
    await ctx.store.setWatermark(source, BACKFILL_WATERMARK_KEY, lastCompletedThrough);
  }
  base.completedThrough = lastCompletedThrough;
  base.complete = base.stoppedReason === null;

  return base;
}

/**
 * Runs a chunked, resumable backfill across `opts.sources`, one source at a
 * time (so a slow or failing source never blocks the others' progress or
 * attribution). Each source walks `[from, to]` in `chunkDays`-day windows via
 * `runSyncFn` (the real `runSync` by default), recording how far it got in
 * a `backfill.completedThrough` watermark so the next invocation resumes
 * instead of re-walking already-covered ground — unless `full` is set, in
 * which case it restarts at `from` regardless of prior progress.
 */
export async function runBackfill(
  ctx: SourceContext,
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  const now = opts.now ?? ctx.now ?? (() => new Date());
  const to = opts.to ?? toDateString(now());
  const chunkDays = Math.max(1, opts.chunkDays ?? DEFAULT_CHUNK_DAYS);
  const runSyncFn = opts.runSyncFn ?? runSync;
  const full = opts.full ?? false;
  const chunkRetryDelayMs = opts.chunkRetryDelayMs ?? 60_000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // One shared deadline across every source in the run — the budget guards
  // the whole process's lifetime, not each source's slice of it.
  const deadlineMs =
    opts.budgetMinutes !== undefined ? now().getTime() + opts.budgetMinutes * 60_000 : null;

  const sources: BackfillSourceResult[] = [];
  for (const source of opts.sources) {
    sources.push(
      await backfillOneSource(
        ctx,
        source,
        opts.from,
        to,
        chunkDays,
        opts.limit,
        full,
        runSyncFn,
        chunkRetryDelayMs,
        sleep,
        now,
        deadlineMs,
      ),
    );
  }

  return {
    ok: sources.every((s) => s.complete),
    from: opts.from,
    to,
    chunkDays,
    sources,
  };
}
