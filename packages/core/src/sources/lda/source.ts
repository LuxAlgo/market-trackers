import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import type { TrackerStore } from "../../store/store.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { LobbyingFiling } from "../../schema/lobbying-filing.js";
import { MARKET_TRACKERS_VERSION } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { resolveEntityTickersTiered } from "../../resolve/sec-names.js";
import { extractBillReferences } from "./bill-refs.js";
import {
  createLdaFetch,
  fetchFilingsPage,
  filingRowFingerprint,
  ldaFilingDetailUrl,
  ldaFilingRowSchema,
  parseLdaAmount,
} from "./client.js";

export { LDA_API_BASE, LDA_FILINGS_URL, ldaFilingDetailUrl, parseLdaAmount } from "./client.js";
export { extractBillReferences } from "./bill-refs.js";

/**
 * Senate LDA — lobbying disclosure filings. Two walk shapes share one
 * normalizer:
 *
 * - **Daily top-up** (no `opts.until`): the current filing year (plus the
 *   previous one in January), newest-first by posted date, early-stopping at
 *   the posted-date watermark minus a re-walk week.
 * - **Backfill** (`opts.until` set — how the backfill engine calls every
 *   chunk): whole filing years ascending from the window's start year. The
 *   API's only usable date filter is `filing_year`, so the year is the walk
 *   unit; completed years are reported via `completedThrough` and the
 *   position inside a year survives restarts through a persisted page
 *   cursor. This path never touches the daily posted-date watermark.
 *
 * Natural key is `filing_uuid`; upserts make every walk idempotent. Clients
 * resolve to tickers through the curated map; unmatched clients are stored
 * with `tickers: []`.
 */

export const LDA_PARSER = "lda-filings@1";

const WATERMARK_KEY = "lda.lastPostedDate";
const FINGERPRINT_KEY = "lda.filing-row-fields";
/** Filings are amended and re-posted; re-walk this many trailing days. */
const REWALK_DAYS = 7;
/**
 * Backfill resume point inside a filing year: the next unfetched page,
 * persisted after every page so a killed run re-ingests at most one page.
 * Kept separate from the engine's date watermark, which stays year-granular.
 */
export const BACKFILL_CURSOR_KEY = "lda.backfill.cursor";
/**
 * A backfill run that fetched this many rows without one successful parse is
 * format drift, not empty data — fail loudly and hold the cursor so the run
 * stays red until the parser is fixed, instead of silently skipping an era.
 */
const ZERO_PARSE_TRIPWIRE_MIN = 100;

interface BackfillCursor {
  year: number;
  page: number;
}

function parseBackfillCursor(raw: string | null): BackfillCursor | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<BackfillCursor>;
    if (
      typeof value.year === "number" &&
      Number.isInteger(value.year) &&
      typeof value.page === "number" &&
      Number.isInteger(value.page) &&
      value.page >= 1
    ) {
      return { year: value.year, page: value.page };
    }
  } catch {
    // An unreadable cursor is ignored, never fatal — the walk just restarts
    // at the window's start year.
  }
  return null;
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createLdaFetch({
    userAgent: ctx.config.userAgent ?? `market-trackers/${MARKET_TRACKERS_VERSION}`,
    apiKey: ctx.config.ldaApiKey,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("lda"),
  });
}

/** Filing years to walk: the current year, plus the previous one in January. */
export function ldaFilingYears(now: Date): number[] {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() === 0 ? [year - 1, year] : [year];
}

export interface NormalizedFiling {
  filing: LobbyingFiling;
  /** YYYY-MM-DD from dt_posted; null when the API omits it. */
  postedDate: string | null;
}

/** Normalizes one raw result row; throws when a required field is unusable. */
export async function normalizeFilingRow(
  raw: Record<string, unknown>,
  retrievedAt: string,
  store: TrackerStore,
): Promise<NormalizedFiling> {
  const row = ldaFilingRowSchema.parse(raw);

  const registrantName = row.registrant.name.trim();
  if (!registrantName) throw new Error(`filing ${row.filing_uuid}: missing registrant name`);
  const clientName = row.client.name.trim();
  if (!clientName) throw new Error(`filing ${row.filing_uuid}: missing client name`);

  // income ?? expenses ?? null — parsed from decimal strings; explicit zeros
  // survive, unreported amounts stay null (never zeroed).
  const amountUsd = parseLdaAmount(row.income) ?? parseLdaAmount(row.expenses) ?? null;

  const issues: string[] = [];
  const specificIssuesTexts: string[] = [];
  for (const activity of row.lobbying_activities ?? []) {
    const code = activity.general_issue_code?.trim();
    if (code && !issues.includes(code)) issues.push(code);
    const description = activity.description?.trim();
    if (description) specificIssuesTexts.push(description);
  }
  // Same activities `issues` reads from — their free-text "specific lobbying
  // issues" narrative, joined, is where an explicit bill citation would live.
  const billReferences = extractBillReferences(specificIssuesTexts.join(" "));

  const documentUrl = row.filing_document_url?.trim();
  const postedDate =
    row.dt_posted && /^\d{4}-\d{2}-\d{2}/.test(row.dt_posted) ? row.dt_posted.slice(0, 10) : null;

  return {
    filing: {
      id: row.filing_uuid,
      filingUuid: row.filing_uuid,
      registrant: { name: registrantName },
      client: {
        name: clientName,
        tickers: await resolveEntityTickersTiered(store, { name: clientName }),
      },
      amountUsd,
      filingYear: row.filing_year,
      filingPeriod: row.filing_period,
      filingType: row.filing_type ?? null,
      issues,
      billReferences,
      provenance: {
        source: "lda",
        sourceUrl: documentUrl || ldaFilingDetailUrl(row.filing_uuid),
        retrievedAt,
        parser: LDA_PARSER,
        confidence: 1,
        needsReview: false,
      },
    },
    postedDate,
  };
}

/**
 * The historical walk: filing years ascending from the window's start year.
 * Coverage is banked two ways — completed years through
 * `result.completedThrough` (the engine's date watermark), and the position
 * inside the current year through `BACKFILL_CURSOR_KEY`, persisted after
 * every page. The daily posted-date watermark is never read or written here,
 * and the canary fingerprint is left to the daily/canary lanes on purpose: a
 * decades-old row's field set must not become the drift baseline.
 */
async function backfillSync(
  ctx: SourceContext,
  opts: SyncOptions,
  until: string,
): Promise<SourceSyncResult> {
  const logger = ctx.logger.child("lda");
  const result = emptySyncResult("lda", true);
  const politeFetch = buildFetch(ctx);
  const apiKey = ctx.config.ldaApiKey;
  const now = ctx.now?.() ?? new Date();
  const retrievedAt = now.toISOString();
  const today = toDateString(now);

  const sinceYear = Number((opts.since ?? until).slice(0, 4));
  const untilYear = Number(until.slice(0, 4));

  const cursor = parseBackfillCursor(await ctx.store.getWatermark("lda", BACKFILL_CURSOR_KEY));
  const cursorUsable = cursor !== null && cursor.year >= sinceYear && cursor.year <= untilYear;
  let year = cursorUsable ? cursor.year : sinceYear;
  let page = cursorUsable ? cursor.page : 1;
  if (cursorUsable) {
    result.notes.push(`resumed filing year ${year} at page ${page} (persisted cursor)`);
  }

  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let processed = 0;
  const pastDeadline = () =>
    opts.deadlineMs !== undefined && (ctx.now?.() ?? new Date()).getTime() >= opts.deadlineMs;

  // Years before the entry point are covered: by the engine's watermark for
  // `sinceYear` onward, or by the cursor's invariant (it only ever advances
  // past a fully walked year).
  let lastCompleteYearEnd: string | null = year > sinceYear ? `${year - 1}-12-31` : null;

  walk: while (year <= untilYear) {
    for (;;) {
      if (pastDeadline()) {
        result.stoppedEarly = "deadline";
        result.notes.push(`time budget reached in filing year ${year}, page ${page}`);
        break walk;
      }

      let response;
      try {
        response = await fetchFilingsPage(politeFetch, { filingYear: year, page, apiKey });
      } catch (error) {
        // Retries exhausted (rate-limit contention or an outage): stop the
        // shift here. The cursor still names this page, so the next dispatch
        // retries it instead of skipping it.
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          result.stoppedEarly = "upstream";
          break walk;
        }
        throw error;
      }

      const filings: LobbyingFiling[] = [];
      for (const raw of response.results) {
        processed += 1;
        result.parse.attempted += 1;
        try {
          const { filing } = await normalizeFilingRow(raw, retrievedAt, ctx.store);
          filings.push(filing);
          result.parse.succeeded += 1;
        } catch (error) {
          logger.warn("filing row failed to normalize", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (result.parse.attempted >= ZERO_PARSE_TRIPWIRE_MIN && result.parse.succeeded === 0) {
        // Thrown before the cursor advances, so the next run re-walks this
        // ground and stays red until the parser handles the era.
        throw new Error(
          `lda backfill: ${result.parse.attempted} rows fetched with zero parsed — ` +
            `format-drift tripwire (filing year ${year}, page ${page})`,
        );
      }

      if (filings.length > 0) {
        const { rows } = await ctx.store.upsert(DATASETS["lobbying-filings"], filings);
        result.rowsUpserted += rows;
        result.perDataset["lobbying-filings"] =
          (result.perDataset["lobbying-filings"] ?? 0) + rows;
      }
      logger.info(`backfill ${year} page ${page}: ${filings.length} filings`);

      const lastPageOfYear = response.next === null;
      await ctx.store.setWatermark(
        "lda",
        BACKFILL_CURSOR_KEY,
        JSON.stringify(lastPageOfYear ? { year: year + 1, page: 1 } : { year, page: page + 1 }),
      );

      if (lastPageOfYear) break;
      if (processed >= limit) {
        result.stoppedEarly = "limit";
        result.notes.push(`stopped at --limit ${opts.limit} in filing year ${year}`);
        break walk;
      }
      page += 1;
    }

    lastCompleteYearEnd = `${year}-12-31`;
    year += 1;
    page = 1;
  }

  // The current filing year keeps posting; never claim days that haven't
  // happened. The daily top-up owns the present from here.
  result.completedThrough =
    lastCompleteYearEnd === null
      ? null
      : lastCompleteYearEnd < today
        ? lastCompleteYearEnd
        : today;
  return result;
}

export const ldaSource: TrackerSource = {
  id: "lda",
  title: "Senate LDA (lobbying filings)",
  datasets: ["lobbying-filings"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("lda");
    const result = emptySyncResult("lda", true);
    if (opts.datasets && !opts.datasets.includes("lobbying-filings")) return result;

    // A bounded window is a historical walk — the backfill engine always
    // sets `until`. The daily top-up below never does.
    if (opts.until !== undefined) return backfillSync(ctx, opts, opts.until);

    const politeFetch = buildFetch(ctx);
    const apiKey = ctx.config.ldaApiKey;
    const now = ctx.now?.() ?? new Date();
    const retrievedAt = now.toISOString();

    const watermark = opts.full ? null : await ctx.store.getWatermark("lda", WATERMARK_KEY);
    // No watermark (or --full) walks the filing year(s) completely.
    const since = opts.since ?? (watermark ? addDays(watermark, -REWALK_DAYS) : null);

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let maxPosted: string | null = null;
    let fingerprinted = false;
    let complete = true;

    years: for (const year of ldaFilingYears(now)) {
      let page = 1;
      for (;;) {
        let response;
        try {
          response = await fetchFilingsPage(politeFetch, { filingYear: year, page, apiKey });
        } catch (error) {
          // Exhausted retries: keep partial progress, leave the watermark put.
          if (error instanceof HttpError) {
            result.notes.push(error.message);
            complete = false;
            break years;
          }
          throw error;
        }

        if (!fingerprinted && response.results[0]) {
          await ctx.store.setFingerprint(
            "lda",
            FINGERPRINT_KEY,
            filingRowFingerprint(response.results[0]),
          );
          fingerprinted = true;
        }

        const filings: LobbyingFiling[] = [];
        let oldestOnPage: string | null = null;
        for (const raw of response.results) {
          processed += 1;
          result.parse.attempted += 1;
          try {
            const { filing, postedDate } = await normalizeFilingRow(raw, retrievedAt, ctx.store);
            filings.push(filing);
            result.parse.succeeded += 1;
            if (postedDate) {
              if (maxPosted === null || postedDate > maxPosted) maxPosted = postedDate;
              if (oldestOnPage === null || postedDate < oldestOnPage) oldestOnPage = postedDate;
            }
          } catch (error) {
            logger.warn("filing row failed to normalize", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (filings.length > 0) {
          const { rows } = await ctx.store.upsert(DATASETS["lobbying-filings"], filings);
          result.rowsUpserted += rows;
          result.perDataset["lobbying-filings"] =
            (result.perDataset["lobbying-filings"] ?? 0) + rows;
        }
        logger.info(`${year} page ${page}: ${filings.length} filings`);

        if (response.next === null) break;
        // Newest-first ordering: once a whole boundary page has slid past the
        // incremental window, everything deeper is older still.
        if (since !== null && oldestOnPage !== null && oldestOnPage < since) break;
        if (processed >= limit) {
          result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
          complete = false;
          break years;
        }
        page += 1;
      }
    }

    // Only a completed walk may advance the watermark, and only forward.
    if (complete && maxPosted !== null) {
      const existing = await ctx.store.getWatermark("lda", WATERMARK_KEY);
      if (existing === null || maxPosted > existing) {
        await ctx.store.setWatermark("lda", WATERMARK_KEY, maxPosted);
      }
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const politeFetch = buildFetch(ctx);
    const apiKey = ctx.config.ldaApiKey;
    const year = now.getUTCFullYear();

    try {
      const response = await fetchFilingsPage(politeFetch, {
        filingYear: year,
        page: 1,
        pageSize: 1,
        apiKey,
      });
      checks.push({
        name: "probe-filings",
        ok: true,
        severity: "hard",
        note: `${response.results.length} row(s) for filing year ${year}${apiKey ? " (keyed)" : " (keyless)"}`,
      });

      const first = response.results[0];
      if (first) {
        const hash = filingRowFingerprint(first);
        const stored = await ctx.store.getFingerprint("lda", FINGERPRINT_KEY);
        if (stored === null) {
          await ctx.store.setFingerprint("lda", FINGERPRINT_KEY, hash);
          checks.push({
            name: "fingerprint",
            ok: true,
            severity: "hard",
            note: "baseline recorded",
          });
        } else {
          checks.push({
            name: "fingerprint",
            ok: stored === hash,
            severity: "hard",
            note: stored === hash ? undefined : "result-row field names changed",
          });
        }

        let succeeded = 0;
        for (const raw of response.results) {
          try {
            await normalizeFilingRow(raw, now.toISOString(), ctx.store);
            succeeded += 1;
          } catch {
            // Counted below.
          }
        }
        const rate = succeeded / response.results.length;
        checks.push({
          name: "parse-success-rate",
          ok: rate >= 0.99,
          severity: "hard",
          note: `${succeeded}/${response.results.length} probe rows`,
        });
      }
    } catch (error) {
      checks.push({
        name: "probe-filings",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // Lobbying discloses quarterly; the dataset window is long on purpose.
    const lastIngested = await ctx.store.maxRetrievedAt("lobbying-filings");
    checks.push({
      name: "freshness-lobbying-filings",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["lobbying-filings"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
