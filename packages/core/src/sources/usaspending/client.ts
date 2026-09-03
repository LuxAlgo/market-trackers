import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * USAspending award-search client. The API is free and keyless but shared —
 * stay well under any radar at ≤2 requests per rolling second. One endpoint
 * serves both award universes LuxAlgo Market Trackers tracks (contracts and
 * grants); only the requested `award_type_codes` differ, so the
 * request/response shapes below are shared rather than duplicated per dataset.
 *
 * Window semantics matter here. A bare `time_period` is asymmetric on the
 * server (`start_date` compares to the latest action date, `end_date` to the
 * signing date), so every long-running award with any activity after the
 * window start matches it, and a walk sorted on a date field keeps
 * returning the same oldest awards for every window. Requests therefore set
 * `date_type: "new_awards_only"` — only awards whose base transaction was
 * signed inside the window — and sort on that same signing date, so each
 * award falls in exactly one window and a walk can resume to the day.
 *
 * Paging: plain `page`/`limit`, and the server caps any one query at a
 * result window of 20k rows (`hasNext` goes false there whatever remains).
 * Its search_after cursor (`last_record_unique_id` / `last_record_sort_value`)
 * would lift that cap but answers 503 for this sort field, live and
 * repeatably, so it is not used. The walk instead notices a window that
 * filled the cap and resumes from the day it reached; a single day past
 * the cap is re-read partitioned by award type and then by amount band
 * (`award_amounts`), so no window silently loses rows.
 *
 * Everything about the live payload this module assumes is listed under
 * `[verify-live]` in docs/sources/usaspending.md; the canary fingerprints
 * result-row field names so drift fails loudly.
 */

export const USASPENDING_API_BASE = "https://api.usaspending.gov/api/v2";
export const USASPENDING_AWARD_SEARCH_URL = `${USASPENDING_API_BASE}/search/spending_by_award/`;

/** Contract award type codes (A–D: BPA calls, POs, delivery orders, definitive contracts). */
export const CONTRACT_AWARD_TYPE_CODES = ["A", "B", "C", "D"] as const;

/**
 * Grant award type codes. [verify-live] USAspending documents 02 (Block
 * Grant), 03 (Formula Grant), 04 (Project Grant), and 05 (Cooperative
 * Agreement) as the grant universe, distinct from contracts (A–D), loans
 * (07/08), direct payments (06/10/11), and insurance (09) — confirm against
 * the live award-type reference before depending on this list.
 */
export const GRANT_AWARD_TYPE_CODES = ["02", "03", "04", "05"] as const;

/**
 * The award date the walk filters on, sorts by, watermarks, and stores as
 * `actionDate`: USAspending's "Base Obligation Date", the signing date of the
 * award's base transaction (`date_signed` server-side). A per-award scalar,
 * so a `new_awards_only` window enumerates every award exactly once.
 */
export const AWARD_DATE_FIELD = "Base Obligation Date";
/** Period-of-performance start — the fallback date for rows with no signing date. */
export const AWARD_START_FIELD = "Start Date";

export const AWARD_SEARCH_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Recipient UEI",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Award Amount",
  "Description",
  "Contract Award Type",
  "NAICS Code",
  "NAICS Description",
  AWARD_DATE_FIELD,
  AWARD_START_FIELD,
  "generated_internal_id",
] as const;

export const AWARD_SEARCH_PAGE_LIMIT = 100;

/**
 * Rows the server returns for one query at most, observed live: `hasNext`
 * turns false at the 200th page of 100 no matter how many awards match.
 * Overridable for tests (MARKET_TRACKERS_USASPENDING_RESULT_WINDOW).
 */
export function resultWindowRows(): number {
  const raw = process.env.MARKET_TRACKERS_USASPENDING_RESULT_WINDOW;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

/** One `award_amounts` band; open-ended when a bound is omitted. */
export interface AmountBand {
  lower?: number;
  upper?: number;
}

/**
 * Partition of the amount axis used to re-read a single day that overflowed
 * the result window for one award type. Bounds in USD; the server treats
 * them as inclusive on both ends, so an award landing exactly on a boundary
 * may appear in two bands and dedupes on upsert.
 */
export const AMOUNT_BANDS: readonly AmountBand[] = [
  { upper: 25_000 },
  { lower: 25_000, upper: 100_000 },
  { lower: 100_000, upper: 1_000_000 },
  { lower: 1_000_000 },
];

/** One result row, validated loosely — unknown extra fields pass through. */
export const awardSearchRowSchema = z
  .object({
    generated_internal_id: z.string().min(1),
    "Award ID": z.string().nullish(),
    "Recipient Name": z.string().nullish(),
    "Recipient UEI": z.string().nullish(),
    "Awarding Agency": z.string().nullish(),
    "Awarding Sub Agency": z.string().nullish(),
    "Award Amount": z.number().nullish(),
    Description: z.string().nullish(),
    "Contract Award Type": z.string().nullish(),
    "NAICS Code": z.union([z.string(), z.number()]).nullish(),
    "NAICS Description": z.string().nullish(),
    [AWARD_DATE_FIELD]: z.string().nullish(),
    [AWARD_START_FIELD]: z.string().nullish(),
  })
  .passthrough();

export type AwardSearchRow = z.infer<typeof awardSearchRowSchema>;

/** The response envelope; rows are validated individually for parse accounting. */
export const awardSearchResponseSchema = z
  .object({
    results: z.array(z.record(z.string(), z.unknown())),
    page_metadata: z
      .object({
        page: z.number(),
        hasNext: z.boolean(),
        last_record_unique_id: z.number().nullish(),
        last_record_sort_value: z.union([z.string(), z.number()]).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type AwardSearchResponse = z.infer<typeof awardSearchResponseSchema>;

export interface UsaspendingFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createUsaspendingFetch(options: UsaspendingFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    // The award-search endpoint sheds connections for minutes at a time
    // under a sustained walk (observed live: a 5-hour shift ending on two
    // consecutive "fetch failed" ladders of a minute each). Back off over
    // about five minutes before declaring the upstream gone.
    maxRetries: 6,
    retryBaseMs: 5_000,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface AwardSearchRequest {
  /** Inclusive YYYY-MM-DD bounds on the award's signing date (`new_awards_only`). */
  startDate: string;
  endDate: string;
  page: number;
  limit?: number;
  /** Which award universe (or single type code) to query. */
  awardTypeCodes: readonly string[];
  /** Optional `award_amounts` band, for re-reading an overflowing day in slices. */
  amount?: AmountBand;
}

export async function fetchAwardSearchPage(
  politeFetch: PoliteFetch,
  request: AwardSearchRequest,
): Promise<AwardSearchResponse> {
  const response = await politeFetch(USASPENDING_AWARD_SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      filters: {
        time_period: [
          {
            start_date: request.startDate,
            end_date: request.endDate,
            date_type: "new_awards_only",
          },
        ],
        award_type_codes: [...request.awardTypeCodes],
        ...(request.amount
          ? {
              award_amounts: [
                {
                  ...(request.amount.lower !== undefined
                    ? { lower_bound: request.amount.lower }
                    : {}),
                  ...(request.amount.upper !== undefined
                    ? { upper_bound: request.amount.upper }
                    : {}),
                },
              ],
            }
          : {}),
      },
      fields: [...AWARD_SEARCH_FIELDS],
      page: request.page,
      limit: request.limit ?? AWARD_SEARCH_PAGE_LIMIT,
      sort: AWARD_DATE_FIELD,
      order: "asc",
    }),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(USASPENDING_AWARD_SEARCH_URL, response.status);
  }
  return awardSearchResponseSchema.parse(await response.json());
}

/** Human-facing award page — the provenance deep link for every row. */
export function awardPageUrl(generatedInternalId: string): string {
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedInternalId)}`;
}

/** Structural fingerprint: sha256 of a result row's sorted field names. */
export function awardRowFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}
