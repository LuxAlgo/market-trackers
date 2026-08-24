import { getDocumentProxy } from "unpdf";

/**
 * Thin PDF-bytes → positioned-text layer over unpdf (pdf.js). Deliberately
 * minimal: everything layout-aware lives in parse-ptr-items.ts, which is
 * golden-tested against PositionedTextItem[] fixtures without ever touching
 * a PDF — this seam is also what offline source tests stub.
 */

export interface PositionedTextItem {
  /** Text run exactly as it appears in the PDF text layer. */
  text: string;
  /** X origin in PDF user space (from the item's transform matrix). */
  x: number;
  /** Y origin in PDF user space — origin bottom-left, so lines read top-down as y decreases. */
  y: number;
  /** 1-based page number. */
  page: number;
}

/**
 * Extracts every non-empty text run with its position. Returns an empty
 * array for PDFs with no text layer (scanned paper filings) — callers must
 * treat that as "pending a scan extractor", never as an empty filing.
 */
export async function extractPositionedText(pdfBytes: Uint8Array): Promise<PositionedTextItem[]> {
  const pdf = await getDocumentProxy(pdfBytes);
  const items: PositionedTextItem[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string") continue;
        if (item.str.trim().length === 0) continue;
        const transform = (item as { transform?: unknown[] }).transform;
        const x = Number(transform?.[4]);
        const y = Number(transform?.[5]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        items.push({ text: item.str, x, y, page: pageNumber });
      }
    }
  } finally {
    // unpdf's serverless pdf.js build does not always expose destroy().
    const destroy = (pdf as { destroy?: () => Promise<void> }).destroy;
    if (typeof destroy === "function") await destroy.call(pdf).catch(() => undefined);
  }
  return items;
}
