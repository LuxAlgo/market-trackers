/**
 * A sliding-window rate limiter used to enforce hard client-side request
 * ceilings — most importantly SEC EDGAR's fair-access limit of 10
 * requests/second, which LuxAlgo Market Trackers enforces in code, not in docs.
 *
 * Semantics are strict: never more than `limit` grants inside any rolling
 * `windowMs` window (a plain token bucket would allow burst + refill = 2×
 * the limit in the first window). One limiter is shared per source across
 * the whole process, so concurrency can never multiply request rates.
 *
 * The clock and sleep are injectable so tests prove the invariant with a
 * virtual clock instead of waiting on wall time.
 */

export interface RateLimiterOptions {
  /** Maximum grants per window. */
  limit: number;
  /** Window length in milliseconds (default 1000). */
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Timestamps of grants inside the current window, oldest first. */
  private grants: number[] = [];
  /** Serializes waiters so a burst of callers can't all grab the same slot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    if (options.limit <= 0 || (options.windowMs !== undefined && options.windowMs <= 0)) {
      throw new Error("RateLimiter requires a positive limit and window");
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Resolves when a slot has been consumed. Callers proceed strictly in order. */
  async take(): Promise<void> {
    const turn = this.queue.then(() => this.takeSerialized());
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async takeSerialized(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.grants = this.grants.filter((t) => t > now - this.windowMs);
      if (this.grants.length < this.limit) {
        this.grants.push(now);
        return;
      }
      const oldest = this.grants[0] as number;
      const waitMs = oldest + this.windowMs - now;
      await this.sleep(Math.max(1, Math.ceil(waitMs)));
    }
  }
}
