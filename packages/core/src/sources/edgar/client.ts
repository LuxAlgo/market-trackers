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

  async json<T>(url: string): Promise<T> {
    const response = await expectOk(this.politeFetch, url, {
      headers: { accept: "application/json" },
    });
    return (await response.json()) as T;
  }
}

/** Daily index of every filing received on a date. 404s on weekends/holidays. */
export function dailyIndexUrl(date: string): string {
  const year = date.slice(0, 4);
  return `${EDGAR_BASE}/Archives/edgar/daily-index/${year}/QTR${quarterOf(date)}/master.${compactDate(date)}.idx`;
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
