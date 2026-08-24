/**
 * Helpers for EDGAR full-submission .txt files: one fetch per filing, with
 * every document (including the primary XML) embedded between <XML> tags,
 * plus the SGML SEC-HEADER carrying filing metadata.
 */

export interface SecHeaderFields {
  accessionNumber: string | null;
  formType: string | null;
  filedAsOfDate: string | null;
  periodOfReport: string | null;
  companyName: string | null;
  centralIndexKey: string | null;
}

/** Extracts every <XML>…</XML> block. Bare XML input returns itself. */
export function extractXmlDocuments(submissionText: string): string[] {
  const trimmed = submissionText.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<ownershipDocument")) {
    return [submissionText];
  }
  const blocks: string[] = [];
  const pattern = /<XML>([\s\S]*?)<\/XML>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(submissionText)) !== null) {
    if (match[1]) blocks.push(match[1].trim());
  }
  return blocks;
}

function headerValue(text: string, label: string): string | null {
  const pattern = new RegExp(`^\\s*${label}:\\s*(.+)$`, "im");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

/** "20260814" → "2026-08-14"; passes through already-dashed dates. */
function normalizeHeaderDate(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

export function parseSecHeader(submissionText: string): SecHeaderFields {
  // Limit the scan to the header region so document bodies can't shadow it.
  const headerEnd = submissionText.indexOf("</SEC-HEADER>");
  const header =
    headerEnd === -1 ? submissionText.slice(0, 6_000) : submissionText.slice(0, headerEnd);
  return {
    accessionNumber: headerValue(header, "ACCESSION NUMBER"),
    formType: headerValue(header, "CONFORMED SUBMISSION TYPE"),
    filedAsOfDate: normalizeHeaderDate(headerValue(header, "FILED AS OF DATE")),
    periodOfReport: normalizeHeaderDate(headerValue(header, "CONFORMED PERIOD OF REPORT")),
    companyName: headerValue(header, "COMPANY CONFORMED NAME"),
    centralIndexKey: headerValue(header, "CENTRAL INDEX KEY"),
  };
}

/** CIKs join across datasets zero-padded to 10 digits. */
export function padCik(cik: string | number): string {
  return String(Number(cik)).padStart(10, "0");
}
