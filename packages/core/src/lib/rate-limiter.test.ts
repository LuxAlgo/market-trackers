import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Proves the EDGAR fair-access invariant with a virtual clock: a limiter of
 * 10/second never grants more than 10 slots in ANY rolling one-second
 * window, no matter how hard it is hammered — including the first window,
 * where a plain token bucket would allow burst + refill.
 */

function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
  };
}

describe("RateLimiter", () => {
  it("never grants more than the limit in any rolling window", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({
      limit: 10,
      windowMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const grants: number[] = [];
    for (let i = 0; i < 35; i++) {
      await limiter.take();
      grants.push(clock.time());
    }

    for (const start of grants) {
      const inWindow = grants.filter((t) => t >= start && t < start + 1_000).length;
      expect(inWindow).toBeLessThanOrEqual(10);
    }
    // 35 grants at a strict 10/s takes at least 2.5 virtual seconds.
    expect(clock.time()).toBeGreaterThanOrEqual(2_500);
  });

  it("allows an initial burst up to the limit without waiting", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({
      limit: 5,
      windowMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 5; i++) await limiter.take();
    expect(clock.time()).toBe(0);
    await limiter.take();
    expect(clock.time()).toBeGreaterThanOrEqual(1_000);
  });

  it("frees slots as old grants leave the window", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.take(); // t=0
    clock.advance(600);
    await limiter.take(); // t=600
    await limiter.take(); // must wait until t>=1000 (first grant expires)
    expect(clock.time()).toBeGreaterThanOrEqual(1_000);
    expect(clock.time()).toBeLessThan(1_600);
  });

  it("supports per-minute windows (OpenFIGI-style limits)", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 3; i++) await limiter.take();
    expect(clock.time()).toBe(0);
    await limiter.take();
    expect(clock.time()).toBeGreaterThanOrEqual(60_000);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new RateLimiter({ limit: 0 })).toThrow();
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});
