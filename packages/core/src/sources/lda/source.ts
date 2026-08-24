import type { DocketSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { LobbyingFiling } from "../../schema/lobbying-filing.js";
import { DOCKET_VERSION } from "../../config.js";
import { addDays, hoursSince } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import { resolveEntityTickers } from "../../resolve/recipients.js";
import {
  createLdaFetch,
  fetchFilingsPage,
  filingRowFingerprint,
  ldaFilingDetailUrl,
  ldaFilingRowSchema,
  parseLdaAmount,
} from "./client.js";

export { LDA_API_BASE, LDA_FILINGS_URL, ldaFilingDetailUrl, parseLdaAmount } from "./client.js";

/**
 * Senate LDA — lobbying disclosure filings, walked newest-first by posted
 * date within each filing year. Natural key is `filing_uuid`; the posted-date
 * watermark re-walks a trailing week, and January also walks the previous
 * filing year (Q4 filings post after year end). Clients resolve to tickers
 * through the curated map; unmatched clients are stored with `tickers: []`.
 */

export const LDA_PARSER = "lda-filings@1";

const WATERMARK_KEY = "lda.lastPostedDate";
const FINGERPRINT_KEY = "lda.filing-row-fields";
/** Filings are amended and re-posted; re-walk this many trailing days. */
const REWALK_DAYS = 7;

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createLdaFetch({
    userAgent: ctx.config.userAgent ?? `docket/${DOCKET_VERSION}`,
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
export function normalizeFilingRow(
  raw: Record<string, unknown>,
  retrievedAt: string,
): NormalizedFiling {
  const row = ldaFilingRowSchema.parse(raw);

  const registrantName = row.registrant.name.trim();
  if (!registrantName) throw new Error(`filing ${row.filing_uuid}: missing registrant name`);
  const clientName = row.client.name.trim();
  if (!clientName) throw new Error(`filing ${row.filing_uuid}: missing client name`);

  // income ?? expenses ?? null — parsed from decimal strings; explicit zeros
  // survive, unreported amounts stay null (never zeroed).
  const amountUsd = parseLdaAmount(row.income) ?? parseLdaAmount(row.expenses) ?? null;

  const issues: string[] = [];
  for (const activity of row.lobbying_activities ?? []) {
    const code = activity.general_issue_code?.trim();
    if (code && !issues.includes(code)) issues.push(code);
  }

  const documentUrl = row.filing_document_url?.trim();
  const postedDate =
    row.dt_posted && /^\d{4}-\d{2}-\d{2}/.test(row.dt_posted) ? row.dt_posted.slice(0, 10) : null;

  return {
    filing: {
      id: row.filing_uuid,
      filingUuid: row.filing_uuid,
      registrant: { name: registrantName },
      client: { name: clientName, tickers: resolveEntityTickers({ name: clientName }) },
      amountUsd,
      filingYear: row.filing_year,
      filingPeriod: row.filing_period,
      filingType: row.filing_type ?? null,
      issues,
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

export const ldaSource: DocketSource = {
  id: "lda",
  title: "Senate LDA (lobbying filings)",
  datasets: ["lobbying-filings"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("lda");
    const result = emptySyncResult("lda", true);
    if (opts.datasets && !opts.datasets.includes("lobbying-filings")) return result;

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
            const { filing, postedDate } = normalizeFilingRow(raw, retrievedAt);
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
            normalizeFilingRow(raw, now.toISOString());
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
