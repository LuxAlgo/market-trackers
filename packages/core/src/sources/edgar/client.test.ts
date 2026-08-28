import { describe, expect, it } from "vitest";
import { dailyIndexQuarterUrl, dailyIndexUrl, EdgarClient } from "./client.js";

/**
 * dailyIndexText's block-vs-missing disambiguation: SEC answers 403 both for
 * fair-access blocks and for daily-index files that don't exist, so a 403
 * that survives the retries is resolved by probing the quarter directory's
 * index.json — reachable directory means "file missing", failing directory
 * means "actually blocked".
 */

const DAY = "2026-08-26";
const IDX_URL = dailyIndexUrl(DAY);
const PROBE_URL = dailyIndexQuarterUrl(DAY);

function makeClient(byUrl: Record<string, number>): {
  client: EdgarClient;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
    const key = String(url);
    requests.push(key);
    const status = byUrl[key] ?? 404;
    return new Response(status === 200 ? "ok" : "nope", { status });
  }) as typeof fetch;
  const client = new EdgarClient({
    userAgent: "alt-data-test test@example.com",
    fetchImpl,
    sleep: async () => {},
  });
  return { client, requests };
}

describe("EdgarClient.dailyIndexText", () => {
  it("treats a persistent 403 as not-published when the quarter directory is reachable", async () => {
    const { client, requests } = makeClient({ [IDX_URL]: 403, [PROBE_URL]: 200 });
    expect(await client.dailyIndexText(DAY)).toBeNull();
    // The index was retried before giving up; the probe ran exactly once, after.
    expect(requests.filter((u) => u === IDX_URL).length).toBeGreaterThan(1);
    expect(requests.filter((u) => u === PROBE_URL)).toHaveLength(1);
    expect(requests[requests.length - 1]).toBe(PROBE_URL);
  });

  it("surfaces the 403 when the quarter directory fails too — a real block, not a missing file", async () => {
    const { client } = makeClient({ [IDX_URL]: 403, [PROBE_URL]: 403 });
    await expect(client.dailyIndexText(DAY)).rejects.toThrow(/403/);
  });

  it("keeps plain 404 as not-published without probing", async () => {
    const { client, requests } = makeClient({ [IDX_URL]: 404 });
    expect(await client.dailyIndexText(DAY)).toBeNull();
    expect(requests).toEqual([IDX_URL]);
  });
});
