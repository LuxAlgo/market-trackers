import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";
import { findZipEntry, readZipEntries } from "./zip.js";

/**
 * FEC bulk-download client: keyless, per-two-year-cycle ZIP files served as
 * plain static files off fec.gov. There is no JSON API involved here —
 * every file is a fixed-name, pipe-delimited, headerless text file with
 * exactly one entry per ZIP. `[verify-live]` the base path and per-cycle
 * file-naming convention below (see docs/sources/fec.md); the column
 * layouts each file's rows are parsed against live in `fields.ts`.
 */

export const FEC_BULK_BASE = "https://www.fec.gov/files/bulk-downloads";

/** Last two digits of an even election-cycle year, e.g. 2026 → "26". [verify-live] */
export function cycleSuffix(cycle: number): string {
  return String(cycle % 100).padStart(2, "0");
}

export function fecWeballZipUrl(cycle: number): string {
  return `${FEC_BULK_BASE}/${cycle}/weball${cycleSuffix(cycle)}.zip`;
}
export function fecPas2ZipUrl(cycle: number): string {
  return `${FEC_BULK_BASE}/${cycle}/pas2${cycleSuffix(cycle)}.zip`;
}
export function fecCandidateMasterZipUrl(cycle: number): string {
  return `${FEC_BULK_BASE}/${cycle}/cn${cycleSuffix(cycle)}.zip`;
}
export function fecCommitteeMasterZipUrl(cycle: number): string {
  return `${FEC_BULK_BASE}/${cycle}/cm${cycleSuffix(cycle)}.zip`;
}

/** The one text entry inside each ZIP. cn.txt/cm.txt are not cycle-suffixed; weball's is. [verify-live] */
export function weballEntryName(cycle: number): string {
  return `weball${cycleSuffix(cycle)}.txt`;
}
export const PAS2_ENTRY_NAME = "itpas2.txt";
export const CN_ENTRY_NAME = "cn.txt";
export const CM_ENTRY_NAME = "cm.txt";

/** The FEC.gov public candidate detail page — required `provenance.sourceUrl` for candidate rows. */
export function fecCandidateUrl(candidateId: string, cycle: number): string {
  return `https://www.fec.gov/data/candidate/${encodeURIComponent(candidateId)}/?cycle=${cycle}`;
}
/** The FEC.gov public committee detail page — required `provenance.sourceUrl` for contribution rows. */
export function fecCommitteeUrl(committeeId: string, cycle: number): string {
  return `https://www.fec.gov/data/committee/${encodeURIComponent(committeeId)}/?cycle=${cycle}`;
}

export interface FecFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** ≤2 req/s — these are large bulk files (hundreds of thousands of contribution rows per cycle), not a paged API. */
export function createFecFetch(options: FecFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export class FecBulkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FecBulkFileError";
  }
}

/**
 * Downloads one bulk-download ZIP and decodes its one named text entry.
 * FEC bulk files are legacy government fixed-width/delimited text; `latin1`
 * decodes every byte 0-255 without ever raising a decode error or
 * substituting a replacement character, and is identical to UTF-8 for the
 * pure-ASCII common case — `[verify-live]` the live files' actual encoding.
 */
export async function fetchBulkTextFile(
  politeFetch: PoliteFetch,
  url: string,
  entryBasename: string,
): Promise<string> {
  const response = await politeFetch(url);
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const entries = readZipEntries(bytes);
  const entry = findZipEntry(entries, entryBasename);
  if (!entry) {
    throw new FecBulkFileError(
      `no '${entryBasename}' inside ${url} (entries: ${entries.map((e) => e.name).join(", ") || "none"})`,
    );
  }
  return Buffer.from(entry.data).toString("latin1");
}

/**
 * Structural fingerprint for a headerless pipe-delimited file: the pipe
 * count of its first non-empty line. There is no header row to hash (as
 * other sources' fingerprints do), so the column *count* itself is the
 * fingerprint value — a live file gaining, losing, or reordering-without-
 * changing-count columns is exactly what this can (and can't) catch; see
 * the caveat in `fields.ts`.
 */
export function pipeColumnFingerprint(firstLine: string): string {
  return String(splitPipeLine(firstLine).length - 1);
}

/** The first non-empty line of `text`, or null if it has none. */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) return line;
  }
  return null;
}

/** Splits one pipe-delimited data line into its raw fields. Callers trim per-field. */
export function splitPipeLine(line: string): string[] {
  return line.split("|");
}
