import { describe, expect, it } from "vitest";
import { extractPositionedText } from "./pdf-text.js";

/**
 * The bytes → items layer is deliberately thin; this test proves it against
 * a minimal hand-assembled 2-page PDF (offline — unpdf runs locally). Real
 * House PTR PDFs become golden fixtures once fetched from a networked
 * machine (see docs/sources/house-clerk.md).
 */

function buildMinimalPdf(): Uint8Array {
  const content1 =
    "BT /F1 10 Tf 1 0 0 1 90 600 Tm (Owner) Tj " +
    "1 0 0 1 130 560 Tm (Microsoft Corporation \\(MSFT\\) [ST]) Tj ET";
  const content2 = "BT /F1 10 Tf 1 0 0 1 130 660 Tm (Page two line) Tj ET";

  const header = "%PDF-1.4\n";
  const objects: string[] = [];
  objects[1] = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  objects[2] = `2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj\n`;
  objects[3] =
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ` +
    `/Resources << /Font << /F1 7 0 R >> >> >> endobj\n`;
  objects[4] = `4 0 obj << /Length ${content1.length} >> stream\n${content1}\nendstream endobj\n`;
  objects[5] =
    `5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ` +
    `/Resources << /Font << /F1 7 0 R >> >> >> endobj\n`;
  objects[6] = `6 0 obj << /Length ${content2.length} >> stream\n${content2}\nendstream endobj\n`;
  objects[7] = `7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`;

  let body = "";
  const offsets: number[] = [0];
  for (let i = 1; i <= 7; i++) {
    offsets[i] = header.length + body.length;
    body += objects[i];
  }
  const xrefStart = header.length + body.length;
  let xref = `xref\n0 8\n0000000000 65535 f \n`;
  for (let i = 1; i <= 7; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer << /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(header + body + xref + trailer);
}

describe("extractPositionedText", () => {
  it("returns text runs with x/y from the transform and 1-based pages", async () => {
    const items = await extractPositionedText(buildMinimalPdf());
    expect(items).toEqual([
      { text: "Owner", x: 90, y: 600, page: 1 },
      { text: "Microsoft Corporation (MSFT) [ST]", x: 130, y: 560, page: 1 },
      { text: "Page two line", x: 130, y: 660, page: 2 },
    ]);
  });
});
