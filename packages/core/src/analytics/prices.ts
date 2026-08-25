import { addDays, toDateString } from "../lib/dates.js";

/**
 * Bring-your-own-prices: LuxAlgo Alt Data ships no price data. This module only reads
 * a price series the caller supplies and answers a mechanical lookup — "what
 * was the close on or after a given date" — never a model, a signal, or an
 * estimate of a price that wasn't actually supplied.
 */

export interface PricePoint {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  ticker: string;
  close: number;
}

export interface PriceCsvWarning {
  /** 1-based line number in the source text (the header is line 1). */
  line: number;
  raw: string;
  reason: string;
}

export interface PriceLookupHit {
  found: true;
  point: PricePoint;
  /**
   * True when `point.date` differs from the requested date — the lookup
   * fell forward to the next available trading day within the search
   * window. A data-availability accommodation (weekends, holidays, gaps in
   * what the caller supplied) — never a model, and never a price that
   * wasn't in the supplied series.
   */
  forwardFilled: boolean;
}

export interface PriceLookupMiss {
  found: false;
  reason: string;
}

export type PriceLookup = PriceLookupHit | PriceLookupMiss;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_NUMBER_RE = /^\d+(\.\d+)?$/;
const REQUIRED_HEADER = ["date", "ticker", "close"];
const HEADER_HINT =
  "prices CSV must start with the header 'date,ticker,close' — expected rows like " +
  "'2026-08-18,ACME,41.90' (dates ISO YYYY-MM-DD, close a positive number)";

function isValidCalendarDate(date: string): boolean {
  if (!ISO_DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  // Date rolls invalid days (e.g. 2026-13-40) forward; a roundtrip mismatch
  // means the text wasn't a real calendar date, not that we should guess one.
  return !Number.isNaN(parsed.getTime()) && toDateString(parsed) === date;
}

/**
 * A parsed set of user-supplied prices, indexed by ticker for lookups.
 * Built by `parsePriceCsv`; the constructor is exposed for callers
 * assembling points from elsewhere (e.g. a dataframe already in memory)
 * while keeping the same lookup semantics.
 */
export class PriceSeries {
  readonly warnings: readonly PriceCsvWarning[];
  private readonly byTicker: ReadonlyMap<string, readonly PricePoint[]>;

  constructor(points: PricePoint[], warnings: PriceCsvWarning[] = []) {
    this.warnings = warnings;
    const grouped = new Map<string, PricePoint[]>();
    for (const point of points) {
      const ticker = point.ticker.toUpperCase();
      const list = grouped.get(ticker);
      if (list) list.push(point);
      else grouped.set(ticker, [point]);
    }
    // Sorted ascending by date so closeOn can scan forward and stop early.
    // Equal dates keep their original (file) order — first row wins ties.
    for (const list of grouped.values()) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    this.byTicker = grouped;
  }

  /** Total number of price points across every ticker. */
  get size(): number {
    let total = 0;
    for (const points of this.byTicker.values()) total += points.length;
    return total;
  }

  tickers(): string[] {
    return [...this.byTicker.keys()].sort();
  }

  /**
   * The close on `date`, or — when `searchForwardDays` is given — the
   * earliest close on or after `date` within that many days. Forward search
   * exists because a caller's price file may skip weekends, holidays, or
   * other gaps; it is a data-availability accommodation, not a model, and it
   * never estimates a price that wasn't in the supplied series.
   */
  closeOn(ticker: string, date: string, options: { searchForwardDays?: number } = {}): PriceLookup {
    const searchForwardDays = Math.max(0, options.searchForwardDays ?? 0);
    const key = ticker.toUpperCase();
    const points = this.byTicker.get(key);
    if (!points || points.length === 0) {
      return { found: false, reason: `no prices supplied for ticker '${key}'` };
    }

    const lastDate = addDays(date, searchForwardDays);
    for (const point of points) {
      if (point.date < date) continue;
      if (point.date > lastDate) break;
      return { found: true, point, forwardFilled: point.date !== date };
    }

    return {
      found: false,
      reason:
        searchForwardDays > 0
          ? `no price for '${key}' on ${date} or within ${searchForwardDays} day(s) after`
          : `no price for '${key}' on ${date}`,
    };
  }
}

/**
 * Parses a user-supplied price CSV: header `date,ticker,close`, then rows of
 * an ISO date, a ticker, and a positive close price. Malformed rows are
 * collected as warnings and excluded from the series — never guessed at,
 * coerced, or silently ignored without a reason attached.
 */
export function parsePriceCsv(text: string): PriceSeries {
  const lines = text.split(/\r\n|\r|\n/);

  let cursor = 0;
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor++;
  const headerLine = lines[cursor];
  const header = (headerLine ?? "").split(",").map((h) => h.trim().toLowerCase());
  const validHeader =
    headerLine !== undefined &&
    header.length === REQUIRED_HEADER.length &&
    header.every((h, i) => h === REQUIRED_HEADER[i]);
  if (!validHeader) {
    throw new Error(HEADER_HINT);
  }
  cursor++;

  const points: PricePoint[] = [];
  const warnings: PriceCsvWarning[] = [];

  for (; cursor < lines.length; cursor++) {
    const raw = lines[cursor] ?? "";
    const line = cursor + 1;
    if (raw.trim() === "") continue;

    const fields = raw.split(",");
    if (fields.length !== 3) {
      warnings.push({
        line,
        raw,
        reason: `expected 3 comma-separated fields (date,ticker,close), got ${fields.length}`,
      });
      continue;
    }

    const date = (fields[0] ?? "").trim();
    const ticker = (fields[1] ?? "").trim().toUpperCase();
    const closeText = (fields[2] ?? "").trim();

    if (!isValidCalendarDate(date)) {
      warnings.push({ line, raw, reason: `'${date}' is not a valid ISO date (YYYY-MM-DD)` });
      continue;
    }
    if (ticker.length === 0) {
      warnings.push({ line, raw, reason: "ticker is empty" });
      continue;
    }
    if (!POSITIVE_NUMBER_RE.test(closeText)) {
      warnings.push({ line, raw, reason: `'${closeText}' is not a positive number` });
      continue;
    }

    points.push({ date, ticker, close: Number(closeText) });
  }

  return new PriceSeries(points, warnings);
}
