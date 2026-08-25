import { billReferenceToken } from "../../schema/bill.js";

/**
 * Conservative regex extraction of explicit bill references from free text
 * (an LDA filing's specific-issues narrative, in practice). Recognizes only
 * the eight bill/resolution types GovInfo BILLSTATUS codes — `hr`, `s`,
 * `hjres`, `sjres`, `hconres`, `sconres`, `hres`, `sres` — written either in
 * the standard dotted abbreviation ("H.R. 1234", "S.Con.Res. 7") or fully
 * dotless ("HR 1234", "SConRes 7"). Never infers a reference from context;
 * a filing with no explicit citation yields an empty list.
 *
 * Guards against false positives:
 *  - Every alternative is anchored by `\b` on both sides of the type token,
 *    so it must stand alone as its own word — "HRS 200" never matches "HR"
 *    (no boundary between "R" and the trailing "S"), and "US 101" never
 *    matches "S" (no boundary between "U" and "S").
 *  - The single/double-letter dotless tokens ("HR", "S") are matched
 *    case-sensitively, uppercase only — lowercase "hr"/"s" are common
 *    English words and abbreviations ("s 100 million" must not match).
 *  - A dotted token ("H.R.", "S.Con.Res.") allows zero or one whitespace
 *    character before the number ("H.R. 1234" and "H.R.1234" both match);
 *    a dotless token requires exactly one — "HR1234" with no separator at
 *    all is deliberately not recognized, since without the period there is
 *    nothing to visually anchor the token against a run-on number.
 *  - Bill numbers are 1–5 digits; a longer digit run never matches (the
 *    trailing `\b` only holds at exactly 1–5 digits, so e.g. a phone or
 *    tracking number never gets misread as a bill).
 *
 * Matches are collected across all sixteen (type × form) patterns, sorted
 * back into the order they actually appear in the text, then normalized
 * through `billReferenceToken()` and deduplicated, keeping first-seen order.
 */

interface BillTypeSpec {
  billType: string;
  /** Regex source for the dotted form, ending in a literal period. */
  dotted: string;
  /** Regex source for the fully dotless form. */
  dotless: string;
}

const TYPE_SPECS: readonly BillTypeSpec[] = [
  { billType: "hjres", dotted: "H\\.J\\.Res\\.", dotless: "HJRes" },
  { billType: "sjres", dotted: "S\\.J\\.Res\\.", dotless: "SJRes" },
  { billType: "hconres", dotted: "H\\.Con\\.Res\\.", dotless: "HConRes" },
  { billType: "sconres", dotted: "S\\.Con\\.Res\\.", dotless: "SConRes" },
  { billType: "hres", dotted: "H\\.Res\\.", dotless: "HRes" },
  { billType: "sres", dotted: "S\\.Res\\.", dotless: "SRes" },
  { billType: "hr", dotted: "H\\.R\\.", dotless: "HR" },
  { billType: "s", dotted: "S\\.", dotless: "S" },
];

interface CompiledPattern {
  billType: string;
  regex: RegExp;
}

const PATTERNS: readonly CompiledPattern[] = TYPE_SPECS.flatMap((spec) => [
  { billType: spec.billType, regex: new RegExp(`\\b${spec.dotted}\\s?(\\d{1,5})\\b`, "g") },
  { billType: spec.billType, regex: new RegExp(`\\b${spec.dotless}\\s(\\d{1,5})\\b`, "g") },
]);

interface RawMatch {
  index: number;
  billType: string;
  billNumber: number;
}

/**
 * Extracts every explicit bill reference in `text`, normalized to a
 * `billReferenceToken()` string (e.g. `"hr1234"`), deduplicated, in the
 * order each reference first appears.
 */
export function extractBillReferences(text: string): string[] {
  if (!text) return [];

  const matches: RawMatch[] = [];
  for (const { billType, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const digits = match[1];
      if (match.index === undefined || digits === undefined) continue;
      matches.push({ index: match.index, billType, billNumber: Number(digits) });
    }
  }
  matches.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const { billType, billNumber } of matches) {
    const token = billReferenceToken(billType, billNumber);
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}
