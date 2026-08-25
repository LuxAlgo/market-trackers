import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import type { AltDataStore } from "../../store/store.js";

/**
 * Client for the House Clerk financial-disclosure yearly index: one ZIP per
 * year ({YYYY}FD.zip) containing {YYYY}FD.xml with one row per filing. The
 * ZIP is re-downloaded cheaply and conditionally — the store's fetch_cache
 * supplies If-None-Match / If-Modified-Since so an unchanged year costs one
 * 304 and no work.
 */

export const HOUSE_CLERK_BASE = "https://disclosures-clerk.house.gov";

/** Yearly filing index ZIP; verify live before relying on it (see docs/sources/house-clerk.md). */
export function houseClerkYearIndexUrl(year: number): string {
  return `${HOUSE_CLERK_BASE}/public_disc/financial-pdfs/${year}FD.zip`;
}

/** Per-filing PTR PDF for electronically filed reports. */
export function housePtrPdfUrl(year: number, docId: string): string {
  return `${HOUSE_CLERK_BASE}/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

export class HouseClerkIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseClerkIndexError";
  }
}

/** One row of the yearly index XML ({YYYY}FD.xml). */
export interface HouseIndexFiling {
  prefix: string | null;
  first: string;
  last: string;
  suffix: string | null;
  /** "P" = Periodic Transaction Report; other codes are annual reports, amendments, extensions, … */
  filingType: string;
  stateDst: string | null;
  year: number;
  /** Normalized to YYYY-MM-DD (the index prints M/D/YYYY). */
  filingDate: string;
  docId: string;
}

export interface YearIndexParseResult {
  filings: HouseIndexFiling[];
  /**
   * Sorted set of element names seen across index rows, joined with "|" —
   * the structural fingerprint input for drift detection.
   */
  fieldSignature: string;
  /** Rows dropped because a required field was missing or unparseable. */
  skipped: number;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "Member",
});

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  const s = String(node).trim();
  return s === "" ? null : s;
}

/** "8/18/2026" (also "08/18/2026" or an already-ISO date) → "2026-08-18". */
export function normalizeIndexDate(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return null;
  const month = Number(us[1]);
  const day = Number(us[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${us[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Parses {YYYY}FD.xml. Throws HouseClerkIndexError when the structure is absent. */
export function parseYearIndexXml(xml: string): YearIndexParseResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new HouseClerkIndexError(
      `index XML did not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = parsed.FinancialDisclosure as Record<string, unknown> | undefined;
  if (!root || !("Member" in root)) {
    throw new HouseClerkIndexError("no FinancialDisclosure/Member rows in index XML");
  }
  const rows = (root.Member ?? []) as Record<string, unknown>[];

  const fieldNames = new Set<string>();
  const filings: HouseIndexFiling[] = [];
  let skipped = 0;

  for (const row of rows) {
    for (const key of Object.keys(row)) fieldNames.add(key);
    const last = text(row.Last);
    const first = text(row.First);
    const filingType = text(row.FilingType);
    const docId = text(row.DocID);
    const filingDateRaw = text(row.FilingDate);
    const filingDate = filingDateRaw ? normalizeIndexDate(filingDateRaw) : null;
    const year = Number(text(row.Year) ?? "");
    if (!last || !first || !filingType || !docId || !filingDate || !Number.isInteger(year)) {
      skipped += 1;
      continue;
    }
    filings.push({
      prefix: text(row.Prefix),
      first,
      last,
      suffix: text(row.Suffix),
      filingType,
      stateDst: text(row.StateDst),
      year,
      filingDate,
      docId,
    });
  }

  return { filings, fieldSignature: [...fieldNames].sort().join("|"), skipped };
}

/** Finds and decodes {YYYY}FD.xml inside the index ZIP bytes. */
export function extractYearIndexXml(zipBytes: Uint8Array, year: number): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (error) {
    throw new HouseClerkIndexError(
      `index ZIP did not unzip: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const wanted = `${year}fd.xml`;
  for (const [name, bytes] of Object.entries(entries)) {
    const base = name.split("/").pop()?.toLowerCase() ?? "";
    if (base === wanted) return strFromU8(bytes);
  }
  throw new HouseClerkIndexError(
    `no ${year}FD.xml inside the index ZIP (entries: ${Object.keys(entries).join(", ") || "none"})`,
  );
}

export type YearIndexFetchResult =
  | { status: "ok"; xml: string; etag: string | null; lastModified: string | null }
  | { status: "not-modified" }
  | { status: "not-found" };

/**
 * Fetches a year's index ZIP. With `conditional` (default), validators from
 * the store's fetch_cache are sent so an unchanged ZIP answers 304 —
 * callers persist the fresh validators via `setFetchCache` only after they
 * have fully processed the index, so a partial walk is never skipped later.
 */
export async function fetchYearIndex(
  politeFetch: PoliteFetch,
  store: AltDataStore,
  year: number,
  options: { conditional?: boolean } = {},
): Promise<YearIndexFetchResult> {
  const url = houseClerkYearIndexUrl(year);
  const headers: Record<string, string> = {};
  if (options.conditional !== false) {
    const cached = await store.getFetchCache(url);
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
  }
  const response = await politeFetch(url, { headers });
  if (response.status === 304) {
    await response.arrayBuffer().catch(() => undefined);
    return { status: "not-modified" };
  }
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    return { status: "not-found" };
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: "ok",
    xml: extractYearIndexXml(bytes, year),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}
