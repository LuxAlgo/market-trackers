import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * GPO GovInfo bulk BILLSTATUS client — free and keyless. Two endpoints per
 * (congress, bill type): a JSON directory listing, and the individual bill
 * XML files it names.
 *
 * Everything about the live listing payload this module assumes is listed
 * under `[verify-live]` in docs/sources/govinfo.md; the source fingerprints
 * a listing file entry's field names so drift fails loudly, the same way
 * `usaspending`/`cftc` fingerprint their result rows.
 */

export const GOVINFO_BASE = "https://www.govinfo.gov";

/** The eight bill/resolution types GovInfo BILLSTATUS codes, and `schema/bill.ts` mirrors. */
export const BILL_TYPES = [
  "hr",
  "s",
  "hjres",
  "sjres",
  "hconres",
  "sconres",
  "hres",
  "sres",
] as const;
export type BillType = (typeof BILL_TYPES)[number];

/** congress.gov URL slug for each bill type — used to build the human-facing provenance link. */
const BILL_TYPE_SLUGS: Record<BillType, string> = {
  hr: "house-bill",
  s: "senate-bill",
  hjres: "house-joint-resolution",
  sjres: "senate-joint-resolution",
  hconres: "house-concurrent-resolution",
  sconres: "senate-concurrent-resolution",
  hres: "house-resolution",
  sres: "senate-resolution",
};

export function billstatusListingUrl(congress: number, billType: string): string {
  return `${GOVINFO_BASE}/bulkdata/json/BILLSTATUS/${congress}/${billType}`;
}

export function billstatusXmlUrl(congress: number, billType: string, billNumber: number): string {
  return `${GOVINFO_BASE}/bulkdata/BILLSTATUS/${congress}/${billType}/BILLSTATUS-${congress}${billType}${billNumber}.xml`;
}

/**
 * "119th", "121st", "122nd", "123rd" — the standard English ordinal suffix
 * (11–13 always "th", otherwise by the last digit).
 */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const CONGRESS_GOV_BASE = "https://www.congress.gov";

/** The human-facing congress.gov bill page — the provenance deep link for every row. */
export function congressBillPageUrl(
  congress: number,
  billType: string,
  billNumber: number,
): string {
  const slug = BILL_TYPE_SLUGS[billType as BillType];
  if (!slug) throw new Error(`unknown bill type '${billType}'`);
  return `${CONGRESS_GOV_BASE}/bill/${ordinal(congress)}-congress/${slug}/${billNumber}`;
}

export interface GovinfoFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createGovinfoFetch(options: GovinfoFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 5, windowMs: 1_000 }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/**
 * One directory-listing file entry, validated loosely — unknown extra
 * fields pass through untouched (and still count toward the fingerprint,
 * which hashes the raw row's field names, not this schema's).
 */
export const govinfoListingFileSchema = z
  .object({
    folder: z.boolean().nullish(),
    fileName: z.string().min(1),
    lastModified: z.string().min(1),
  })
  .passthrough();

export type GovinfoListingFile = z.infer<typeof govinfoListingFileSchema>;

/** [verify-live] exact envelope shape — assumed a bare `{ files: [...] }` object. */
export const govinfoListingResponseSchema = z
  .object({
    files: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export interface ListingEntry {
  fileName: string;
  /** Canonicalized to a full ISO-8601 instant, whatever precision/offset the live field uses. */
  lastModified: string;
}

export interface ListingResult {
  entries: ListingEntry[];
  /** First raw file row exactly as received, for fingerprinting; null when the listing was empty. */
  sampleRow: Record<string, unknown> | null;
}

/** "119hr1234" → { congress: 119, billType: "hr", billNumber: 1234 }; anything else → null. */
const FILE_NAME_RE = /^BILLSTATUS-(\d+)([a-zA-Z]+)(\d+)\.xml$/;

export function parseListingFileName(
  fileName: string,
): { congress: number; billType: string; billNumber: number } | null {
  const match = FILE_NAME_RE.exec(fileName);
  const congressRaw = match?.[1];
  const billTypeRaw = match?.[2];
  const numberRaw = match?.[3];
  if (!congressRaw || !billTypeRaw || !numberRaw) return null;
  return {
    congress: Number(congressRaw),
    billType: billTypeRaw.toLowerCase(),
    billNumber: Number(numberRaw),
  };
}

/**
 * Parses an arbitrary date-ish string into a canonical ISO-8601 instant, so
 * every later comparison (watermark, `--since`, `--until`) is a plain
 * string comparison between values of the same shape regardless of which
 * precision or offset the live field actually uses. Unparseable input
 * (missing, blank, garbage) returns `null`.
 */
export function toIsoInstant(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

/**
 * Fetches one (congress, bill type) directory listing. A 404 is read as
 * "nothing published for this type yet" (some resolution types can be
 * empty early in a new congress) rather than an error; any other non-2xx
 * throws `HttpError`.
 */
export async function fetchBillstatusListing(
  politeFetch: PoliteFetch,
  congress: number,
  billType: string,
): Promise<ListingResult> {
  const url = billstatusListingUrl(congress, billType);
  const response = await politeFetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    return { entries: [], sampleRow: null };
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }

  const body = govinfoListingResponseSchema.parse(await response.json());
  const entries: ListingEntry[] = [];
  let sampleRow: Record<string, unknown> | null = null;
  for (const raw of body.files) {
    if (sampleRow === null) sampleRow = raw;
    const parsed = govinfoListingFileSchema.safeParse(raw);
    if (!parsed.success || parsed.data.folder) continue;
    const lastModified = toIsoInstant(parsed.data.lastModified);
    if (!lastModified) continue;
    entries.push({ fileName: parsed.data.fileName, lastModified });
  }
  return { entries, sampleRow };
}

/** Structural fingerprint: sha256 of a listing file entry's sorted field names. */
export function listingFileFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}
