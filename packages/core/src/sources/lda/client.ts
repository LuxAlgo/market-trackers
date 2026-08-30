import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * Senate LDA REST client. Keyless access works; a free registered key
 * raises the rate limits — the limiter here stays conservatively below the
 * published ceilings either way (keyless 15/min, keyed 100/min).
 *
 * Everything about the live payload this module assumes is listed under
 * `[verify-live]` in docs/sources/lda.md; the canary fingerprints result-row
 * field names so drift fails loudly.
 */

export const LDA_API_BASE = "https://lda.senate.gov/api/v1";
export const LDA_FILINGS_URL = `${LDA_API_BASE}/filings/`;

export const LDA_PAGE_SIZE = 25;
/** Newest-first posted-date ordering, so incremental walks can stop early. */
export const LDA_ORDERING = "-dt_posted";

export const LDA_KEYLESS_LIMIT = { limit: 15, windowMs: 60_000 } as const;
export const LDA_KEYED_LIMIT = { limit: 100, windowMs: 60_000 } as const;

/** One filing row, validated loosely — unknown extra fields pass through. */
export const ldaFilingRowSchema = z
  .object({
    filing_uuid: z.string().min(1),
    filing_year: z.coerce.number().int(),
    filing_period: z.string().min(1),
    filing_type: z.string().nullish(),
    /** Amounts arrive as decimal strings (e.g. "230000.00"); null when unreported. */
    income: z.union([z.string(), z.number()]).nullish(),
    expenses: z.union([z.string(), z.number()]).nullish(),
    registrant: z.object({ name: z.string().min(1) }).passthrough(),
    client: z.object({ name: z.string().min(1) }).passthrough(),
    lobbying_activities: z
      .array(
        z
          .object({
            general_issue_code: z.string().nullish(),
            /** Free-text "specific lobbying issues" narrative — where bill citations live. */
            description: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    filing_document_url: z.string().nullish(),
    dt_posted: z.string().nullish(),
  })
  .passthrough();

export type LdaFilingRow = z.infer<typeof ldaFilingRowSchema>;

/** The list envelope; rows are validated individually for parse accounting. */
export const ldaListResponseSchema = z
  .object({
    next: z.string().nullable(),
    results: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export type LdaListResponse = z.infer<typeof ldaListResponseSchema>;

export interface LdaFetchOptions {
  userAgent: string;
  /** Optional registered key; selects the higher rate-limit tier. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /**
   * Shared limiter — when one walk uses several fetch instances (the
   * backfill's long-haul fetch plus its quick salvage fetch), they must
   * draw from one request budget.
   */
  limiter?: RateLimiter;
  /** Override the long-haul retry posture (salvage probes retry briefly). */
  retry?: { maxRetries: number; retryBaseMs: number };
}

/** The rate limiter matching the key tier, for sharing across fetches. */
export function ldaRateLimiter(apiKey?: string): RateLimiter {
  const tier = apiKey ? LDA_KEYED_LIMIT : LDA_KEYLESS_LIMIT;
  return new RateLimiter({ limit: tier.limit, windowMs: tier.windowMs });
}

export function createLdaFetch(options: LdaFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: options.limiter ?? ldaRateLimiter(options.apiKey),
    // The API sheds an intermittent 5xx/429 roughly once a minute under a
    // sustained keyless walk — observed live (run 33291533828): ~90 blips
    // recovered on attempt 1 over 1,600 pages, then one page 503ing through
    // the default 14-second retry window ended a 5-hour shift at the
    // 2-hour mark. Deep walks are long-haul; back off far enough to ride
    // out a full throttle window or a multi-minute blip before declaring
    // the upstream gone (worst case ~7.7 min of waiting on a real outage).
    maxRetries: options.retry?.maxRetries ?? 5,
    retryBaseMs: options.retry?.retryBaseMs ?? 15_000,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface LdaFilingsRequest {
  filingYear: number;
  page: number;
  pageSize?: number;
  apiKey?: string;
}

export async function fetchFilingsPage(
  politeFetch: PoliteFetch,
  request: LdaFilingsRequest,
): Promise<LdaListResponse> {
  const url = new URL(LDA_FILINGS_URL);
  url.searchParams.set("filing_year", String(request.filingYear));
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("page_size", String(request.pageSize ?? LDA_PAGE_SIZE));
  url.searchParams.set("ordering", LDA_ORDERING);

  const headers: Record<string, string> = { accept: "application/json" };
  if (request.apiKey) headers.authorization = `Token ${request.apiKey}`;

  const response = await politeFetch(url.toString(), { headers });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url.toString(), response.status);
  }
  return ldaListResponseSchema.parse(await response.json());
}

/** API detail URL — the provenance fallback when a filing has no document URL. */
export function ldaFilingDetailUrl(filingUuid: string): string {
  return `${LDA_FILINGS_URL}${encodeURIComponent(filingUuid)}/`;
}

/**
 * "230000.00" → 230000; ""/null/undefined → null. Explicit zeros survive —
 * only the absence of a reported amount becomes null.
 */
export function parseLdaAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Structural fingerprint: sha256 of a result row's sorted field names. */
export function filingRowFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}
