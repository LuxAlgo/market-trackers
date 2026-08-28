import { z } from "zod";
import type { TrackerStore } from "../store/store.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { RateLimiter } from "../lib/rate-limiter.js";
import { createPoliteFetch, type PoliteFetch } from "../lib/http.js";
import { MARKET_TRACKERS_VERSION } from "../config.js";

/**
 * CUSIP→ticker resolution via OpenFIGI's free mapping API, cached
 * aggressively in the store (mappings almost never change). Works keyless at
 * a low rate; a free API key raises the limits. Misses are cached too so
 * unresolvable CUSIPs aren't re-queried every sync — a `--full` resolution
 * pass retries them.
 */

export const OPENFIGI_MAPPING_URL = "https://api.openfigi.com/v3/mapping";

const figiResultSchema = z.array(
  z.object({
    data: z
      .array(
        z.object({
          figi: z.string().optional(),
          ticker: z.string().nullable().optional(),
          name: z.string().nullable().optional(),
          exchCode: z.string().nullable().optional(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),
);

export interface OpenFigiClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class OpenFigiClient {
  private readonly politeFetch: PoliteFetch;
  private readonly apiKey?: string;
  /** Keyless: ~25 requests/min; keyed: much higher. Stay under both. */
  readonly batchSize: number;

  constructor(options: OpenFigiClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.batchSize = options.apiKey ? 100 : 10;
    const perMinute = options.apiKey ? 200 : 20;
    this.politeFetch = createPoliteFetch({
      userAgent: `market-trackers/${MARKET_TRACKERS_VERSION}`,
      limiter: new RateLimiter({ limit: perMinute, windowMs: 60_000 }),
      fetchImpl: options.fetchImpl,
      logger: (options.logger ?? silentLogger).child("openfigi"),
    });
  }

  async mapCusips(
    cusips: string[],
  ): Promise<Map<string, { ticker: string | null; figi: string | null; name: string | null }>> {
    const out = new Map<
      string,
      { ticker: string | null; figi: string | null; name: string | null }
    >();
    for (let offset = 0; offset < cusips.length; offset += this.batchSize) {
      const batch = cusips.slice(offset, offset + this.batchSize);
      const response = await this.politeFetch(OPENFIGI_MAPPING_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-openfigi-apikey": this.apiKey } : {}),
        },
        body: JSON.stringify(batch.map((cusip) => ({ idType: "ID_CUSIP", idValue: cusip }))),
      });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new Error(`OpenFIGI mapping failed: HTTP ${response.status}`);
      }
      const results = figiResultSchema.parse(await response.json());
      batch.forEach((cusip, i) => {
        const first = results[i]?.data?.[0];
        out.set(cusip, {
          ticker: first?.ticker ? first.ticker.toUpperCase() : null,
          figi: first?.figi ?? null,
          name: first?.name ?? null,
        });
      });
    }
    return out;
  }
}

/**
 * Resolves the given CUSIPs through the cache, querying OpenFIGI only for
 * unseen ones (or all of them with `retryMisses`).
 */
export async function resolveCusips(
  store: TrackerStore,
  client: OpenFigiClient,
  cusips: string[],
  options: { retryMisses?: boolean } = {},
): Promise<Map<string, string | null>> {
  const unique = [...new Set(cusips)];
  const resolved = new Map<string, string | null>();
  const pending: string[] = [];

  for (const cusip of unique) {
    const cached = await store.getCusip(cusip);
    if (cached && (cached.ticker !== null || !options.retryMisses)) {
      resolved.set(cusip, cached.ticker);
    } else {
      pending.push(cusip);
    }
  }

  if (pending.length > 0) {
    const mapped = await client.mapCusips(pending);
    const entries = pending.map((cusip) => {
      const hit = mapped.get(cusip);
      resolved.set(cusip, hit?.ticker ?? null);
      return {
        cusip,
        ticker: hit?.ticker ?? null,
        figi: hit?.figi ?? null,
        name: hit?.name ?? null,
        mapSource: hit?.ticker ? "openfigi" : "openfigi:miss",
      };
    });
    await store.putCusips(entries);
  }

  return resolved;
}
