import type { RateLimiter } from "./rate-limiter.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";

/**
 * Polite HTTP: a fetch wrapper that (a) always declares who we are via
 * User-Agent, (b) respects a shared rate limiter when one is supplied, and
 * (c) backs off automatically on 403/429/5xx — SEC EDGAR answers abuse with
 * ~10-minute IP blocks, so the client must slow down long before that.
 */

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface PoliteFetchOptions {
  userAgent: string;
  limiter?: RateLimiter;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Base backoff in ms; attempt n waits base * 2^n + jitter (default 2_000). */
  retryBaseMs?: number;
  /** Statuses that trigger a backoff-and-retry (default 403, 429, 500, 502, 503, 504). */
  retryStatuses?: number[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface PoliteRequestInit {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
}

export type PoliteFetch = (url: string, init?: PoliteRequestInit) => Promise<Response>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPoliteFetch(options: PoliteFetchOptions): PoliteFetch {
  const {
    userAgent,
    limiter,
    maxRetries = 3,
    retryBaseMs = 2_000,
    retryStatuses = [403, 429, 500, 502, 503, 504],
    fetchImpl = fetch,
    sleep = defaultSleep,
    logger = silentLogger,
  } = options;

  if (!userAgent || userAgent.trim().length === 0) {
    throw new Error("politeFetch requires a non-empty User-Agent");
  }

  return async function politeFetch(url: string, init?: PoliteRequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn(`retrying in ${backoff}ms`, { url, attempt });
        await sleep(backoff);
      }
      if (limiter) await limiter.take();
      try {
        const response = await fetchImpl(url, {
          method: init?.method ?? "GET",
          headers: {
            "user-agent": userAgent,
            "accept-encoding": "gzip, deflate",
            ...init?.headers,
          },
          body: init?.body,
          redirect: "follow",
        });
        if (retryStatuses.includes(response.status)) {
          lastError = new HttpError(url, response.status);
          // Drain the body so the connection can be reused.
          await response.arrayBuffer().catch(() => undefined);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/** Fetch and require a 2xx (404 allowed through when `allow404`). */
export async function expectOk(
  politeFetch: PoliteFetch,
  url: string,
  init?: PoliteRequestInit & { allow404?: boolean },
): Promise<Response> {
  const response = await politeFetch(url, init);
  if (response.ok) return response;
  if (init?.allow404 && response.status === 404) return response;
  await response.arrayBuffer().catch(() => undefined);
  throw new HttpError(url, response.status);
}
