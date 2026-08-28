import { BILL_TYPES, type BillType } from "./client.js";
import { extractAllBlocks, extractBlock, extractTag, withoutBlock } from "./xml.js";

/**
 * Parser for one BILLSTATUS XML document (GPO GovInfo bulk data). Pulls the
 * handful of fields LuxAlgo Alt Data publishes out of the `<bill>` element;
 * everything else in the document (actions history, committees, related
 * bills, full CBO estimates, …) is left unread. See `xml.ts` for the
 * tolerant tag/block primitives this is built from.
 *
 * Parser id: `govinfo-billstatus@1`.
 */

export interface BillXmlContext {
  /** Congress and bill type/number requested — cross-checked against what the XML itself says. */
  congress: number;
  billType: string;
  billNumber: number;
}

export interface ParsedBillFields {
  congress: number;
  billType: string;
  billNumber: number;
  title: string;
  introducedDate: string;
  latestActionDate: string | null;
  latestActionText: string | null;
  sponsorBioguideId: string | null;
  sponsorName: string | null;
  policyArea: string | null;
  cosponsorCount: number;
}

export class BillXmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillXmlParseError";
  }
}

function requireDateString(raw: string | null, field: string): string {
  const sliced = raw?.slice(0, 10);
  if (!sliced || !/^\d{4}-\d{2}-\d{2}$/.test(sliced)) {
    throw new BillXmlParseError(`unusable <${field}> '${raw ?? ""}'`);
  }
  return sliced;
}

function optionalDateString(raw: string | null): string | null {
  const sliced = raw?.slice(0, 10);
  return sliced && /^\d{4}-\d{2}-\d{2}$/.test(sliced) ? sliced : null;
}

/**
 * Parses one `<bill>…</bill>` document. Throws `BillXmlParseError` for any
 * required field that's missing or unusable, or when the document's own
 * congress/type/number disagree with what was requested — callers treat
 * that throw as one skip-and-count parse failure, never a partial row.
 */
export function parseBillStatusXml(xml: string, context: BillXmlContext): ParsedBillFields {
  const bill = extractBlock(xml, "bill");
  if (!bill) throw new BillXmlParseError("no <bill> element found");

  const congressRaw = extractTag(bill, "congress");
  const congress = congressRaw ? Number(congressRaw) : NaN;
  if (!Number.isInteger(congress) || congress <= 0) {
    throw new BillXmlParseError(`unusable <congress> '${congressRaw ?? ""}'`);
  }
  if (congress !== context.congress) {
    throw new BillXmlParseError(
      `<congress> ${congress} does not match requested congress ${context.congress}`,
    );
  }

  const billTypeRaw = extractTag(bill, "type");
  const billType = (billTypeRaw ?? "").toLowerCase();
  if (!BILL_TYPES.includes(billType as BillType)) {
    throw new BillXmlParseError(`unrecognized <type> '${billTypeRaw ?? ""}'`);
  }
  if (billType !== context.billType) {
    throw new BillXmlParseError(
      `<type> '${billType}' does not match requested type '${context.billType}'`,
    );
  }

  const numberRaw = extractTag(bill, "number");
  const billNumber = numberRaw ? Number(numberRaw) : NaN;
  if (!Number.isInteger(billNumber) || billNumber <= 0) {
    throw new BillXmlParseError(`unusable <number> '${numberRaw ?? ""}'`);
  }
  if (billNumber !== context.billNumber) {
    throw new BillXmlParseError(
      `<number> ${billNumber} does not match requested number ${context.billNumber}`,
    );
  }

  // BILLSTATUS carries both a single top-level <title> (the display title)
  // and a <titles> list of every title variant, each item of which has its
  // own <title>. Excluding the <titles> block before searching guarantees
  // the top-level one is what's read, regardless of which happens to come
  // first in the live document's element order ([verify-live]).
  const title = extractTag(withoutBlock(bill, "titles"), "title");
  if (!title) throw new BillXmlParseError("missing <title>");

  const introducedDate = requireDateString(extractTag(bill, "introducedDate"), "introducedDate");

  const latestAction = extractBlock(bill, "latestAction");
  const latestActionDate = latestAction
    ? optionalDateString(extractTag(latestAction, "actionDate"))
    : null;
  const latestActionText = latestAction ? extractTag(latestAction, "text") : null;

  const sponsors = extractBlock(bill, "sponsors");
  const firstSponsor = sponsors ? extractBlock(sponsors, "item") : null;
  const sponsorBioguideId = firstSponsor ? extractTag(firstSponsor, "bioguideId") : null;
  const sponsorName = firstSponsor ? extractTag(firstSponsor, "fullName") : null;

  const policyAreaBlock = extractBlock(bill, "policyArea");
  const policyArea = policyAreaBlock ? extractTag(policyAreaBlock, "name") : null;

  const cosponsors = extractBlock(bill, "cosponsors");
  const cosponsorCount = cosponsors ? extractAllBlocks(cosponsors, "item").length : 0;

  return {
    congress,
    billType,
    billNumber,
    title,
    introducedDate,
    latestActionDate,
    latestActionText,
    sponsorBioguideId,
    sponsorName,
    policyArea,
    cosponsorCount,
  };
}
