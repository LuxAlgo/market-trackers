import { XMLParser } from "fast-xml-parser";
import {
  thirteenfHoldingId,
  thirteenfHoldingSchema,
  type ThirteenfHolding,
} from "../../schema/thirteenf-holding.js";
import { extractXmlDocuments, parseSecHeader, padCik } from "./full-submission.js";

/**
 * Parser for 13F-HR information tables (EDGAR full-submission .txt).
 *
 * Parser id: thirteenf-xml@1
 *
 * Value units: filings for periods ending before 2023-01-01 report value in
 * thousands of dollars; later periods report whole dollars. `valueUsd` is
 * normalized to whole dollars for every era.
 *
 * Tickers are not present in 13F filings (holdings are CUSIP-keyed); the
 * sync layer resolves them from the CUSIP cache and leaves null otherwise.
 */

export const THIRTEENF_PARSER = "thirteenf-xml@1";

export interface ThirteenfParseInput {
  text: string;
  accessionNumber: string;
  filedAt: string;
  sourceUrl: string;
  retrievedAt: string;
}

export interface ThirteenfParseResult {
  rows: ThirteenfHolding[];
  managerCik: string;
  managerName: string;
  periodEnd: string;
  /** CUSIPs seen in this filing, for batch resolution. */
  cusips: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === "infoTable",
});

export class ThirteenfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThirteenfParseError";
  }
}

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  const s = String(node).trim();
  return s === "" ? null : s;
}

function num(node: unknown): number | null {
  const raw = text(node);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Periods ending before this date report value in thousands. */
const VALUE_IN_THOUSANDS_BEFORE = "2023-01-01";

export function parseThirteenf(input: ThirteenfParseInput): ThirteenfParseResult {
  const header = parseSecHeader(input.text);
  const managerName = header.companyName;
  const managerCikRaw = header.centralIndexKey;
  const periodEnd = header.periodOfReport;
  if (!managerName || !managerCikRaw || !periodEnd) {
    throw new ThirteenfParseError(
      `Missing filer metadata in SEC header of ${input.accessionNumber}`,
    );
  }
  const managerCik = padCik(managerCikRaw);

  let entries: Record<string, unknown>[] | null = null;
  for (const xml of extractXmlDocuments(input.text)) {
    try {
      const parsed = parser.parse(xml) as Record<string, unknown>;
      const table = parsed.informationTable as Record<string, unknown> | undefined;
      if (table?.infoTable) {
        entries = table.infoTable as Record<string, unknown>[];
        break;
      }
    } catch {
      // Not this block.
    }
  }
  if (!entries) {
    throw new ThirteenfParseError(`No informationTable found in ${input.accessionNumber}`);
  }

  const inThousands = periodEnd < VALUE_IN_THOUSANDS_BEFORE;
  const rows: ThirteenfHolding[] = [];
  const cusips = new Set<string>();

  entries.forEach((entry, index) => {
    const cusip = text(entry.cusip);
    const issuerName = text(entry.nameOfIssuer);
    const value = num(entry.value);
    const shrs = (entry.shrsOrPrnAmt ?? {}) as Record<string, unknown>;
    const shares = num(shrs.sshPrnamt);
    if (!cusip || !issuerName || value === null || shares === null) {
      throw new ThirteenfParseError(`Malformed infoTable row ${index} in ${input.accessionNumber}`);
    }
    cusips.add(cusip);
    const shareTypeRaw = text(shrs.sshPrnamtType)?.toUpperCase() ?? null;
    const putCallRaw = text(entry.putCall)?.toLowerCase() ?? null;

    rows.push(
      thirteenfHoldingSchema.parse({
        id: thirteenfHoldingId(input.accessionNumber, index),
        accessionNumber: input.accessionNumber,
        managerCik,
        managerName,
        periodEnd,
        filedAt: input.filedAt,
        cusip,
        ticker: null,
        issuerName,
        shareType: shareTypeRaw === "SH" || shareTypeRaw === "PRN" ? shareTypeRaw : null,
        shares,
        valueUsd: inThousands ? value * 1_000 : value,
        putCall: putCallRaw === "put" || putCallRaw === "call" ? putCallRaw : null,
        provenance: {
          source: "edgar",
          sourceUrl: input.sourceUrl,
          retrievedAt: input.retrievedAt,
          parser: THIRTEENF_PARSER,
          confidence: 1,
          needsReview: false,
        },
      } satisfies ThirteenfHolding),
    );
  });

  return { rows, managerCik, managerName, periodEnd, cusips: [...cusips] };
}
