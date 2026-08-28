import { RateLimiter } from "../../lib/rate-limiter.js";
import { createPoliteFetch, expectOk, HttpError, type PoliteFetch } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import { silentLogger } from "../../lib/logger.js";
import { compactDate, quarterOf } from "../../lib/dates.js";

/**
 * The shared EDGAR client. One instance = one rate limiter, so everything in
 * the process that talks to the SEC shares the same ≤10 req/s ceiling
 * (fair-access policy; violations earn ~10-minute IP blocks) — enforced as a
 * strict sliding window, never more than 10 requests in any rolling second.
 * The declared User-Agent is mandatory — construction fails without one.
 */

export const EDGAR_BASE = "https://www.sec.gov";
export const EDGAR_DATA_BASE = "https://data.sec.gov";
export const COMPANY_TICKERS_URL = `${EDGAR_BASE}/files/company_tickers.json`;

export interface EdgarClientOptions {
  userAgent: string;
  /** Hard-capped at 10 by config; kept configurable downward for shared pipelines. */
  maxRequestsPerSecond?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export class EdgarClient {
  readonly politeFetch: PoliteFetch;

  constructor(options: EdgarClientOptions) {
    const rps = Math.min(options.maxRequestsPerSecond ?? 10, 10);
    const limiter = new RateLimiter({ limit: rps, windowMs: 1_000 });
    this.politeFetch = createPoliteFetch({
      userAgent: options.userAgent,
      limiter,
      // EDGAR blocks abusive clients for ~10 minutes; back off patiently.
      retryBaseMs: 15_000,
      maxRetries: 3,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      logger: (options.logger ?? silentLogger).child("edgar"),
    });
  }

  async text(url: string, options?: { allow404?: boolean }): Promise<string | null> {
    const response = await expectOk(this.politeFetch, url, {
      allow404: options?.allow404,
      headers: { accept: "text/plain, text/html, application/xml, */*" },
    });
    if (response.status === 404) return null;
    return response.text();
  }

  /**
   * Daily-index fetch. SEC's Archives answer 403 both for fair-access
   * blocks AND for index files that don't exist (holidays, or today's index
   * before it is posted) — indistinguishable by status alone [verified
   * live: 2004-01-01 and a same-day index both 403 while the canary's real
   * file fetches fine]. A 403 that survives the polite retries is
   * disambiguated with one probe of the quarter directory's index.json:
   * directory reachable → the file is missing (null, exactly like 404);
   * directory also failing → we really are blocked, so the original error
   * surfaces and the run resumes later from its watermark.
   */
  async dailyIndexText(date: string): Promise<string | null> {
    try {
      return await this.text(dailyIndexUrl(date), { allow404: true });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      await this.text(dailyIndexQuarterUrl(date));
      return null;
    }
  }

  async json<T>(url: string): Promise<T> {
    const response = await expectOk(this.politeFetch, url, {
      headers: { accept: "application/json" },
    });
    return (await response.json()) as T;
  }

  /**
   * Conditional GET: sends If-None-Match / If-Modified-Since from previously
   * stored validators and reports an upstream 304 as `notModified` instead of
   * re-downloading. On 200 the fresh validators are returned for the caller
   * to persist (see `TrackerStore.getFetchCache`/`setFetchCache`).
   */
  async jsonConditional<T>(
    url: string,
    cached: { etag: string | null; lastModified: string | null } | null,
  ): Promise<ConditionalJsonResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
    const response = await this.politeFetch(url, { headers });
    if (response.status === 304) {
      await response.arrayBuffer().catch(() => undefined);
      return { notModified: true };
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpError(url, response.status);
    }
    return {
      notModified: false,
      body: (await response.json()) as T,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  }
}

export type ConditionalJsonResult<T> =
  | { notModified: true }
  | { notModified: false; body: T; etag: string | null; lastModified: string | null };

/** Daily index of every filing received on a date. 404s on weekends/holidays. */
export function dailyIndexUrl(date: string): string {
  const year = date.slice(0, 4);
  return `${EDGAR_BASE}/Archives/edgar/daily-index/${year}/QTR${quarterOf(date)}/master.${compactDate(date)}.idx`;
}

/** The quarter directory's machine-readable listing — the block-vs-missing probe target. */
export function dailyIndexQuarterUrl(date: string): string {
  const year = date.slice(0, 4);
  return `${EDGAR_BASE}/Archives/edgar/daily-index/${year}/QTR${quarterOf(date)}/index.json`;
}

/** Full-submission .txt URL from a master.idx path (e.g. "edgar/data/…/….txt"). */
export function filingTxtUrl(idxPath: string): string {
  return `${EDGAR_BASE}/Archives/${idxPath.replace(/^\//, "")}`;
}

/** Human-facing filing index page — the canonical provenance deep link. */
export function filingIndexUrl(idxPath: string): string {
  return filingTxtUrl(idxPath).replace(/\.txt$/, "-index.htm");
}

/** "0001127602-26-012345" from ".../0001127602-26-012345.txt". */
export function accessionFromPath(idxPath: string): string | null {
  const match = idxPath.match(/(\d{10}-\d{2}-\d{6})\.txt$/);
  return match?.[1] ?? null;
}

export { HttpError };
