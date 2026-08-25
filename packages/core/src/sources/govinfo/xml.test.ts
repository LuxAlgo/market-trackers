import { describe, expect, it } from "vitest";
import { extractAllBlocks, extractBlock, extractTag, withoutBlock } from "./xml.js";

describe("extractTag", () => {
  it("reads plain text content", () => {
    expect(extractTag("<a>hello</a>", "a")).toBe("hello");
  });

  it("trims whitespace and treats blank content as absent", () => {
    expect(extractTag("<a>  hello  </a>", "a")).toBe("hello");
    expect(extractTag("<a>   </a>", "a")).toBeNull();
    expect(extractTag("<a></a>", "a")).toBeNull();
  });

  it("unwraps CDATA verbatim, without entity-decoding its content", () => {
    expect(extractTag("<a><![CDATA[Cats & Dogs]]></a>", "a")).toBe("Cats & Dogs");
    expect(extractTag("<a><![CDATA[<b>literal tag text</b>]]></a>", "a")).toBe(
      "<b>literal tag text</b>",
    );
  });

  it("decodes standard XML entities outside CDATA", () => {
    expect(extractTag("<a>Cats &amp; Dogs</a>", "a")).toBe("Cats & Dogs");
    expect(extractTag("<a>&lt;tag&gt; &quot;quoted&quot; &apos;s&apos;</a>", "a")).toBe(
      `<tag> "quoted" 's'`,
    );
    expect(extractTag("<a>&#65;&#x42;</a>", "a")).toBe("AB");
  });

  it("decodes &amp; last so a literal escaped entity isn't double-unescaped", () => {
    expect(extractTag("<a>&amp;lt;</a>", "a")).toBe("&lt;");
  });

  it("returns null for a missing or self-closing tag", () => {
    expect(extractTag("<other>x</other>", "a")).toBeNull();
    expect(extractTag("<a/>", "a")).toBeNull();
    expect(extractTag("<a />", "a")).toBeNull();
  });

  it("does not match a tag name that is a substring of another (cosponsors vs sponsors)", () => {
    expect(extractTag("<cosponsors>3</cosponsors>", "sponsors")).toBeNull();
  });

  it("reads a tag carrying attributes", () => {
    expect(extractTag(`<a id="1" foo="bar">value</a>`, "a")).toBe("value");
  });

  it("is case-insensitive on the tag name", () => {
    expect(extractTag("<A>value</A>", "a")).toBe("value");
  });
});

describe("extractBlock", () => {
  it("returns the full matched block including its own tags", () => {
    expect(extractBlock("<wrap><a>1</a><b>2</b></wrap>", "wrap")).toBe(
      "<wrap><a>1</a><b>2</b></wrap>",
    );
  });

  it("returns null for a missing or self-closing block", () => {
    expect(extractBlock("<other/>", "wrap")).toBeNull();
    expect(extractBlock("<wrap/>", "wrap")).toBeNull();
  });

  it("does not match a tag name that is a substring of another", () => {
    expect(extractBlock("<cosponsors><item>1</item></cosponsors>", "sponsors")).toBeNull();
  });

  it("returns an empty-but-present block's tags, not null", () => {
    expect(extractBlock("<wrap></wrap>", "wrap")).toBe("<wrap></wrap>");
  });
});

describe("withoutBlock", () => {
  it("removes exactly the first matching block, leaving the rest of the document", () => {
    const xml = "<bill><title>Keep</title><titles><item><title>Drop</title></item></titles></bill>";
    expect(withoutBlock(xml, "titles")).toBe("<bill><title>Keep</title></bill>");
  });

  it("is a no-op when the block is absent", () => {
    expect(withoutBlock("<bill><title>Keep</title></bill>", "titles")).toBe(
      "<bill><title>Keep</title></bill>",
    );
  });
});

describe("extractAllBlocks", () => {
  it("finds every sibling occurrence in document order", () => {
    const xml = "<cosponsors><item>1</item><item>2</item><item>3</item></cosponsors>";
    expect(extractAllBlocks(xml, "item")).toEqual([
      "<item>1</item>",
      "<item>2</item>",
      "<item>3</item>",
    ]);
  });

  it("counts self-closing occurrences too", () => {
    expect(extractAllBlocks("<a/><a/>", "a")).toHaveLength(2);
  });

  it("returns an empty array when there are none", () => {
    expect(extractAllBlocks("<cosponsors></cosponsors>", "item")).toEqual([]);
    expect(extractAllBlocks("", "item")).toEqual([]);
  });
});
