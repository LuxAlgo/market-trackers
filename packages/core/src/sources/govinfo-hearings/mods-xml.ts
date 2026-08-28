import type { CongressHearingCommittee } from "../../schema/congress-hearing.js";
import { decodeXmlEntities, extractAllBlocks, extractBlock, extractTag } from "../govinfo/xml.js";
import { hearingDetailsUrl, hearingModsUrl } from "./client.js";

/**
 * Parser for one CHRG package's MODS metadata document (GPO GovInfo). Pulls
 * the index fields LuxAlgo Market Trackers publishes — title, chamber, congress/session,
 * held date, committees, witnesses, member bioguide ids, renditions —
 * leaving the transcript itself (and everything else in the MODS record)
 * unread. Built from the same tolerant tag/block primitives as the
 * BILLSTATUS parser (`../govinfo/xml.ts`), plus a small opening-tag
 * attribute reader MODS needs (`congCommittee authorityId`,
 * `congMember bioGuideId`, `url displayLabel`).
 *
 * Parser id: `govinfo-hearings-mods@1`.
 */

/** A per-document problem: the document is skipped and counted, never a partial row. */
export class HearingModsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HearingModsParseError";
  }
}

export interface ParsedHearingFields {
  packageId: string;
  title: string;
  chamber: "house" | "senate" | null;
  docClass: string | null;
  congress: number;
  session: number | null;
  heldDate: string;
  citation: string | null;
  committees: CongressHearingCommittee[];
  witnesses: string[];
  memberBioguideIds: string[];
  detailUrl: string;
  htmlUrl: string | null;
  pdfUrl: string | null;
}

/**
 * Reads one attribute off a block's OPENING tag (never a nested element's),
 * decoding standard XML entities. Missing/blank → null.
 */
export function attrValue(block: string, attr: string): string | null {
  const openTag = /^<[^>]*>/.exec(block)?.[0];
  if (!openTag) return null;
  const match = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i").exec(openTag);
  if (!match) return null;
  const value = decodeXmlEntities(match[1] ?? "").trim();
  return value === "" ? null : value;
}

/**
 * Package-level slice of the document: everything before the first
 * `<relatedItem>` block. CHRG MODS appends one `<relatedItem>` per granule
 * after the package-level metadata, each with its own titleInfo/extension —
 * truncating first guarantees every later search reads package-level fields
 * only ([verify-live]: relatedItem blocks trail the package metadata).
 */
function packageLevel(xml: string): string {
  const idx = xml.search(/<relatedItem[\s>]/i);
  return idx === -1 ? xml : xml.slice(0, idx);
}

function optionalDate(raw: string | null): string | null {
  const sliced = raw?.slice(0, 10);
  return sliced && /^\d{4}-\d{2}-\d{2}$/.test(sliced) ? sliced : null;
}

function optionalInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function parseChamber(raw: string | null): "house" | "senate" | null {
  switch (raw?.trim().toUpperCase()) {
    case "HOUSE":
      return "house";
    case "SENATE":
      return "senate";
    default:
      // JOINT (and anything unrecognized) → null; `docClass` keeps the raw code.
      return null;
  }
}

/** Committee name: authority-standard preferred, then authority-short, then any first `<name>`. */
function committeeName(block: string): string | null {
  const names = extractAllBlocks(block, "name");
  const byType = (type: string) =>
    names.find((n) => attrValue(n, "type")?.toLowerCase() === type) ?? null;
  const pick = byType("authority-standard") ?? byType("authority-short") ?? names[0] ?? null;
  return pick ? extractTag(pick, "name") : null;
}

function renditionUrl(urlBlocks: string[], displayLabel: string): string | null {
  const block = urlBlocks.find((b) => attrValue(b, "displayLabel") === displayLabel);
  return block ? extractTag(block, "url") : null;
}

/**
 * Parses one CHRG mods.xml. Extraction is lenient — an absent optional field
 * reads as `null`/`[]` — with one deliberate hard edge:
 *
 * - Every failure here is a `HearingModsParseError` — one skip-and-count
 *   parse failure, never a partial row and never a stopped run. That
 *   includes a document with NEITHER a title NOR an `<accessId>`: GPO
 *   really publishes such stubs (observed live: CHRG-105jhrg serves a 200
 *   mods.xml with no package metadata), so one of them cannot be treated as
 *   collection-wide format drift. Systemic drift — every document in a walk
 *   failing this way — is caught by the caller's zero-parse tripwire and
 *   raised as `GovinfoHearingsDriftError` there.
 */
export function parseHearingMods(xml: string, packageId: string): ParsedHearingFields {
  const mods = packageLevel(xml);

  const accessId = extractTag(mods, "accessId");
  const titleInfo = extractBlock(mods, "titleInfo");
  const title = titleInfo ? extractTag(titleInfo, "title") : null;

  if (!title && !accessId) {
    throw new HearingModsParseError(
      `${hearingModsUrl(packageId)}: neither <titleInfo><title> nor <accessId> found`,
    );
  }
  if (accessId && accessId !== packageId) {
    throw new HearingModsParseError(
      `<accessId> '${accessId}' does not match requested package '${packageId}'`,
    );
  }
  if (!title) throw new HearingModsParseError("missing <titleInfo><title>");

  const congressRaw = optionalInt(extractTag(mods, "congress"));
  // The package id embeds the congress ("CHRG-118hhrg…"); fall back to it
  // rather than failing a document whose extension omits the element.
  const congress = congressRaw ?? optionalInt(/^CHRG-(\d+)/.exec(packageId)?.[1] ?? null);
  if (congress === null || congress <= 0) {
    throw new HearingModsParseError(`unusable <congress> '${congressRaw ?? ""}'`);
  }

  // Multi-day hearings can carry several <heldDate> elements; the first (in
  // document order) is the event date. Rare packages omit heldDate entirely —
  // fall back to the publication date rather than dropping the row.
  const heldDate = optionalDate(extractTag(mods, "heldDate"));
  const originInfo = extractBlock(mods, "originInfo");
  const dateIssued = originInfo ? optionalDate(extractTag(originInfo, "dateIssued")) : null;
  const eventDate = heldDate ?? dateIssued;
  if (!eventDate) {
    throw new HearingModsParseError("no usable <heldDate> or <originInfo><dateIssued>");
  }

  const committees: CongressHearingCommittee[] = [];
  for (const block of extractAllBlocks(mods, "congCommittee")) {
    const name = committeeName(block);
    if (!name) continue;
    committees.push({ name, authorityId: attrValue(block, "authorityId") });
  }

  const witnesses: string[] = [];
  for (const block of extractAllBlocks(mods, "witness")) {
    const witness = extractTag(block, "witness");
    if (witness) witnesses.push(witness);
  }

  const memberBioguideIds: string[] = [];
  for (const block of extractAllBlocks(mods, "congMember")) {
    const bioguide = attrValue(block, "bioGuideId");
    if (bioguide && !memberBioguideIds.includes(bioguide)) memberBioguideIds.push(bioguide);
  }

  const location = extractBlock(mods, "location");
  const urlBlocks = location ? extractAllBlocks(location, "url") : [];

  return {
    packageId,
    title,
    chamber: parseChamber(extractTag(mods, "chamber")),
    docClass: extractTag(mods, "docClass"),
    congress,
    session: optionalInt(extractTag(mods, "session")),
    heldDate: eventDate,
    citation: extractTag(mods, "preferredCitation"),
    committees,
    witnesses,
    memberBioguideIds,
    detailUrl: renditionUrl(urlBlocks, "Content Detail") ?? hearingDetailsUrl(packageId),
    htmlUrl: renditionUrl(urlBlocks, "HTML rendition"),
    pdfUrl: renditionUrl(urlBlocks, "PDF rendition"),
  };
}
