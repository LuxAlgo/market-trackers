import { describe, expect, it, vi } from "vitest";
import { createPoliteFetch, expectOk, HttpError } from "./http.js";

function response(status: number, body = ""): Response {
  return new Response(body, { status });
}

describe("createPoliteFetch", () => {
  it("requires a User-Agent", () => {
    expect(() => createPoliteFetch({ userAgent: " " })).toThrow(/User-Agent/);
  });

  it("sends the declared User-Agent on every request", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seenHeaders.push(init?.headers ?? {});
      return response(200, "ok");
    });
    const politeFetch = createPoliteFetch({
      userAgent: "market-trackers/0.1.0 (test@example.com)",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await politeFetch("https://example.gov/data");
    expect(seenHeaders[0]?.["user-agent"]).toBe("market-trackers/0.1.0 (test@example.com)");
  });

  it("backs off and retries on 429, then succeeds", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, "finally"));
    const politeFetch = createPoliteFetch({
      userAgent: "market-trackers/test",
      retryBaseMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await politeFetch("https://example.gov/limited");
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
    // Exponential: second wait at least doubles the base.
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });

  it("gives up after maxRetries and throws the last HttpError", async () => {
    const fetchImpl = vi.fn(async () => response(403));
    const politeFetch = createPoliteFetch({
      userAgent: "market-trackers/test",
      retryBaseMs: 1,
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(politeFetch("https://example.gov/blocked")).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("passes 404 through without retrying", async () => {
    const fetchImpl = vi.fn(async () => response(404));
    const politeFetch = createPoliteFetch({
      userAgent: "market-trackers/test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await politeFetch("https://example.gov/missing");
    expect(result.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("expectOk", () => {
  it("throws on non-2xx unless 404 is allowed", async () => {
    const politeFetch = createPoliteFetch({
      userAgent: "market-trackers/test",
      retryStatuses: [],
      fetchImpl: (async () => response(404)) as unknown as typeof fetch,
    });
    await expect(expectOk(politeFetch, "https://example.gov/x")).rejects.toBeInstanceOf(HttpError);
    const allowed = await expectOk(politeFetch, "https://example.gov/x", { allow404: true });
    expect(allowed.status).toBe(404);
  });
});
