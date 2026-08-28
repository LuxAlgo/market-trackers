import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Runtime configuration. Precedence: explicit overrides (CLI flags) > env
 * vars > market-trackers.config.json in the working directory > defaults.
 *
 * There are no required API keys anywhere in v0.1 — the only identity LuxAlgo Market Trackers
 * ever sends is a contact email inside the SEC-required User-Agent header.
 * No telemetry: nothing here configures any callback to anyone.
 */

export const trackerConfigSchema = z.object({
  /** SQLite path (default) or postgres:// connection string. */
  db: z.string().default("market-trackers.db"),
  /**
   * Contact email declared in the User-Agent for SEC EDGAR requests, per
   * SEC fair-access policy. Required only when syncing the `edgar` source.
   */
  contactEmail: z.string().email().optional(),
  /** Full User-Agent override; defaults to `market-trackers/<version> (<contactEmail>)`. */
  userAgent: z.string().optional(),
  /** Optional OpenFIGI API key — raises CUSIP-resolution rate limits. Still free. */
  openfigiApiKey: z.string().optional(),
  /** Optional Senate LDA API key — raises lobbying API rate limits. Still free. */
  ldaApiKey: z.string().optional(),
  /** USPTO Open Data Portal API key — required for the patents source (PatentsView bulk data). Free. */
  patentsviewApiKey: z.string().optional(),
  /** Optional openFDA API key — raises rate limits. Still free. */
  openfdaApiKey: z.string().optional(),
  /** EDGAR request ceiling; the SEC fair-access limit is 10 req/s and this can never exceed it. */
  edgarMaxRps: z.number().positive().max(10).default(10),
  /** Default backfill depth (days) for a first sync with no watermark. */
  backfillDays: z.number().int().min(1).max(3650).default(3),
  /** FINRA Reg SHO market files to ingest. */
  finraMarkets: z.array(z.string().min(1)).default(["CNMS"]),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;

export interface ConfigOverrides {
  db?: string;
  contactEmail?: string;
  userAgent?: string;
  openfigiApiKey?: string;
  ldaApiKey?: string;
  patentsviewApiKey?: string;
  openfdaApiKey?: string;
  edgarMaxRps?: number;
  backfillDays?: number;
  finraMarkets?: string[];
  logLevel?: TrackerConfig["logLevel"];
}

function readConfigFile(cwd: string): Partial<ConfigOverrides> {
  try {
    const raw = readFileSync(resolve(cwd, "market-trackers.config.json"), "utf8");
    return JSON.parse(raw) as Partial<ConfigOverrides>;
  } catch {
    return {};
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<ConfigOverrides> {
  const out: Partial<ConfigOverrides> = {};
  if (env.MARKET_TRACKERS_DB) out.db = env.MARKET_TRACKERS_DB;
  if (env.MARKET_TRACKERS_CONTACT) out.contactEmail = env.MARKET_TRACKERS_CONTACT;
  if (env.MARKET_TRACKERS_USER_AGENT) out.userAgent = env.MARKET_TRACKERS_USER_AGENT;
  if (env.MARKET_TRACKERS_OPENFIGI_KEY) out.openfigiApiKey = env.MARKET_TRACKERS_OPENFIGI_KEY;
  if (env.MARKET_TRACKERS_LDA_KEY) out.ldaApiKey = env.MARKET_TRACKERS_LDA_KEY;
  if (env.MARKET_TRACKERS_PATENTSVIEW_KEY)
    out.patentsviewApiKey = env.MARKET_TRACKERS_PATENTSVIEW_KEY;
  if (env.MARKET_TRACKERS_OPENFDA_KEY) out.openfdaApiKey = env.MARKET_TRACKERS_OPENFDA_KEY;
  if (env.MARKET_TRACKERS_BACKFILL_DAYS)
    out.backfillDays = Number(env.MARKET_TRACKERS_BACKFILL_DAYS);
  if (env.MARKET_TRACKERS_FINRA_MARKETS)
    out.finraMarkets = env.MARKET_TRACKERS_FINRA_MARKETS.split(",");
  if (env.MARKET_TRACKERS_LOG) out.logLevel = env.MARKET_TRACKERS_LOG as TrackerConfig["logLevel"];
  return out;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolveConfig(
  overrides: ConfigOverrides = {},
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): TrackerConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const merged = {
    ...readConfigFile(cwd),
    ...stripUndefined(fromEnv(env)),
    ...stripUndefined(overrides),
  };
  return trackerConfigSchema.parse(merged);
}

export const MARKET_TRACKERS_VERSION = "0.1.0";

/**
 * SEC fair access requires a User-Agent that identifies the client and a
 * contact. Refusing to sync EDGAR without one is a feature, not friction.
 */
export function buildUserAgent(config: TrackerConfig): string {
  if (config.userAgent) return config.userAgent;
  if (!config.contactEmail) {
    throw new Error(
      "SEC EDGAR requires a declared contact in the User-Agent (fair-access policy). " +
        "Set one with --contact you@example.com, MARKET_TRACKERS_CONTACT=you@example.com, " +
        'or {"contactEmail": "you@example.com"} in market-trackers.config.json. ' +
        "It is only ever sent as part of the User-Agent header — LuxAlgo Market Trackers has no telemetry.",
    );
  }
  return `market-trackers/${MARKET_TRACKERS_VERSION} (${config.contactEmail})`;
}
