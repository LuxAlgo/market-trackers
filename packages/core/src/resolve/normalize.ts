/**
 * Entity-name normalization for matching across sources. Name matching is
 * where silent garbage enters a dataset, so this stays deliberately
 * conservative: strip legal-form suffixes and EDGAR state tags, never words
 * that carry identity ("GROUP", "HOLDINGS" stay).
 */

const LEGAL_SUFFIXES = new Set([
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "LTD",
  "LIMITED",
  "LLC",
  "LP",
  "LLP",
  "PLC",
  "SA",
  "NV",
  "AG",
]);

const SHARE_CLASS = /[\s-]*\bCL(?:ASS)?\s+[A-Z]$/;

export function normalizeEntityName(raw: string): string {
  let name = raw.toUpperCase();
  // EDGAR state-of-incorporation tags: "APPLE INC /CA/" → "APPLE INC".
  name = name.replace(/\s*\/[A-Z]{2}\/?\s*$/, "");
  name = name.replace(/&/g, " AND ");
  name = name.replace(SHARE_CLASS, "");
  // Drop punctuation, collapse whitespace.
  name = name
    .replace(/[.,'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = name.split(" ");
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1] as string;
    if (LEGAL_SUFFIXES.has(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens.join(" ");
}

/** Case/spacing-insensitive equality on normalized names. */
export function namesMatch(a: string, b: string): boolean {
  return normalizeEntityName(a) === normalizeEntityName(b);
}
