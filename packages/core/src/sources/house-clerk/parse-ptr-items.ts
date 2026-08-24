import {
  congressTradeId,
  congressTradeSchema,
  type CongressTrade,
} from "../../schema/congress-trade.js";
import { parseAmountRange } from "../../lib/amount-ranges.js";
import type { PositionedTextItem } from "./pdf-text.js";

/**
 * Layout-aware parser for House Clerk PTR PDFs (parser id house-ptr-pdf@1,
 * confidence 0.9). Input is the positioned text layer, not bytes — golden
 * fixtures are PositionedTextItem[] JSON, so the parser is testable without
 * a single PDF.
 *
 * The transactions table is located by its header row (ID / Owner / Asset /
 * Transaction Type / Date / Notification Date / Amount); the header items'
 * x positions define the column boundaries every following row is sliced
 * against. Ranges stay ranges; anything uncertain sets needsReview instead
 * of guessing.
 */

export const HOUSE_PTR_PARSER = "house-ptr-pdf@1";
export const HOUSE_PTR_CONFIDENCE = 0.9 as const;

/** Items whose baselines differ by no more than this are one visual line. */
const Y_TOLERANCE = 2.5;
/** Items may start slightly left of their column's header x (kerning). */
const COLUMN_X_TOLERANCE = 1.5;

export interface PtrParseInput {
  items: PositionedTextItem[];
  docId: string;
  /** Filing date from the yearly index row (the PDF prints only per-row dates). */
  filedAt: string;
  /** Member block resolved by the caller; stamped on every row. */
  member: CongressTrade["member"];
  sourceUrl: string;
  retrievedAt: string;
}

export interface PtrParseResult {
  rows: CongressTrade[];
  /**
   * Normalized transactions-table header (top header line's items, x-ordered,
   * upper-cased, "|"-joined) — the layout-drift fingerprint input. Null when
   * no transactions table was found.
   */
  headerSignature: string | null;
  /** attempted = transaction row blocks detected; succeeded = valid rows emitted. */
  stats: { attempted: number; succeeded: number };
}

interface Line {
  page: number;
  y: number;
  items: PositionedTextItem[];
}

/** Groups items into visual lines: per page, y within tolerance, x-ordered. */
export function groupIntoLines(items: PositionedTextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && current.page === item.page && Math.abs(current.y - item.y) <= Y_TOLERANCE) {
      current.items.push(item);
    } else {
      lines.push({ page: item.page, y: item.y, items: [item] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(line: Line): string {
  return line.items
    .map((i) => i.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

type ColumnKey = "id" | "owner" | "asset" | "type" | "date" | "notification" | "amount" | "extra";

interface Column {
  key: ColumnKey;
  x: number;
}

/**
 * The header's top line: every column label starts here ("Transaction Type",
 * "Notification Date" and "Cap. Gains > $200?" wrap onto follow-up lines, so
 * only the first word of each participates).
 */
function detectHeaderColumns(line: Line): Column[] | null {
  const columns: Column[] = [];
  let sawOwner = false;
  let sawAsset = false;
  let sawType = false;
  let sawDate = false;
  let sawNotification = false;
  let sawAmount = false;
  for (const item of line.items) {
    const label = item.text.trim().toLowerCase();
    if (label === "id") {
      columns.push({ key: "id", x: item.x });
    } else if (label === "owner") {
      sawOwner = true;
      columns.push({ key: "owner", x: item.x });
    } else if (label === "asset") {
      sawAsset = true;
      columns.push({ key: "asset", x: item.x });
    } else if (label.startsWith("transaction")) {
      sawType = true;
      columns.push({ key: "type", x: item.x });
    } else if (label === "date" && sawType && !sawDate) {
      sawDate = true;
      columns.push({ key: "date", x: item.x });
    } else if (label.startsWith("notification")) {
      sawNotification = true;
      columns.push({ key: "notification", x: item.x });
    } else if (label.startsWith("amount")) {
      sawAmount = true;
      columns.push({ key: "amount", x: item.x });
    } else {
      // Cap-gains flag or any future column: tracked so row slicing does not
      // spill unknown-column text into the amount, but otherwise unused.
      columns.push({ key: "extra", x: item.x });
    }
  }
  if (!sawOwner || !sawAsset || !sawType || !sawDate || !sawNotification || !sawAmount) return null;
  return columns;
}

function headerSignatureOf(line: Line): string {
  return line.items
    .map((i) => i.text.replace(/\s+/g, " ").trim().toUpperCase())
    .filter((t) => t.length > 0)
    .join("|");
}

/**
 * "Transaction Type", "Notification Date" and "Cap. Gains > $200?" wrap
 * their tail words onto the lines below the header. A line made up solely of
 * those words is header furniture, never row content — recognized explicitly
 * so a row that continues across a page boundary (below a repeated header)
 * still merges into the right row.
 */
const HEADER_WRAP_WORD = /^(type|date|gains\s*>?|\$200\??)$/i;

function isHeaderWrapLine(line: Line): boolean {
  return line.items.every((i) => HEADER_WRAP_WORD.test(i.text.trim()));
}

/** Assigns an item to the last column starting at or left of it. */
function columnFor(columns: Column[], item: PositionedTextItem): ColumnKey {
  let key: ColumnKey = columns[0]?.key ?? "id";
  for (const column of columns) {
    if (item.x + COLUMN_X_TOLERANCE >= column.x) key = column.key;
    else break;
  }
  return key;
}

/** Lines that end the transactions table (report footer sections). */
const TABLE_END =
  /^(\*\s*for the complete list|initial public offerings|asset class details|transactions? totals?|certification and signature)/i;
/** Per-row annotation lines printed inside the table but not part of any cell. */
const ROW_ANNOTATION =
  /^(filing status|subholding of|description|location|comments|filing id)\s*:/i;

/** "08/12/2026" → "2026-08-12"; null when not a plausible M/D/YYYY date. */
function normalizeRowDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const OWNER_CODES: Record<string, NonNullable<CongressTrade["owner"]>> = {
  "": "self",
  SP: "spouse",
  JT: "joint",
  DC: "dependent",
};

/**
 * fd.house.gov asset-type codes (the bracketed tag at the end of the asset
 * text) mapped into the schema's coarse asset classes. Unknown tags fall
 * through to the keyword heuristic, then to "other".
 */
const ASSET_TAG_TYPES: Record<string, CongressTrade["assetType"]> = {
  ST: "stock",
  PS: "stock",
  OP: "option",
  OT: "other",
  GS: "bond",
  CS: "bond",
  AB: "bond",
  CT: "crypto",
  MF: "fund",
  EF: "fund",
  MO: "fund",
  HE: "fund",
  PE: "fund",
  RE: "fund",
};

/** Heuristic ticker: last parenthesized ALL-CAPS symbol, e.g. "(MSFT)" or "(BRK.B)". */
export function extractTicker(assetText: string): string | null {
  let ticker: string | null = null;
  for (const match of assetText.matchAll(/\(([A-Z0-9.]{1,6})\)/g)) {
    const candidate = match[1] ?? "";
    if (/[A-Z]/.test(candidate)) ticker = candidate;
  }
  return ticker;
}

/** Asset-class heuristic: the bracketed fd.house.gov tag first, then keywords. */
export function classifyAssetType(
  assetText: string,
  ticker: string | null,
): CongressTrade["assetType"] {
  let tag: string | null = null;
  for (const match of assetText.matchAll(/\[([A-Z]{2})\]/g)) tag = match[1] ?? null;
  const tagged = tag === null ? undefined : ASSET_TAG_TYPES[tag];
  if (tagged) return tagged;
  if (/\b(call|put|option)s?\b/i.test(assetText)) return "option";
  if (/\b(bond|note|notes|bill|treasur\w*|debenture|municipal)\b/i.test(assetText)) return "bond";
  if (/\b(bitcoin|ethereum|crypto\w*|token|coin)\b/i.test(assetText)) return "crypto";
  if (/\b(fund|etf|trust|index)\b/i.test(assetText)) return "fund";
  if (ticker) return "stock";
  return "other";
}

/** "P" → buy, "S"/"S (partial)" → sell, "E" → exchange; null when unrecognized. */
function classifySide(raw: string): CongressTrade["side"] | null {
  const token = raw
    .replace(/\(\s*partial\s*\)/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (token === "P") return "buy";
  if (token === "S") return "sell";
  if (token === "E") return "exchange";
  return null;
}

interface RowBlock {
  cells: Record<ColumnKey, string[]>;
}

function emptyRowBlock(): RowBlock {
  return {
    cells: {
      id: [],
      owner: [],
      asset: [],
      type: [],
      date: [],
      notification: [],
      amount: [],
      extra: [],
    },
  };
}

function cellText(block: RowBlock, key: ColumnKey): string {
  return block.cells[key].join(" ").replace(/\s+/g, " ").trim();
}

export function parsePtrItems(input: PtrParseInput): PtrParseResult {
  const lines = groupIntoLines(input.items);

  // Locate the transactions table header.
  let headerIndex = -1;
  let columns: Column[] | null = null;
  let headerSignature: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line;
    const detected = detectHeaderColumns(line);
    if (detected) {
      headerIndex = i;
      columns = detected;
      headerSignature = headerSignatureOf(line);
      break;
    }
  }
  if (headerIndex === -1 || !columns) {
    return { rows: [], headerSignature: null, stats: { attempted: 0, succeeded: 0 } };
  }

  // Collect row blocks: a new block starts on a line with transaction-date
  // column content; other lines continue the block above (wrapped asset
  // descriptions and amounts) or are skipped (annotations, repeated headers).
  const blocks: RowBlock[] = [];
  let current: RowBlock | null = null;
  let ended = false;
  for (let i = headerIndex + 1; i < lines.length && !ended; i++) {
    const line = lines[i] as Line;
    const text = lineText(line);
    if (TABLE_END.test(text)) {
      ended = true;
      break;
    }
    if (detectHeaderColumns(line)) continue; // header repeated on a later page
    if (isHeaderWrapLine(line)) continue;
    if (ROW_ANNOTATION.test(text)) continue;

    const byColumn = new Map<ColumnKey, PositionedTextItem[]>();
    for (const item of line.items) {
      const key = columnFor(columns, item);
      const bucket = byColumn.get(key) ?? [];
      bucket.push(item);
      byColumn.set(key, bucket);
    }

    if (byColumn.has("date")) {
      current = emptyRowBlock();
      blocks.push(current);
    } else if (!current) {
      continue; // wrapped header words or page furniture above the first row
    }
    for (const [key, cellItems] of byColumn) {
      current.cells[key].push(...cellItems.map((i) => i.text));
    }
  }

  const rows: CongressTrade[] = [];
  const stats = { attempted: 0, succeeded: 0 };

  blocks.forEach((block, rowIndex) => {
    stats.attempted += 1;
    let needsReview = false;

    const ownerRaw = cellText(block, "owner").toUpperCase();
    let owner: CongressTrade["owner"];
    if (ownerRaw in OWNER_CODES) {
      owner = OWNER_CODES[ownerRaw] ?? null;
    } else {
      owner = null; // unrecognized owner code — kept for review, never guessed
      needsReview = true;
    }

    const assetDescription = cellText(block, "asset");
    const side = classifySide(cellText(block, "type"));
    const transactedAt = normalizeRowDate(cellText(block, "date"));
    const amountText = cellText(block, "amount");
    if (!assetDescription || !side || !transactedAt || !amountText) {
      return; // not representable without guessing — counted against the parse rate
    }

    const parsedAmount = parseAmountRange(amountText);
    const amountRange = parsedAmount
      ? { min: parsedAmount.min, max: parsedAmount.max, text: amountText }
      : { min: 0, max: null, text: amountText }; // unknown bounds, verbatim text
    if (!parsedAmount) needsReview = true;

    const ticker = extractTicker(assetDescription);
    const candidate: CongressTrade = {
      id: congressTradeId("house", input.docId, rowIndex),
      chamber: "house",
      docId: input.docId,
      rowIndex,
      member: input.member,
      filedAt: input.filedAt,
      transactedAt,
      ticker,
      assetDescription,
      assetType: classifyAssetType(assetDescription, ticker),
      side,
      amountRange,
      owner,
      provenance: {
        source: "house-clerk",
        sourceUrl: input.sourceUrl,
        retrievedAt: input.retrievedAt,
        parser: HOUSE_PTR_PARSER,
        confidence: HOUSE_PTR_CONFIDENCE,
        needsReview,
      },
    };
    const validated = congressTradeSchema.safeParse(candidate);
    if (!validated.success) return;
    rows.push(validated.data);
    stats.succeeded += 1;
  });

  return { rows, headerSignature, stats };
}
