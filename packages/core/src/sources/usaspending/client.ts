import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * USAspending award-search client. The API is free and keyless but shared —
 * stay well under any radar at ≤2 requests per rolling second, and page
 * with the documented `page_metadata.hasNext` cursor.
 *
 * Everything about the live payload this module assumes is listed under
 * `[verify-live]` in docs/sources/usaspending.md; the canary fingerprints
 * result-row field names so drift fails loudly.
 */

export const USASPENDING_API_BASE = "https://api.usaspending.gov/api/v2";
export const USASPENDING_AWARD_SEARCH_URL = `${USASPENDING_API_BASE}/search/spending_by_award/`;

/** Contract award type codes (A–D: BPA calls, POs, delivery orders, definitive contracts). */
export const CONTRACT_AWARD_TYPE_CODES = ["A", "B", "C", "D"] as const;

/** The award date field requested, sorted on, and used for the watermark. */
export const AWARD_DATE_FIELD = "Start Date";

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
  "generated_internal_id",
] as const;

export const AWARD_SEARCH_PAGE_LIMIT = 100;

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
  })
  .passthrough();

export type AwardSearchRow = z.infer<typeof awardSearchRowSchema>;

/** The response envelope; rows are validated individually for parse accounting. */
export const awardSearchResponseSchema = z
  .object({
    results: z.array(z.record(z.string(), z.unknown())),
    page_metadata: z.object({ page: z.number(), hasNext: z.boolean() }).passthrough(),
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
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface AwardSearchRequest {
  /** Inclusive YYYY-MM-DD bounds on the award date field. */
  startDate: string;
  endDate: string;
  page: number;
  limit?: number;
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
        time_period: [{ start_date: request.startDate, end_date: request.endDate }],
        award_type_codes: [...CONTRACT_AWARD_TYPE_CODES],
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
