import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import { compactDate } from "../../lib/dates.js";
import type { Logger } from "../../lib/logger.js";

/**
 * Wikimedia REST pageviews client (`per-article` endpoint). Free, keyless;
 * the underlying counts are released under CC0. One request per article
 * covers an entire `[start, end]` day range in one shot — unlike a
 * day-by-day file walk (FINRA) or an offset-paged window (CFTC), this
 * endpoint is natively ranged, so the sync loop issues exactly one request
 * per article per run.
 *
 * Everything about the live payload this module assumes — the exact path
 * shape and field names — is listed under `[verify-live]` in
 * docs/sources/wikimedia.md; the canary fingerprints result-item field
 * names so drift fails loudly.
 */

export const WIKIMEDIA_API_BASE = "https://wikimedia.org/api/rest_v1";

/**
 * `agent-type=user` excludes automated bot/spider traffic — pageviews here
 * are a proxy for human reader attention, not crawler noise.
 * `access=all-access` sums desktop, mobile-web, and mobile-app views so a
 * platform shift in how readers reach Wikipedia never reads as an
 * attention change. Both are fixed choices, not configurable per call.
 */
const ACCESS = "all-access";
const AGENT_TYPE = "user";
const GRANULARITY = "daily";

/**
 * The exact, reproducible request URL for one article's day range —
 * this becomes `provenance.sourceUrl` for every row the response produces.
 * [verify-live] whether the live API expects the article segment
 * percent-encoded exactly per `encodeURIComponent` for titles carrying
 * punctuation (e.g. "AT&T", "S&P_Global").
 */
export function pageviewsUrl(project: string, article: string, start: string, end: string): string {
  const encodedProject = encodeURIComponent(project);
  const encodedArticle = encodeURIComponent(article);
  return (
    `${WIKIMEDIA_API_BASE}/metrics/pageviews/per-article/${encodedProject}/${ACCESS}/${AGENT_TYPE}/` +
    `${encodedArticle}/${GRANULARITY}/${compactDate(start)}00/${compactDate(end)}00`
  );
}

/**
 * One raw response item. Every field is loosely typed — real validation
 * happens in the source's normalizer, one field at a time, so a single bad
 * item fails just that item, never the whole response (mirrors
 * `cftc/client.ts`'s `cotRawRowSchema`).
 */
export const wikimediaPageviewItemSchema = z
  .object({
    project: z.string().nullish(),
    article: z.string().nullish(),
    granularity: z.string().nullish(),
    /** `[verify-live]` exact hour-suffix form — assumed always "00" for daily granularity. */
    timestamp: z.string().nullish(),
    access: z.string().nullish(),
    agent: z.string().nullish(),
    views: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

export type WikimediaPageviewItem = z.infer<typeof wikimediaPageviewItemSchema>;

/** `[verify-live]` the envelope is assumed to always be `{"items": [...]}` , even for a single day. */
export const wikimediaPageviewsResponseSchema = z.object({
  items: z.array(wikimediaPageviewItemSchema),
});

export interface WikimediaFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** Hard cap ≤5 req/s, shared across every article walked this run. */
export function createWikimediaFetch(options: WikimediaFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 5, windowMs: 1_000 }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface FetchArticleRangeRequest {
  project: string;
  article: string;
  /** Inclusive YYYY-MM-DD bounds. */
  start: string;
  end: string;
}

export type FetchArticleRangeResult =
  { found: true; items: WikimediaPageviewItem[] } | { found: false };

/**
 * One ranged request for one article. A 404 means the API has no pageview
 * data at all for this article over this exact range (e.g. before the
 * project's 2015-07-01 pageviews depth, or an article that didn't exist
 * yet) — that is a real, expected answer, not a transport failure, so it
 * comes back as `{ found: false }` rather than a thrown error. Any other
 * non-2xx status is a genuine failure and throws.
 */
export async function fetchArticleRange(
  politeFetch: PoliteFetch,
  request: FetchArticleRangeRequest,
): Promise<FetchArticleRangeResult> {
  const url = pageviewsUrl(request.project, request.article, request.start, request.end);
  const response = await politeFetch(url);
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    return { found: false };
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  const parsed = wikimediaPageviewsResponseSchema.parse(await response.json());
  return { found: true, items: parsed.items };
}

/** Structural fingerprint: sha256 of a result item's sorted field names. */
export function pageviewItemFingerprint(item: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(item).sort().join("|")).digest("hex").slice(0, 16);
}
