import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import {
  congressTradeId,
  congressTradeSchema,
  type CongressTrade,
} from "../../schema/congress-trade.js";
import { parseAmountRange } from "../../lib/amount-ranges.js";
import { efdDateToIso } from "./client.js";

/**
 * Parser for web-table Periodic Transaction Report pages on Senate eFD
 * (`/search/view/ptr/{uuid}/`) — the primary HTML the site renders, one
 * table row per reported transaction.
 *
 * Parser id: efd-ptr-html@1 · confidence 0.9 (layout-parsed HTML).
 *
 * Amounts stay ranges: bounds via lib/amount-ranges with the printed text
 * kept verbatim. Range text the parser doesn't recognize is stored with
 * unknown bounds (`{ min: 0, max: null }`) and `needsReview: true` — never
 * a guess. Tickers are heuristic: `--`/blank → null, otherwise uppercased.
 */

export const EFD_PTR_HTML_PARSER = "efd-ptr-html@1";
export const EFD_PTR_HTML_CONFIDENCE = 0.9 as const;

export class EfdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EfdParseError";
  }
}

export interface PtrHtmlParseInput {
  html: string;
  /** Filing UUID (from the search grid link). */
  docId: string;
  /** Member name as listed on the search grid, verbatim. */
  memberName: string;
  /** Filed date (YYYY-MM-DD), from the search grid row. */
  filedAt: string;
  /** Canonical provenance deep link (the PTR view URL). */
  sourceUrl: string;
  retrievedAt: string;
}

export interface PtrHtmlParseResult {
  /** Member identity is left unresolved (bioguide/party/state null) — the source fills it in. */
  rows: CongressTrade[];
  /** Transaction-table header cells, for structural fingerprinting. */
  headerRow: string[];
}

function text(el: HTMLElement): string {
  return el.textContent.replace(/\s+/g, " ").trim();
}

/** The transactions table: the one whose header row names the load-bearing columns. */
function findTransactionTable(root: HTMLElement): { table: HTMLElement; header: string[] } {
  for (const table of root.querySelectorAll("table")) {
    const headerCells = table.querySelectorAll("thead th").map(text);
    const lower = headerCells.map((h) => h.toLowerCase());
    if (lower.includes("transaction date") && lower.includes("amount")) {
      return { table, header: headerCells };
    }
  }
  throw new EfdParseError("no transactions table found (header row missing expected columns)");
}

function columnIndex(header: string[], ...names: string[]): number {
  const lower = header.map((h) => h.toLowerCase());
  for (const name of names) {
    const index = lower.indexOf(name);
    if (index !== -1) return index;
  }
  throw new EfdParseError(
    `transactions table has no '${names[0]}' column (header: ${header.join(" | ")})`,
  );
}

function cellAt(cells: HTMLElement[], index: number): string {
  const cell = cells[index];
  return cell ? text(cell) : "";
}

function isBlank(value: string): boolean {
  return value === "" || /^-+$/.test(value);
}

export function mapOwner(raw: string): CongressTrade["owner"] {
  const value = raw.toLowerCase();
  if (isBlank(raw)) return null;
  if (value.includes("spouse")) return "spouse";
  if (value.includes("joint")) return "joint";
  if (value.includes("child") || value.includes("dependent")) return "dependent";
  if (value.includes("self")) return "self";
  return null;
}

export function mapAssetType(raw: string): CongressTrade["assetType"] {
  const value = raw.toLowerCase();
  if (value.includes("option")) return "option";
  if (value.includes("crypto")) return "crypto";
  if (
    value.includes("corporate bond") ||
    value.includes("municipal") ||
    value.includes("treasury") ||
    value.includes("note") ||
    value.includes("bond")
  ) {
    return "bond";
  }
  if (value.includes("mutual fund") || value.includes("etf") || value.includes("exchange traded")) {
    return "fund";
  }
  if (value.includes("stock")) return "stock";
  return "other";
}

function mapSide(raw: string): CongressTrade["side"] {
  const value = raw.toLowerCase();
  if (value.startsWith("purchase")) return "buy";
  if (value.startsWith("sale")) return "sell";
  if (value.startsWith("exchange")) return "exchange";
  throw new EfdParseError(`unrecognized transaction type '${raw}'`);
}

export function parsePtrHtml(input: PtrHtmlParseInput): PtrHtmlParseResult {
  const root = parseHtml(input.html);
  const { table, header } = findTransactionTable(root);

  const dateCol = columnIndex(header, "transaction date");
  const ownerCol = columnIndex(header, "owner");
  const tickerCol = columnIndex(header, "ticker");
  const assetCol = columnIndex(header, "asset name", "asset");
  const assetTypeCol = columnIndex(header, "asset type");
  const typeCol = columnIndex(header, "type", "transaction type");
  const amountCol = columnIndex(header, "amount");

  const rows: CongressTrade[] = [];
  const bodyRows = table.querySelectorAll("tbody tr");
  // rowIndex counts data rows only, so the natural key tracks the filing's
  // own 1-based transaction numbering (shifted to 0-based).
  let rowIndex = 0;
  for (const tr of bodyRows) {
    const cells = tr.querySelectorAll("td");
    if (cells.length === 0) continue; // spacer/nested-header rows carry no data

    const transactedAt = efdDateToIso(cellAt(cells, dateCol));
    if (!transactedAt) {
      throw new EfdParseError(
        `row ${rowIndex}: unparseable transaction date '${cellAt(cells, dateCol)}'`,
      );
    }

    const tickerRaw = cellAt(cells, tickerCol);
    const ticker = isBlank(tickerRaw) ? null : tickerRaw.toUpperCase();

    const assetDescription = cellAt(cells, assetCol);
    if (assetDescription.length === 0) {
      throw new EfdParseError(`row ${rowIndex}: empty asset description`);
    }

    const amountText = cellAt(cells, amountCol);
    if (amountText.length === 0) {
      throw new EfdParseError(`row ${rowIndex}: empty amount cell`);
    }
    const bounds = parseAmountRange(amountText);
    // Unknown bounds convention: unparseable range text keeps its verbatim
    // form with min 0 / max null, and the row is flagged for review.
    const amountRange = bounds
      ? { min: bounds.min, max: bounds.max, text: amountText }
      : { min: 0, max: null, text: amountText };
    const needsReview = bounds === null;

    rows.push(
      congressTradeSchema.parse({
        id: congressTradeId("senate", input.docId, rowIndex),
        chamber: "senate",
        docId: input.docId,
        rowIndex,
        member: { name: input.memberName, bioguideId: null, party: null, state: null },
        filedAt: input.filedAt,
        transactedAt,
        ticker,
        assetDescription,
        assetType: mapAssetType(cellAt(cells, assetTypeCol)),
        side: mapSide(cellAt(cells, typeCol)),
        amountRange,
        owner: mapOwner(cellAt(cells, ownerCol)),
        provenance: {
          source: "senate-efd",
          sourceUrl: input.sourceUrl,
          retrievedAt: input.retrievedAt,
          parser: EFD_PTR_HTML_PARSER,
          confidence: EFD_PTR_HTML_CONFIDENCE,
          needsReview,
        },
      } satisfies CongressTrade),
    );
    rowIndex += 1;
  }

  if (rows.length === 0) {
    throw new EfdParseError("transactions table has no data rows");
  }

  return { rows, headerRow: header };
}
