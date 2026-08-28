import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * USPTO Open Data Portal (ODP) client for the PatentsView granted-patent
 * bulk product. The legacy PatentsView PatentSearch API is gone —
 * `search.patentsview.org` no longer resolves in DNS ([verified live]) —
 * and its replacement is not a query API at all: patent grant data now
 * ships as a bulk dataset product whose metadata (and per-table zip files)
 * are served from `api.uspto.gov`, authenticated with the same free key
 * this source always used (`ALT_DATA_PATENTSVIEW_KEY`), sent as `x-api-key`.
 *
 * [verified live] against api.uspto.gov: unauthenticated requests get
 * 401 `{"message":"Unauthorized"}`; unknown routes get 403
 * `{"message":"Missing Authentication Token"}`; an authenticated request
 * for a nonexistent product id gets 404. The product response envelope is
 * `{count, bulkDataProductBag: [{..., productFileBag: {count, fileDataBag:
 * [...]}}]}` with per-file `fileName`/`fileSize`/`fileDownloadURI`/
 * `fileReleaseDate` fields. Remaining offline assumptions are listed under
 * `[verify-live]` in docs/sources/patentsview.md.
 */

export const ODP_API_BASE = "https://api.uspto.gov/api/v1";

/** The PatentsView granted-patent disambiguated bulk product (case-insensitive id). */
export const ODP_PRODUCT_ID = "pvgpatdis";
export const ODP_PRODUCT_URL = `${ODP_API_BASE}/datasets/products/${ODP_PRODUCT_ID}`;

/**
 * The three per-table zips this source consumes, by exact `fileName` in the
 * product's file bag. Selection is by name on purpose: the
 * `fileDataFromDate`/`fileDataToDate` query params filter the bag in
 * non-obvious ways ([verified live]), so the product is always fetched
 * WITHOUT date params and files are picked out of the full bag.
 */
export const PATENTSVIEW_TABLE_FILES = {
  patent: "g_patent.tsv.zip",
  assignee: "g_assignee_disambiguated.tsv.zip",
  cpc: "g_cpc_current.tsv.zip",
} as const;

/**
 * ODP rate limits are generous (millions of requests per week), and a sync
 * makes exactly four requests (one metadata + three file downloads) — the
 * limiter exists to keep the polite-fetch defaults, not to shave a real
 * ceiling, so one sync's request burst fits a single window.
 */
export const PATENTSVIEW_RATE_LIMIT = { limit: 4, windowMs: 1_000 } as const;

export interface PatentsviewFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createPatentsviewFetch(options: PatentsviewFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter(PATENTSVIEW_RATE_LIMIT),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/**
 * The live product moved out from under this ingestor's assumptions — the
 * product id 404s, the file bag names nothing usable, a required table zip
 * disappeared, or a table's header lost a required column. Deliberately NOT
 * an `HttpError`: `sync` downgrades only `HttpError` to a note (transient
 * network trouble), so this must propagate past that and fail the run
 * loudly rather than resolve as a quiet zero-row success — the
 * `GovinfoListingDriftError` pattern.
 */
export class OdpProductDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OdpProductDriftError";
  }
}

/**
 * One file-bag entry, validated loosely — every field optional at the
 * schema level, unknown extras passed through (they still count toward the
 * fingerprint, which hashes the raw row's field names). A row missing
 * `fileName` or `fileDownloadURI` is a per-row extraction failure, never a
 * validation crash.
 */
export const odpFileDataSchema = z
  .object({
    fileName: z.string().nullish(),
    fileSize: z.number().nullish(),
    fileTypeText: z.string().nullish(),
    fileDownloadURI: z.string().nullish(),
    fileReleaseDate: z.string().nullish(),
    fileLastModifiedDateTime: z.string().nullish(),
  })
  .passthrough();

const odpProductSchema = z
  .object({
    productIdentifier: z.string().nullish(),
    productFrequencyText: z.string().nullish(),
    lastModifiedDateTime: z.string().nullish(),
    productFileTotalQuantity: z.number().nullish(),
    productFileBag: z
      .object({
        count: z.number().nullish(),
        fileDataBag: z.array(z.record(z.string(), z.unknown())).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const odpProductResponseSchema = z
  .object({
    count: z.number().nullish(),
    bulkDataProductBag: z.array(odpProductSchema).nullish(),
  })
  .passthrough();

export interface OdpFileEntry {
  fileName: string;
  fileDownloadURI: string;
  fileSize: number | null;
  fileReleaseDate: string | null;
}

export interface OdpProductMetadata {
  /** The release stamp (`"YYYY-MM-DD HH:MM:SS"`) — the sync watermark. */
  lastModifiedDateTime: string;
  files: OdpFileEntry[];
  /** First raw file-bag row exactly as received, for fingerprinting. */
  sampleFileRow: Record<string, unknown> | null;
}

/**
 * Fetches the product metadata (the sync driver — one request). No fileData
 * date params, ever: they filter the bag in non-obvious ways, so callers
 * always see the full bag and select files by name.
 *
 * 401 with a key present is a config problem, not drift and not transient:
 * the key was revoked or the USPTO account's Open Data Portal profile is
 * incomplete — surfaced as a plain, actionable error. 404 means the product
 * id itself is gone: drift.
 */
export async function fetchProductMetadata(
  politeFetch: PoliteFetch,
  apiKey: string,
): Promise<OdpProductMetadata> {
  const response = await politeFetch(ODP_PRODUCT_URL, {
    headers: { accept: "application/json", "x-api-key": apiKey },
  });
  if (response.status === 401) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      "USPTO Open Data Portal rejected the configured API key (HTTP 401 Unauthorized). " +
        "The key may have been revoked, or the USPTO.gov account's Open Data Portal " +
        "profile fields are incomplete — verify the key under Manage API Key at " +
        "https://data.uspto.gov and update ALT_DATA_PATENTSVIEW_KEY.",
    );
  }
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    throw new OdpProductDriftError(
      `${ODP_PRODUCT_URL}: product '${ODP_PRODUCT_ID}' not found (404) — the ODP product id has moved or been retired`,
    );
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(ODP_PRODUCT_URL, response.status);
  }

  const body = odpProductResponseSchema.parse(await response.json());
  const product = body.bulkDataProductBag?.[0];
  if (!product) {
    throw new OdpProductDriftError(
      `${ODP_PRODUCT_URL}: 200 response carries no bulkDataProductBag entry`,
    );
  }
  const lastModifiedDateTime = product.lastModifiedDateTime?.trim();
  if (!lastModifiedDateTime) {
    throw new OdpProductDriftError(
      `${ODP_PRODUCT_URL}: product metadata carries no lastModifiedDateTime — nothing to watermark a release on`,
    );
  }

  const rawRows = product.productFileBag?.fileDataBag ?? [];
  const files: OdpFileEntry[] = [];
  let sampleFileRow: Record<string, unknown> | null = null;
  for (const raw of rawRows) {
    if (sampleFileRow === null) sampleFileRow = raw;
    const parsed = odpFileDataSchema.safeParse(raw);
    if (!parsed.success) continue;
    const fileName = parsed.data.fileName?.trim();
    const fileDownloadURI = parsed.data.fileDownloadURI?.trim();
    if (!fileName || !fileDownloadURI) continue;
    files.push({
      fileName,
      fileDownloadURI,
      fileSize: parsed.data.fileSize ?? null,
      fileReleaseDate: parsed.data.fileReleaseDate ?? null,
    });
  }

  // A 200 whose bag yields zero usable entries is never a legitimate state
  // for a quarterly 37-file product — reading it as empty would let the
  // live shape drift into a silent no-op sync forever.
  if (files.length === 0) {
    const fields = sampleFileRow ? Object.keys(sampleFileRow).sort().join(", ") : "(no rows)";
    throw new OdpProductDriftError(
      `${ODP_PRODUCT_URL}: ${rawRows.length} file(s) listed but none survived field extraction — first row fields: [${fields}]`,
    );
  }

  return { lastModifiedDateTime, files, sampleFileRow };
}

/** Picks one required table zip out of the bag by exact (case-insensitive) file name. */
export function selectTableFile(files: OdpFileEntry[], fileName: string): OdpFileEntry {
  const wanted = fileName.toLowerCase();
  const hit = files.find((f) => f.fileName.toLowerCase() === wanted);
  if (!hit) {
    const names = files.map((f) => f.fileName);
    const shown = names.slice(0, 12).join(", ") + (names.length > 12 ? ", …" : "");
    throw new OdpProductDriftError(
      `product '${ODP_PRODUCT_ID}' no longer names '${fileName}' among its ${files.length} file(s): [${shown}]`,
    );
  }
  return hit;
}

/**
 * Streams one product file to disk. Table zips run to gigabytes, so the
 * body is piped straight to a write stream — never buffered whole. The
 * download URI needs the same x-api-key header as the metadata endpoint.
 */
export async function downloadProductFile(
  politeFetch: PoliteFetch,
  apiKey: string,
  fileDownloadURI: string,
  destPath: string,
): Promise<void> {
  const response = await politeFetch(fileDownloadURI, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(fileDownloadURI, response.status);
  }
  if (!response.body) throw new HttpError(fileDownloadURI, response.status, "empty response body");
  const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
  await pipeline(body, createWriteStream(destPath));
}

/**
 * Canonical primary-source URL for one granted patent: the USPTO Open Data
 * Portal's per-patent page. [verified live] `https://data.uspto.gov/patents/11000000`
 * returns 200; the previous provenance target — the ppubs Patent Public
 * Search print endpoint (`ppubs.uspto.gov/dirsearch-public/print/downloadPdf/…`)
 * — now 404s and must not come back.
 */
export function patentDocumentUrl(patentId: string): string {
  return `https://data.uspto.gov/patents/${encodeURIComponent(patentId)}`;
}

/** Structural fingerprint: sha256 of one file-bag entry's sorted field names. */
export function fileEntryFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(Object.keys(row).sort().join("|")).digest("hex").slice(0, 16);
}
