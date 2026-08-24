/**
 * Congressional disclosure amounts are ranges, never exact values. This
 * module parses the printed range text into { min, max } bounds and nothing
 * more — Docket never fabricates midpoints or point estimates.
 */

export interface AmountRange {
  min: number;
  /** Null for open-ended top ranges ("Over $50,000,000"). */
  max: number | null;
}

function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * Parses the disclosure range text used on Senate eFD and House Clerk PTRs.
 * Handles "X - Y", "Over X", "X +", and "None (or less than $1,001)".
 * Returns null when the text is not a recognizable range — callers must then
 * flag the row for review rather than guessing.
 */
export function parseAmountRange(raw: string): AmountRange | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  if (/^none\b/i.test(text)) {
    // "None (or less than $1,001)" — the sub-reporting-threshold bucket.
    return { min: 0, max: 1_000 };
  }

  const over = text.match(/^over\s+(.+)$/i);
  if (over && over[1]) {
    const min = parseMoney(over[1]);
    return min === null ? null : { min, max: null };
  }

  const plus = text.match(/^(.+?)\s*\+$/);
  if (plus && plus[1]) {
    const min = parseMoney(plus[1]);
    return min === null ? null : { min, max: null };
  }

  const pair = text.split(/\s*[-–—]\s*/);
  if (pair.length === 2 && pair[0] && pair[1]) {
    const min = parseMoney(pair[0]);
    const max = parseMoney(pair[1]);
    if (min !== null && max !== null && max >= min) return { min, max };
  }

  return null;
}
