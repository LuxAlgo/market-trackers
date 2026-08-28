import type { CongressTrade } from "../../schema/congress-trade.js";

/**
 * Pluggable extractor seam for scanned paper PTRs
 * (`/search/view/paper/{uuid}/` — image scans with no parseable table).
 *
 * LuxAlgo Alt Data ships no OCR/LLM extraction; whoever wires one in registers it
 * here. Extracted rows must be honest about their tier: confidence 0.7 and
 * `needsReview: true` on every row — the source validates that contract
 * before upserting. Without a registered extractor, scanned filings are
 * counted and reported as pending, never fabricated.
 */

export const EFD_SCAN_CONFIDENCE = 0.7 as const;

export interface PtrScanExtractInput {
  /** Filing UUID. */
  docId: string;
  /** The paper view URL — also the provenance deep link for extracted rows. */
  url: string;
  /** Member name as listed on the search grid, verbatim. */
  memberName: string;
  /** Filed date (YYYY-MM-DD). */
  filedAt: string;
}

export interface PtrScanExtractor {
  extract(input: PtrScanExtractInput): Promise<CongressTrade[]>;
}

let registered: PtrScanExtractor | null = null;

/** Registers (or clears, with null) the process-wide scanned-PTR extractor. */
export function setSenateEfdScanExtractor(extractor: PtrScanExtractor | null): void {
  registered = extractor;
}

export function getSenateEfdScanExtractor(): PtrScanExtractor | null {
  return registered;
}

/**
 * The honesty contract for scan-extracted rows: confidence 0.7 and
 * needsReview on every row. Returns the first violation, or null when the
 * batch is clean.
 */
export function scanRowContractViolation(rows: CongressTrade[]): string | null {
  for (const row of rows) {
    if (row.provenance.confidence !== EFD_SCAN_CONFIDENCE) {
      return `row ${row.id} has confidence ${row.provenance.confidence}, expected ${EFD_SCAN_CONFIDENCE}`;
    }
    if (!row.provenance.needsReview) {
      return `row ${row.id} must set needsReview: true`;
    }
  }
  return null;
}
