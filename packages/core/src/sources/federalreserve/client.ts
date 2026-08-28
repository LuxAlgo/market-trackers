import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * Federal Reserve Board news-events JSON feeds — free and keyless. Three
 * small whole-feed files (speeches, testimony, press releases); each begins
 * with a UTF-8 BOM that must be stripped before `JSON.parse`, and each item
 * uses single-letter field names (`d` datetime, `t` title, `s` speaker,
 * `lo` location, `l` relative link, `a` addendum, `v` video, and `pt`
 * press-release category on the press feed only).
 *
 * Everything about the live shapes this module assumes is listed under
 * `[verify-live]` in docs/sources/federalreserve.md; the source fingerprints
 * a press item's field names so drift fails loudly.
 */

export const FEDERALRESERVE_BASE = "https://www.federalreserve.gov";

export const FED_SPEECHES_FEED_URL = `${FEDERALRESERVE_BASE}/json/ne-speeches.json`;
export const FED_TESTIMONY_FEED_URL = `${FEDERALRESERVE_BASE}/json/ne-testimony.json`;
export const FED_PRESS_FEED_URL = `${FEDERALRESERVE_BASE}/json/ne-press.json`;

/** The press-release category this dataset keeps; every other `pt` is out of scope. */
export const MONETARY_POLICY_CATEGORY = "Monetary Policy";

/**
 * A 200 feed body that doesn't parse as a JSON array — the live shape has
 * moved out from under this module's assumptions. Deliberately NOT an
 * `HttpError`: the sync loop downgrades only `HttpError` to a note, so this
 * propagates and fails the run loudly rather than resolving as a quiet
 * zero-row success (same pattern as `GovinfoListingDriftError`).
 */
export class FederalReserveFeedDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederalReserveFeedDriftError";
  }
}

/**
 * One raw feed item, loosely typed — real validation happens in the
 * source's normalizer one field at a time, so a single bad item fails just
 * that item, never the whole feed (mirrors `cftc/client.ts`).
 */
export const fedFeedItemSchema = z
  .object({
    /** "M/D/YYYY h:mm:ss AM/PM", US-Eastern. */
    d: z.string().nullish(),
    t: z.string().nullish(),
    s: z.string().nullish(),
    lo: z.string().nullish(),
    l: z.string().nullish(),
    a: z.string().nullish(),
    v: z.string().nullish(),
    video: z.string().nullish(),
    /** Press feed only: the press-release category. */
    pt: z.string().nullish(),
  })
  .passthrough();

export type FedFeedItem = z.infer<typeof fedFeedItemSchema>;

export interface FedFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** Three tiny files per run — 2 req/s is more than polite. */
export function createFederalReserveFetch(options: FedFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/** Strips a leading UTF-8 BOM (every live feed carries one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Fetches one feed and parses it to raw item records. Non-2xx throws
 * `HttpError`; a body that isn't valid JSON, or parses to something other
 * than an array, throws `FederalReserveFeedDriftError`.
 */
export async function fetchFedFeed(
  politeFetch: PoliteFetch,
  url: string,
): Promise<Record<string, unknown>[]> {
  const response = await politeFetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  const body = stripBom(await response.text());
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new FederalReserveFeedDriftError(
      `${url}: body is not valid JSON after BOM strip (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FederalReserveFeedDriftError(`${url}: expected a JSON array, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>[];
}

/**
 * "8/5/2026 4:05:00 PM" → "2026-08-05". The feed's timestamps are
 * US-Eastern; only the DATE part is stored, read verbatim from the string
 * (never through `Date` and the process timezone). A bare "8/5/2026" also
 * parses. Unusable input → null.
 */
export function fedDateToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const datePart = raw.trim().split(/\s+/)[0] ?? "";
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(datePart);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Natural key from the feed's link path: "/newsevents/speech/cook20260805a.htm"
 * → "speech/cook20260805a" (the "/newsevents/" prefix and ".htm" suffix are
 * presentation, not identity). Links that don't carry the prefix keep their
 * full path minus the leading slash — still unique and stable. Unusable → null.
 */
export function fedItemIdFromLink(link: unknown): string | null {
  if (typeof link !== "string" || link.trim() === "") return null;
  let path = link.trim().replace(/^https?:\/\/www\.federalreserve\.gov/i, "");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\.html?$/i, "");
  const id = path.startsWith("/newsevents/") ? path.slice("/newsevents/".length) : path.slice(1);
  return id === "" ? null : id;
}

/** Absolute federalreserve.gov URL for a feed link (relative or already absolute). */
export function fedAbsoluteUrl(link: string): string {
  const trimmed = link.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${FEDERALRESERVE_BASE}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

/**
 * Type of a Monetary Policy press item, from its title: FOMC minutes, FOMC
 * statements, and everything else in the category (implementation notes,
 * discount-rate minutes, …) as a plain press release. A restatement of what
 * the Board published, not a judgment about it.
 */
export function classifyMonetaryPolicyTitle(
  title: string,
): "minutes" | "statement" | "pressRelease" {
  if (title.startsWith("Minutes of the Federal Open Market Committee")) return "minutes";
  if (title.includes("FOMC statement")) return "statement";
  return "pressRelease";
}

/** Structural fingerprint: sha256 of a feed item's sorted field names. */
export function fedItemFingerprint(item: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(item).sort().join("|")).digest("hex").slice(0, 16);
}
