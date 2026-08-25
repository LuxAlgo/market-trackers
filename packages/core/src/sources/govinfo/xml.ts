/**
 * A small, tolerant tag-scoped text extractor for BILLSTATUS XML — not a
 * general-purpose XML parser. BILLSTATUS documents are simple enough
 * (shallow nesting, no namespaces) that scoping a regex search to a known
 * containing block and pulling specific child tags out of it is both
 * simpler and more forgiving of stray or unexpected structure than
 * building a full DOM: a missing or empty tag returns `null`, never throws,
 * and it's the caller's job to decide which fields are actually required.
 *
 * The one nesting hazard this guards against explicitly is tag name reuse
 * across sibling/child scopes (e.g. BILLSTATUS reuses `<item>` for every
 * repeated list — sponsors, cosponsors, titles, actions, committees). Every
 * extractor here only ever searches within a string the caller has already
 * narrowed to the right containing block, so a same-named tag elsewhere in
 * the document never leaks in.
 */

/** First `<tag>…</tag>` (or self-closing `<tag/>`) match anywhere in `text`, raw and unscoped. */
function firstTagMatch(text: string, tag: string): RegExpExecArray | null {
  return new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "i").exec(text);
}

/** Unwraps a CDATA-wrapped value verbatim; otherwise decodes XML entities. */
function unwrapValue(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? (cdata[1] ?? "") : decodeXmlEntities(raw);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&"); // decoded last so a literal "&amp;lt;" doesn't double-unescape
}

/**
 * Text content of the first `<tag>…</tag>` found anywhere in `xml`. Returns
 * `null` for a missing tag, a self-closing tag, or blank/whitespace-only
 * content — callers scope `xml` to the right block first when the tag name
 * could plausibly repeat elsewhere in the document.
 */
export function extractTag(xml: string, tag: string): string | null {
  const inner = firstTagMatch(xml, tag)?.[1];
  if (inner === undefined) return null;
  const value = unwrapValue(inner).trim();
  return value === "" ? null : value;
}

/**
 * The first `<tag ...>…</tag>` block found anywhere in `xml`, tags
 * included — for narrowing a following search to inside that element. A
 * self-closing `<tag/>` (no content) returns `null`, matching the tolerant
 * "absent" reading callers use for optional sub-records.
 */
export function extractBlock(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match?.[0] ?? null;
}

/**
 * `xml` with the first `<tag>…</tag>` block removed — used to exclude a
 * nested list (e.g. `<titles>`) before searching the remainder for a
 * same-named sibling tag (e.g. the bill's single top-level `<title>`).
 */
export function withoutBlock(xml: string, tag: string): string {
  const block = extractBlock(xml, tag);
  return block ? xml.replace(block, "") : xml;
}

/**
 * Every `<tag>…</tag>` (or self-closing `<tag/>`) occurrence directly
 * matched in `xml`, in document order — for counting or walking a repeated
 * child element (e.g. cosponsor `<item>` entries). Scope `xml` to the
 * containing block first.
 */
export function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`, "gi");
  return xml.match(re) ?? [];
}
