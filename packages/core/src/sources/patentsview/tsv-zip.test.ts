import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseTsvRecord, streamTsvFromZip, TsvZipError } from "./tsv-zip.js";
import { fixturePath, makeTmpDir } from "../../test-helpers.js";

/**
 * The streaming TSV-from-ZIP reader, unit-tested two ways: against archives
 * built in-test with fflate's own writer, and against the checked-in
 * fixture zips assembled with Python's zipfile module — a genuine
 * cross-implementation check, the same idea as fec's zip reader tests.
 */

const tmp = makeTmpDir("patentsview-tsv-zip");
afterAll(() => tmp.cleanup());

function writeZip(name: string, entries: Record<string, string>): string {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(entries).map(([entry, body]) => [entry, strToU8(body)])),
  );
  const path = join(tmp.dir, name);
  writeFileSync(path, zipped);
  return path;
}

interface Collected {
  header: string[] | null;
  rows: string[][];
}

async function collect(
  zipPath: string,
  entry: string,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<Collected & { records: number; stopped: boolean }> {
  const out: Collected = { header: null, rows: [] };
  const result = await streamTsvFromZip(
    zipPath,
    entry,
    (columns) => {
      out.header = columns;
    },
    (fields) => {
      out.rows.push(fields);
      if (out.rows.length >= stopAfter) return false;
      return undefined;
    },
  );
  return { ...out, ...result };
}

describe("parseTsvRecord", () => {
  it("splits unquoted records on tabs, keeping empty fields", () => {
    expect(parseTsvRecord("a\tb\t\td")).toEqual(["a", "b", "", "d"]);
  });

  it("emits a trailing empty field for a record ending in a tab", () => {
    expect(parseTsvRecord("a\tb\t")).toEqual(["a", "b", ""]);
  });

  it("unwraps quoted fields, unescaping doubled quotes and keeping embedded tabs/newlines", () => {
    expect(parseTsvRecord('x\t"He said ""hi""\tand\nleft"\ty')).toEqual([
      "x",
      'He said "hi"\tand\nleft',
      "y",
    ]);
  });

  it("treats a quote appearing mid-field as literal", () => {
    expect(parseTsvRecord('5" pipe\tnext')).toEqual(['5" pipe', "next"]);
  });

  it("keeps text between a closing quote and the tab instead of dropping it (lenient)", () => {
    expect(parseTsvRecord('"a"b\tc')).toEqual(["ab", "c"]);
  });
});

describe("streamTsvFromZip", () => {
  it("streams header + records out of a deflated entry, matching by basename case-insensitively", async () => {
    const path = writeZip("basic.zip", {
      "data/G_Example.TSV": "col_a\tcol_b\n1\tx\n2\ty\n",
    });
    const got = await collect(path, "g_example.tsv");
    expect(got.header).toEqual(["col_a", "col_b"]);
    expect(got.rows).toEqual([
      ["1", "x"],
      ["2", "y"],
    ]);
    expect(got).toMatchObject({ records: 2, stopped: false });
  });

  it("handles CRLF line endings and a missing trailing newline", async () => {
    const path = writeZip("crlf.zip", { "t.tsv": "a\tb\r\n1\t2\r\n3\t4" });
    const got = await collect(path, "t.tsv");
    expect(got.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("assembles a quoted record spanning newlines into one row", async () => {
    const path = writeZip("multiline.zip", {
      "t.tsv": 'id\ttitle\n1\t"line one\nline two"\n2\tplain\n',
    });
    const got = await collect(path, "t.tsv");
    expect(got.rows).toEqual([
      ["1", "line one\nline two"],
      ["2", "plain"],
    ]);
  });

  it("stops early when onRecord returns false, reporting stopped: true", async () => {
    const path = writeZip("stop.zip", { "t.tsv": "h\n1\n2\n3\n4\n" });
    const got = await collect(path, "t.tsv", 2);
    expect(got.rows).toEqual([["1"], ["2"]]);
    expect(got).toMatchObject({ records: 2, stopped: true });
  });

  it("skips non-matching entries and still finds the wanted one after them", async () => {
    const path = writeZip("mixed.zip", {
      "README.txt": "not a table\n",
      "g_patent.tsv": "patent_id\n42\n",
    });
    const got = await collect(path, "g_patent.tsv");
    expect(got.rows).toEqual([["42"]]);
  });

  it("throws a typed error naming the entries when the wanted one is absent", async () => {
    const path = writeZip("wrong.zip", { "other.tsv": "h\n1\n" });
    await expect(collect(path, "g_patent.tsv")).rejects.toThrow(TsvZipError);
    await expect(collect(path, "g_patent.tsv")).rejects.toThrow(/other\.tsv/);
  });

  it("throws a typed error on a file that is not a ZIP at all", async () => {
    const path = join(tmp.dir, "not-a-zip.zip");
    writeFileSync(path, "just some text, no zip structure here at all");
    await expect(collect(path, "g_patent.tsv")).rejects.toThrow(TsvZipError);
  });

  it("reads the checked-in Python-built fixture zips (deflated and stored)", async () => {
    // Cross-implementation: these archives were written by Python zipfile,
    // g_patent deflated, g_cpc_current stored — see the fixture README.
    const patent = await collect(
      fixturePath("patentsview", "case-odp-quarterly-2026", "g_patent.tsv.zip"),
      "g_patent.tsv",
    );
    expect(patent.header?.[0]).toBe("patent_id");
    expect(patent.records).toBe(7);
    // The quoted title reassembles with its embedded newline and tab.
    expect(patent.rows[1]?.[3]).toBe(
      'Adaptive "thermal" regulation\nsystem for portable\telectronics',
    );

    const cpc = await collect(
      fixturePath("patentsview", "case-odp-quarterly-2026", "g_cpc_current.tsv.zip"),
      "g_cpc_current.tsv",
    );
    expect(cpc.header).toEqual([
      "patent_id",
      "cpc_sequence",
      "cpc_section",
      "cpc_class",
      "cpc_subclass",
      "cpc_group",
    ]);
    expect(cpc.records).toBe(6);
  });
});
