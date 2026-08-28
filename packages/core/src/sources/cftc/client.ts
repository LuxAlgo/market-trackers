import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * CFTC public-reporting Socrata (SODA) client for the legacy futures-only
 * Commitments of Traders dataset. Free and keyless; paging is the standard
 * SODA `$limit`/`$offset` pair, filtered with `$where` on the report-date
 * field.
 *
 * Everything about the live payload this module assumes — the resource id,
 * exact field names, and the floating-timestamp literal form accepted by
 * `$where` — is listed under `[verify-live]` in docs/sources/cftc.md; the
 * canary fingerprints result-row field names so drift fails loudly.
 */

export const CFTC_API_BASE = "https://publicreporting.cftc.gov";
/** Legacy futures-only combined report. [verify-live] resource id + universe choice. */
export const CFTC_COT_LEGACY_FUTURES_URL = `${CFTC_API_BASE}/resource/6dca-aqww.json`;

/** [verify-live] exact field name for the report-date column. */
export const COT_REPORT_DATE_FIELD = "report_date_as_yyyy_mm_dd";

/** [verify-live] a conservative page size; Socrata's own ceiling is much higher. */
export const COT_PAGE_LIMIT = 1000;

/**
 * One raw Socrata result row. Every field is loosely typed (numbers arrive
 * as strings) — real validation and parsing happens in the source's
 * normalizer, one field at a time, so a single bad field produces a precise
 * error rather than a silent default.
 */
export const cotRawRowSchema = z
  .object({
    report_date_as_yyyy_mm_dd: z.string().nullish(),
    cftc_contract_market_code: z.string().nullish(),
    market_and_exchange_names: z.string().nullish(),
    open_interest_all: z.union([z.string(), z.number()]).nullish(),
    comm_positions_long_all: z.union([z.string(), z.number()]).nullish(),
    comm_positions_short_all: z.union([z.string(), z.number()]).nullish(),
    noncomm_positions_long_all: z.union([z.string(), z.number()]).nullish(),
    noncomm_positions_short_all: z.union([z.string(), z.number()]).nullish(),
    nonrept_positions_long_all: z.union([z.string(), z.number()]).nullish(),
    nonrept_positions_short_all: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export type CotRawRow = z.infer<typeof cotRawRowSchema>;

/** The page envelope is a bare JSON array of result rows (standard SODA). */
export const cotPageResponseSchema = z.array(z.record(z.string(), z.unknown()));

export interface CftcFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createCftcFetch(options: CftcFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/**
 * SODA floating-timestamp literal for a YYYY-MM-DD date at midnight.
 * [verify-live] exact literal form `$where` accepts for this column type.
 */
function timestampLiteral(date: string): string {
  return `${date}T00:00:00`;
}

export interface CotPageRequest {
  /** Inclusive YYYY-MM-DD bounds on the report-date field. */
  start: string;
  end: string;
  limit?: number;
  offset: number;
}

export async function fetchCotPage(
  politeFetch: PoliteFetch,
  request: CotPageRequest,
): Promise<Record<string, unknown>[]> {
  const url = new URL(CFTC_COT_LEGACY_FUTURES_URL);
  url.searchParams.set(
    "$where",
    `${COT_REPORT_DATE_FIELD} >= '${timestampLiteral(request.start)}' AND ` +
      `${COT_REPORT_DATE_FIELD} <= '${timestampLiteral(request.end)}'`,
  );
  url.searchParams.set("$order", COT_REPORT_DATE_FIELD);
  url.searchParams.set("$limit", String(request.limit ?? COT_PAGE_LIMIT));
  url.searchParams.set("$offset", String(request.offset));

  const response = await politeFetch(url.toString());
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url.toString(), response.status);
  }
  return cotPageResponseSchema.parse(await response.json());
}

/**
 * Reproducible Socrata query for every row published on one report date —
 * the provenance link for each row minted from that date (a per-page,
 * offset-bearing URL would not reproduce the same result once newer data
 * shifts the paging).
 */
export function cotReportDateQueryUrl(reportDate: string): string {
  const url = new URL(CFTC_COT_LEGACY_FUTURES_URL);
  url.searchParams.set("$where", `${COT_REPORT_DATE_FIELD} = '${timestampLiteral(reportDate)}'`);
  return url.toString();
}

/**
 * "1,234" / "1234" / 1234 → 1234. Throws on anything that isn't a genuine
 * non-negative number — missing, blank, or non-numeric is a parse failure,
 * never a zero. Comma grouping is stripped defensively; [verify-live] which
 * form the live API actually emits.
 */
export function parseCotCount(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field}: invalid numeric value ${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${field}: missing`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field}: empty`);
  const parsed = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field}: unparseable value '${value}'`);
  }
  return parsed;
}

/** Structural fingerprint: sha256 of a result row's sorted field names. */
export function cotRowFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}
