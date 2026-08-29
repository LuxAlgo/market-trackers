import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import { addDays, compactDate } from "../../lib/dates.js";
import type { Logger } from "../../lib/logger.js";

/**
 * openFDA Drugs@FDA REST client. Keyless access works within openFDA's
 * published per-IP ceiling; a free registered key (config `openfdaApiKey` /
 * MARKET_TRACKERS_OPENFDA_KEY) raises it — both tiers here stay conservatively under
 * the documented ceilings, see `[verify-live]` in docs/sources/openfda.md.
 *
 * The `search` query filters on the nested `submissions.submission_status_date`
 * range. openFDA (Elasticsearch-backed) matches at the *application*
 * document level: a matching result carries every submission of that
 * application, not only the one(s) whose date falls inside the queried
 * range. Callers must re-check each submission's own date before treating
 * it as belonging to the window that was searched.
 */

export const OPENFDA_API_BASE = "https://api.fda.gov";
export const OPENFDA_DRUGSFDA_URL = `${OPENFDA_API_BASE}/drug/drugsfda.json`;

export const OPENFDA_PAGE_LIMIT = 100;

/**
 * [verify-live] openFDA's Elasticsearch-backed `skip` paging refuses once
 * `skip + limit` would exceed this ceiling. When a date window's
 * `meta.results.total` would require paging past it, the window is bisected
 * instead of ever issuing a request past the ceiling (see `splitDateWindow`
 * and its use in `sources/openfda/source.ts`).
 */
export const OPENFDA_SKIP_CEILING = 25_000;

export const OPENFDA_KEYLESS_LIMIT = { limit: 60, windowMs: 60_000 } as const;
/** [verify-live] the current keyed ceiling; kept conservative either way. */
export const OPENFDA_KEYED_LIMIT = { limit: 240, windowMs: 60_000 } as const;

/**
 * One application result row, validated loosely — only the natural-key
 * field is required at this layer. `submissions[]` entries are kept as raw
 * records; each is validated individually by the source's normalizer so one
 * bad submission never invalidates its siblings.
 */
export const drugsfdaApplicationSchema = z
  .object({
    application_number: z.string().min(1),
    sponsor_name: z.string().nullish(),
    openfda: z
      .object({ brand_name: z.array(z.string()).nullish() })
      .passthrough()
      .nullish(),
    submissions: z.array(z.record(z.string(), z.unknown())).nullish(),
  })
  .passthrough();

export type DrugsfdaApplication = z.infer<typeof drugsfdaApplicationSchema>;

export const drugsfdaResponseSchema = z
  .object({
    meta: z
      .object({
        results: z.object({ skip: z.number(), limit: z.number(), total: z.number() }).passthrough(),
      })
      .passthrough(),
    results: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export type DrugsfdaResponse = z.infer<typeof drugsfdaResponseSchema>;

export interface OpenfdaFetchOptions {
  userAgent: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createOpenfdaFetch(options: OpenfdaFetchOptions): PoliteFetch {
  const tier = options.apiKey ? OPENFDA_KEYED_LIMIT : OPENFDA_KEYLESS_LIMIT;
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: tier.limit, windowMs: tier.windowMs }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/** `submissions.submission_status_date:[YYYYMMDD TO YYYYMMDD]`, inclusive both ends. */
export function statusDateRangeSearch(start: string, end: string): string {
  return `submissions.submission_status_date:[${compactDate(start)} TO ${compactDate(end)}]`;
}

export interface DrugsfdaPageRequest {
  start: string;
  end: string;
  skip: number;
  limit?: number;
  apiKey?: string;
}

export async function fetchDrugsfdaPage(
  politeFetch: PoliteFetch,
  request: DrugsfdaPageRequest,
): Promise<DrugsfdaResponse> {
  const url = new URL(OPENFDA_DRUGSFDA_URL);
  url.searchParams.set("search", statusDateRangeSearch(request.start, request.end));
  url.searchParams.set("limit", String(request.limit ?? OPENFDA_PAGE_LIMIT));
  url.searchParams.set("skip", String(request.skip));
  if (request.apiKey) url.searchParams.set("api_key", request.apiKey);

  const response = await politeFetch(url.toString());
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url.toString(), response.status);
  }
  return drugsfdaResponseSchema.parse(await response.json());
}

/**
 * Bisects `[start, end]` at the midpoint so each half can be walked with
 * `skip` starting back at 0 — the strategy for a window whose result count
 * would otherwise require paging past `OPENFDA_SKIP_CEILING`. Returns null
 * once the window is a single day and cannot be narrowed further; the
 * caller pages that day anyway and flags the run incomplete.
 */
export function splitDateWindow(
  start: string,
  end: string,
): [[string, string], [string, string]] | null {
  const spanMs = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  const spanDays = Math.round(spanMs / 86_400_000);
  if (spanDays < 2) return null; // 0 or 1 day of span: nothing meaningful to split.
  const mid = addDays(start, Math.floor(spanDays / 2));
  const leftEnd = addDays(mid, -1);
  return [
    [start, leftEnd],
    [mid, end],
  ];
}

/**
 * Drugs@FDA application overview page — the canonical, human-facing primary
 * document for an application, e.g. `NDA021436` → `ApplNo=021436`.
 * [verify-live] exact query-string form and long-term URL stability.
 */
export function drugApplicationOverviewUrl(applicationNumber: string): string {
  const digits = applicationNumber.replace(/^[A-Za-z]+/, "");
  return `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${digits}`;
}

/**
 * The result-row fields the parser cannot work without. The fingerprint
 * watches exactly these: hashing a row's FULL key list flapped day to day,
 * because Drugs@FDA rows legitimately differ in optional enrichment
 * (`openfda`, `products`) — the canary was redding on row variety, not
 * drift. A rename or removal of a required field still changes this hash
 * (and breaks parsing loudly at the same time).
 */
const REQUIRED_ROW_FIELDS = ["application_number", "sponsor_name", "submissions"] as const;

/** Contract fingerprint: which of the parser's required fields the row carries. */
export function drugsfdaRowFingerprint(row: Record<string, unknown>): string {
  const present = REQUIRED_ROW_FIELDS.filter((field) => row[field] !== undefined);
  return createHash("sha256").update(present.join("|")).digest("hex").slice(0, 16);
}
