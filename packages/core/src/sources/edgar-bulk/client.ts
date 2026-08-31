import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * Client for the SEC's quarterly "Insider Transactions Data Sets" — DERA's
 * official structured extraction of every Form 3/4/5 filing, one ZIP of TSV
 * tables per calendar quarter, from 2006 Q1 onward. One download replaces a
 * month-by-month walk of ~250k daily-index filings, which is the whole point
 * of this source: the deep insider history in hours instead of months.
 *
 * Everything about the live payload this module assumes is listed under
 * `[verify-live]` in docs/sources/edgar-bulk.md. Format drift fails loudly:
 * a table missing one of its required columns throws `BulkFormatError` and
 * the run goes red with the resume point held.
 */

export const INSIDER_SETS_BASE =
  "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets";

export interface Quarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
}

/** The data sets begin with 2006 Q1. [verify-live] */
export const EARLIEST_QUARTER: Quarter = { year: 2006, quarter: 1 };

export function quarterZipUrl(q: Quarter): string {
  return `${INSIDER_SETS_BASE}/${q.year}q${q.quarter}_form345.zip`;
}

export function quarterLabel(q: Quarter): string {
  return `${q.year}q${q.quarter}`;
}

export function parseQuarterLabel(label: string | null): Quarter | null {
  if (!label) return null;
  const match = /^(\d{4})q([1-4])$/.exec(label);
  if (!match) return null;
  return { year: Number(match[1]), quarter: Number(match[2]) as Quarter["quarter"] };
}

export function quarterOfDate(date: string): Quarter {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return { year, quarter: (Math.floor((month - 1) / 3) + 1) as Quarter["quarter"] };
}

export function quarterStart(q: Quarter): string {
  const month = (q.quarter - 1) * 3 + 1;
  return `${q.year}-${String(month).padStart(2, "0")}-01`;
}

export function quarterEnd(q: Quarter): string {
  const lastDay = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" }[q.quarter];
  return `${q.year}-${lastDay}`;
}

export function nextQuarter(q: Quarter): Quarter {
  return q.quarter === 4
    ? { year: q.year + 1, quarter: 1 }
    : { year: q.year, quarter: (q.quarter + 1) as Quarter["quarter"] };
}

export function previousQuarter(q: Quarter): Quarter {
  return q.quarter === 1
    ? { year: q.year - 1, quarter: 4 }
    : { year: q.year, quarter: (q.quarter - 1) as Quarter["quarter"] };
}

export function compareQuarters(a: Quarter, b: Quarter): number {
  return a.year === b.year ? a.quarter - b.quarter : a.year - b.year;
}

export interface BulkFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createBulkFetch(options: BulkFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    // One request per quarter — the limiter is a guardrail, not a throttle.
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    // Same patience as the EDGAR archive client: SEC blocks abusive clients
    // for ~10 minutes, so back off well past a blip before giving up.
    retryBaseMs: 15_000,
    maxRetries: 3,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

/**
 * Downloads one quarter's ZIP. Null means the SEC answered 404 — for a
 * recent quarter that is normal publication lag, for an old one it is URL
 * drift; the caller decides which. Any other non-OK status that survives
 * the polite retries surfaces as `HttpError`.
 */
export async function fetchQuarterArchive(
  politeFetch: PoliteFetch,
  q: Quarter,
): Promise<Uint8Array | null> {
  const url = quarterZipUrl(q);
  const response = await politeFetch(url, { headers: { accept: "application/zip, */*" } });
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export class BulkFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkFormatError";
  }
}

export interface TsvTable {
  /** Header names exactly as shipped (used for the drift fingerprint). */
  columns: string[];
  rows: string[][];
}

/**
 * DERA TSVs are plain tab-separated text with a header row and no quoting.
 * [verify-live] the no-quoting assumption — a quoted field would surface as
 * literal quote characters in values, not a parse crash.
 */
export function parseTsvTable(bytes: Uint8Array): TsvTable {
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  const header = lines.shift();
  if (!header) throw new BulkFormatError("TSV table is empty (no header row)");
  return {
    columns: header.split("\t").map((c) => c.trim()),
    rows: lines.map((line) => line.split("\t")),
  };
}

/**
 * Case-insensitive required-column lookup. A missing required column is
 * format drift and must stop the run loudly rather than ingest nulls.
 */
export function columnPicker(
  table: TsvTable,
  tableName: string,
): (name: string, required?: boolean) => number {
  const byUpper = new Map<string, number>();
  table.columns.forEach((c, i) => byUpper.set(c.toUpperCase(), i));
  return (name, required = true) => {
    const index = byUpper.get(name.toUpperCase());
    if (index === undefined) {
      if (required) {
        throw new BulkFormatError(
          `${tableName}: required column ${name} not found (has: ${table.columns.join(", ")})`,
        );
      }
      return -1;
    }
    return index;
  };
}

export function cell(row: string[], index: number): string | null {
  if (index < 0) return null;
  const raw = row[index];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

/**
 * DERA sets have shipped dates as `DD-MON-YYYY` (Oracle-style); accept that
 * plus plain `YYYY-MM-DD` and compact `YYYYMMDD` so a quiet format shift
 * degrades to a parse failure count, never a wrong date. [verify-live]
 */
export function normalizeSetDate(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const oracle = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (oracle) {
    const month = MONTHS[(oracle[2] as string).toUpperCase()];
    if (!month) return null;
    return `${oracle[3]}-${month}-${(oracle[1] as string).padStart(2, "0")}`;
  }
  const iso = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  if (/^\d{8}$/.test(value))
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return null;
}

export function numberValue(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function flagValue(raw: string | null): boolean {
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "y" || value === "yes";
}
