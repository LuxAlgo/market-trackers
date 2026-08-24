import { XMLParser } from "fast-xml-parser";
import {
  insiderTransactionId,
  insiderTransactionSchema,
  type InsiderTransaction,
} from "../../schema/insider-transaction.js";
import { extractXmlDocuments, padCik } from "./full-submission.js";

/**
 * Parser for SEC Forms 3/4/5 ownership documents — the primary XML embedded
 * in the filing, never the HTML rendering. Emits one row per transaction or
 * holding entry, in document order, with a stable natural key.
 *
 * Parser id: form-ownership-xml@1
 *
 * Known scope limits (tracked in docs/sources/edgar.md):
 *  - Filings with multiple reporting owners are attributed to the first
 *    listed owner (rows are per-transaction, so share counts stay correct).
 *  - Footnotes are not extracted yet.
 */

export const FORM_OWNERSHIP_PARSER = "form-ownership-xml@1";

export interface OwnershipParseInput {
  /** Full-submission .txt content or bare ownershipDocument XML. */
  text: string;
  accessionNumber: string;
  /** Filing date (YYYY-MM-DD), from the daily index or SEC header. */
  filedAt: string;
  /** Canonical provenance deep link (the filing index page). */
  sourceUrl: string;
  retrievedAt: string;
}

export interface OwnershipParseResult {
  rows: InsiderTransaction[];
  issuerCik: string;
  /** Null when the filing omits or blanks the trading symbol. */
  ticker: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Values stay strings: number coercion would destroy zero-padded CIKs.
  parseTagValue: false,
  isArray: (name) =>
    [
      "reportingOwner",
      "nonDerivativeTransaction",
      "derivativeTransaction",
      "nonDerivativeHolding",
      "derivativeHolding",
      "footnote",
    ].includes(name),
});

type XmlNode = Record<string, unknown> | string | undefined | null;

/** Ownership XML wraps most leaf values as `<x><value>…</value></x>`. */
function val(node: XmlNode): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node.trim() === "" ? null : node.trim();
  if (typeof node === "object") {
    const inner = (node as Record<string, unknown>).value;
    if (typeof inner === "string") return inner.trim() === "" ? null : inner.trim();
    if (typeof inner === "number") return String(inner);
  }
  return null;
}

function num(node: XmlNode): number | null {
  const raw = val(node);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function flag(node: XmlNode): boolean {
  const raw = val(node);
  return raw === "1" || raw?.toLowerCase() === "true";
}

function dateOnly(node: XmlNode): string | null {
  const raw = val(node);
  if (!raw) return null;
  const sliced = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(sliced) ? sliced : null;
}

function normalizeTicker(raw: string | null): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();
  if (upper === "" || upper === "NONE" || upper === "N/A" || upper === "NA") return null;
  return upper;
}

export class OwnershipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipParseError";
  }
}

export function parseOwnershipForm(input: OwnershipParseInput): OwnershipParseResult {
  const documents = extractXmlDocuments(input.text);
  let doc: Record<string, unknown> | null = null;
  for (const xml of documents) {
    try {
      const parsed = parser.parse(xml) as Record<string, unknown>;
      if (parsed.ownershipDocument) {
        doc = parsed.ownershipDocument as Record<string, unknown>;
        break;
      }
    } catch {
      // Not this block; keep looking.
    }
  }
  if (!doc) {
    throw new OwnershipParseError(`No ownershipDocument XML found in ${input.accessionNumber}`);
  }

  const formType = val(doc.documentType as XmlNode);
  if (!formType || !["3", "4", "5", "3/A", "4/A", "5/A"].includes(formType)) {
    throw new OwnershipParseError(
      `Unexpected documentType '${formType ?? "?"}' in ${input.accessionNumber}`,
    );
  }

  const issuer = (doc.issuer ?? {}) as Record<string, XmlNode>;
  const issuerCikRaw = val(issuer.issuerCik);
  const issuerName = val(issuer.issuerName);
  if (!issuerCikRaw || !issuerName) {
    throw new OwnershipParseError(`Missing issuer in ${input.accessionNumber}`);
  }
  const issuerCik = padCik(issuerCikRaw);
  const ticker = normalizeTicker(val(issuer.issuerTradingSymbol));

  const owners = (doc.reportingOwner ?? []) as Record<string, unknown>[];
  const firstOwner = owners[0];
  if (!firstOwner) {
    throw new OwnershipParseError(`No reportingOwner in ${input.accessionNumber}`);
  }
  const ownerId = (firstOwner.reportingOwnerId ?? {}) as Record<string, XmlNode>;
  const relationship = (firstOwner.reportingOwnerRelationship ?? {}) as Record<string, XmlNode>;
  const ownerName = val(ownerId.rptOwnerName);
  const ownerCikRaw = val(ownerId.rptOwnerCik);
  if (!ownerName || !ownerCikRaw) {
    throw new OwnershipParseError(`Missing reporting owner identity in ${input.accessionNumber}`);
  }

  const insider = {
    name: ownerName,
    cik: padCik(ownerCikRaw),
    title: val(relationship.officerTitle),
    isDirector: flag(relationship.isDirector),
    isOfficer: flag(relationship.isOfficer),
    isTenPctOwner: flag(relationship.isTenPercentOwner),
  };

  const rows: InsiderTransaction[] = [];

  function pushRow(
    table: "nd" | "d",
    index: number,
    entry: Record<string, unknown>,
    kind: "transaction" | "holding",
  ) {
    const coding = (entry.transactionCoding ?? {}) as Record<string, XmlNode>;
    const amounts = (entry.transactionAmounts ?? {}) as Record<string, XmlNode>;
    const post = (entry.postTransactionAmounts ?? {}) as Record<string, XmlNode>;
    const nature = (entry.ownershipNature ?? {}) as Record<string, XmlNode>;

    const directOrIndirect = val(nature.directOrIndirectOwnership);
    const row: InsiderTransaction = {
      id: insiderTransactionId(input.accessionNumber, table, index),
      accessionNumber: input.accessionNumber,
      formType: formType as InsiderTransaction["formType"],
      ticker,
      issuerCik,
      issuerName: issuerName as string,
      insider,
      transactedAt: kind === "transaction" ? dateOnly(entry.transactionDate as XmlNode) : null,
      filedAt: input.filedAt,
      code: kind === "transaction" ? val(coding.transactionCode) : null,
      acquiredDisposed:
        kind === "transaction"
          ? ((val(amounts.transactionAcquiredDisposedCode) as "A" | "D" | null) ?? null)
          : null,
      securityTitle: val(entry.securityTitle as XmlNode) ?? "Unknown security",
      shares: kind === "transaction" ? num(amounts.transactionShares) : null,
      pricePerShare: kind === "transaction" ? num(amounts.transactionPricePerShare) : null,
      sharesOwnedAfter: num(post.sharesOwnedFollowingTransaction),
      ownership: directOrIndirect === "I" ? "indirect" : "direct",
      isDerivative: table === "d",
      provenance: {
        source: "edgar",
        sourceUrl: input.sourceUrl,
        retrievedAt: input.retrievedAt,
        parser: FORM_OWNERSHIP_PARSER,
        confidence: 1,
        needsReview: false,
      },
    };
    rows.push(insiderTransactionSchema.parse(row));
  }

  const ndTable = (doc.nonDerivativeTable ?? {}) as Record<string, unknown>;
  const dTable = (doc.derivativeTable ?? {}) as Record<string, unknown>;

  let ndIndex = 0;
  for (const entry of (ndTable.nonDerivativeTransaction ?? []) as Record<string, unknown>[]) {
    pushRow("nd", ndIndex++, entry, "transaction");
  }
  for (const entry of (ndTable.nonDerivativeHolding ?? []) as Record<string, unknown>[]) {
    pushRow("nd", ndIndex++, entry, "holding");
  }

  let dIndex = 0;
  for (const entry of (dTable.derivativeTransaction ?? []) as Record<string, unknown>[]) {
    pushRow("d", dIndex++, entry, "transaction");
  }
  for (const entry of (dTable.derivativeHolding ?? []) as Record<string, unknown>[]) {
    pushRow("d", dIndex++, entry, "holding");
  }

  return { rows, issuerCik, ticker };
}
