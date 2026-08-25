import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * PatentsView PatentSearch API (v1) client. The provider requires a free API
 * key for every request — there is no anonymous tier — sent as `X-Api-Key`.
 * Documented rate limit is ~45 requests/minute with a key; the limiter below
 * stays conservatively under that.
 *
 * Everything about the live payload this module assumes (query/field/option
 * encoding, field names, pagination cursor, response envelope) is listed
 * under `[verify-live]` in docs/sources/patentsview.md — this build cannot
 * reach `search.patentsview.org` to confirm it directly. The canary
 * fingerprints a result row's field names so any drift fails loudly instead
 * of silently misparsing.
 */

export const PATENTSVIEW_API_BASE = "https://search.patentsview.org/api/v1";
export const PATENTSVIEW_PATENT_URL = `${PATENTSVIEW_API_BASE}/patent/`;

export const PATENTSVIEW_RATE_LIMIT = { limit: 40, windowMs: 60_000 } as const;

/** Max rows requested per page. [verify-live] the provider's actual ceiling. */
export const PATENTSVIEW_PAGE_SIZE = 1000;

/** Ascending by patent_id: a stable, monotonic key for "after"-cursor paging. */
export const PATENTSVIEW_SORT = [{ patent_id: "asc" }] as const;

/**
 * [verify-live] Fields requested from the API. `wipo_kind` is assumed to
 * carry the WIPO ST.16 kind code (e.g. "B2") as published in PatentsView's
 * granted-patent table; `assignees.assignee_organization` and
 * `cpc_current.cpc_class_id` are the dotted entity.field form the v1 API
 * uses for nested sub-entities in both `f` (field selection) and `q` (query
 * predicates). Confirm all four names against a live response.
 */
export const PATENTSVIEW_FIELDS = [
  "patent_id",
  "patent_title",
  "patent_date",
  "wipo_kind",
  "assignees.assignee_organization",
  "cpc_current.cpc_class_id",
] as const;

/** One nested assignee entry; only the organization name is needed. */
const patentsviewAssigneeSchema = z
  .object({ assignee_organization: z.string().nullish() })
  .passthrough();

/** One nested CPC classification entry; only the class id is needed. */
const patentsviewCpcSchema = z.object({ cpc_class_id: z.string().nullish() }).passthrough();

/** One patent result row, validated loosely — unknown extra fields pass through. */
export const patentsviewPatentRowSchema = z
  .object({
    patent_id: z.string().min(1),
    patent_title: z.string().min(1),
    patent_date: z.string().min(1),
    wipo_kind: z.string().nullish(),
    assignees: z.array(patentsviewAssigneeSchema).nullish(),
    cpc_current: z.array(patentsviewCpcSchema).nullish(),
  })
  .passthrough();

export type PatentsviewPatentRow = z.infer<typeof patentsviewPatentRowSchema>;

/**
 * The list envelope. `total_hits` (assumed present) drives pagination
 * termination; when absent, callers fall back to "page shorter than
 * requested" as the last-page signal. Rows are validated individually so
 * one bad row never sinks the page.
 */
export const patentsviewListResponseSchema = z
  .object({
    error: z.boolean().nullish(),
    count: z.number().nullish(),
    total_hits: z.number().nullish(),
    patents: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export type PatentsviewListResponse = z.infer<typeof patentsviewListResponseSchema>;

export interface PatentsviewFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createPatentsviewFetch(options: PatentsviewFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter(PATENTSVIEW_RATE_LIMIT),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface PatentsviewPageRequest {
  /** Grant-date range, inclusive, YYYY-MM-DD. */
  since: string;
  until: string;
  apiKey: string;
  /** Page size; defaults to `PATENTSVIEW_PAGE_SIZE`. */
  size?: number;
  /** Cursor: the last `patent_id` from the previous page (ascending sort). */
  after?: string;
}

/**
 * [verify-live] The exact `q`/`f`/`o`/`s` parameter encoding for
 * `GET https://search.patentsview.org/api/v1/patent/`:
 *  - `q`: `{"_and":[{"_gte":{"patent_date":since}},{"_lte":{"patent_date":until}}]}`
 *  - `f`: `PATENTSVIEW_FIELDS` above, JSON-encoded
 *  - `o`: `{"size": <=1000 [,"after": <last patent_id>]}` — cursor pagination
 *  - `s`: `PATENTSVIEW_SORT` above, JSON-encoded
 * all as JSON-encoded query-string values on a GET (not a POST body). This
 * mirrors the classic PatentsView Search API's q/f/o/s convention, carried
 * forward into the v1 PatentSearch docs; confirm it still holds, including
 * whether large queries must move to POST.
 */
export function buildPatentDateRangeQuery(since: string, until: string): Record<string, unknown> {
  return { _and: [{ _gte: { patent_date: since } }, { _lte: { patent_date: until } }] };
}

export async function fetchPatentPage(
  politeFetch: PoliteFetch,
  request: PatentsviewPageRequest,
): Promise<PatentsviewListResponse> {
  const url = new URL(PATENTSVIEW_PATENT_URL);
  url.searchParams.set(
    "q",
    JSON.stringify(buildPatentDateRangeQuery(request.since, request.until)),
  );
  url.searchParams.set("f", JSON.stringify(PATENTSVIEW_FIELDS));
  const o: Record<string, unknown> = { size: request.size ?? PATENTSVIEW_PAGE_SIZE };
  if (request.after) o.after = request.after;
  url.searchParams.set("o", JSON.stringify(o));
  url.searchParams.set("s", JSON.stringify(PATENTSVIEW_SORT));

  const response = await politeFetch(url.toString(), {
    headers: { accept: "application/json", "x-api-key": request.apiKey },
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url.toString(), response.status);
  }
  return patentsviewListResponseSchema.parse(await response.json());
}

/**
 * [verify-live] Canonical primary-source URL for one granted patent: the
 * USPTO Patent Public Search PDF endpoint, which serves the official grant
 * document directly from the government system of record. Preferred over a
 * PatentsView listing or a Google Patents rendering (the latter is
 * explicitly not the record). Confirm this path is still current and
 * publicly reachable without authentication for the patent numbers this
 * source ingests.
 */
export function patentDocumentUrl(patentId: string): string {
  return `https://ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${encodeURIComponent(patentId)}`;
}

/** Structural fingerprint: sha256 of one result row's sorted top-level field names. */
export function patentRowFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}

export interface PatentsviewApiKeyConfig {
  patentsviewApiKey?: string;
}

/**
 * Friendly, fail-fast error when no key is configured. PatentsView gates
 * every request behind a free key — there is no anonymous fallback to probe
 * — so `sync` must refuse up front rather than fail deep inside a fetch.
 * Mirrors the EDGAR contact-email error's shape: name every way to set it,
 * and note that it costs nothing.
 */
export function requirePatentsviewApiKey(config: PatentsviewApiKeyConfig): string {
  if (config.patentsviewApiKey) return config.patentsviewApiKey;
  throw new Error(
    "PatentsView requires a free API key for its PatentSearch API (no anonymous tier). " +
      "Set one with DOCKET_PATENTSVIEW_KEY=your-key, or " +
      '{"patentsviewApiKey": "your-key"} in docket.config.json. ' +
      "Request a free key at https://patentsview.org/apis/keyrequest — " +
      "it is only ever sent as the X-Api-Key request header.",
  );
}
