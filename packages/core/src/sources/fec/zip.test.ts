import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findZipEntry, readZipEntries, ZipError, type ZipEntry } from "./zip.js";
import { fixturePath, readFixtureJson } from "../../test-helpers.js";

/**
 * Unit tests for the hand-rolled ZIP reader, against a fixture built by
 * Python's stdlib `zipfile` (see fixtures/fec/case-zip-reader/README.md) —
 * a genuine cross-implementation check, not a round-trip of this module's
 * own output. The error-path tests do deliberate byte surgery on a real,
 * valid archive rather than only ever handing the reader well-formed input.
 */

const ZIP_BYTES = new Uint8Array(
  readFileSync(fixturePath("fec", "case-zip-reader", "mixed-methods.zip")),
);
const EXPECTED = readFixtureJson<{ name: string; text: string }[]>(
  "fec",
  "case-zip-reader",
  "expected.json",
);

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Locates the fixture's End-Of-Central-Directory offset by a plain byte
 *  search — deliberately independent of `zip.ts`'s own (unexported)
 *  implementation, so a bug there can't also hide itself from this helper. */
function locateEocd(bytes: Uint8Array): number {
  const offset = Buffer.from(bytes).indexOf(EOCD_SIGNATURE);
  if (offset < 0) throw new Error("test fixture has no EOCD signature");
  return offset;
}

describe("readZipEntries (golden, against a zipfile-built fixture)", () => {
  it("decodes both a stored and a deflated entry, byte-for-byte", () => {
    const entries = readZipEntries(ZIP_BYTES);
    const decoded = entries.map((e) => ({
      name: e.name,
      text: Buffer.from(e.data).toString("utf8"),
    }));
    expect(decoded).toEqual(EXPECTED);
  });
});

describe("findZipEntry", () => {
  const entries: ZipEntry[] = readZipEntries(ZIP_BYTES);

  it("matches a root entry case-insensitively", () => {
    expect(findZipEntry(entries, "STORED.txt")?.name).toBe("stored.txt");
  });

  it("matches a nested, differently-cased entry by basename alone", () => {
    expect(findZipEntry(entries, "deflated.txt")?.name).toBe("nested/deflated.TXT");
  });

  it("returns null when no entry matches", () => {
    expect(findZipEntry(entries, "missing.txt")).toBeNull();
  });
});

describe("readZipEntries error paths", () => {
  it("throws ZipError when there is no end-of-central-directory record at all", () => {
    expect(() => readZipEntries(new TextEncoder().encode("not a zip"))).toThrow(ZipError);
    expect(() => readZipEntries(new Uint8Array(0))).toThrow(ZipError);
  });

  it("throws ZipError on the ZIP64 sentinel entry count", () => {
    // A minimal, otherwise-valid 22-byte EOCD record whose total-entries
    // field is the 0xFFFF sentinel that means "see the ZIP64 extra field" —
    // which this minimal reader deliberately does not implement.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0, 12);
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);
    expect(() => readZipEntries(new Uint8Array(eocd))).toThrow(/ZIP64/);
  });

  it("throws ZipError when a central directory entry's signature is corrupted", () => {
    const bytes = Buffer.from(ZIP_BYTES);
    const eocdOffset = locateEocd(bytes);
    const centralDirOffset = bytes.readUInt32LE(eocdOffset + 16);
    const corrupted = Buffer.from(bytes);
    corrupted[centralDirOffset] = 0x00; // was 0x50 ('P'), first byte of the signature
    expect(() => readZipEntries(new Uint8Array(corrupted))).toThrow(/central directory/);
  });

  it("throws ZipError when a local file header's signature is corrupted", () => {
    const bytes = Buffer.from(ZIP_BYTES);
    const corrupted = Buffer.from(bytes);
    corrupted[0] = 0x00; // byte 0 is always the start of the first local file header
    expect(() => readZipEntries(new Uint8Array(corrupted))).toThrow(/local file header/);
  });

  it("throws ZipError on an unsupported compression method", () => {
    const bytes = Buffer.from(ZIP_BYTES);
    const eocdOffset = locateEocd(bytes);
    const centralDirOffset = bytes.readUInt32LE(eocdOffset + 16);
    const corrupted = Buffer.from(bytes);
    // The first central directory entry's compression-method field sits 10
    // bytes into that entry's fixed-size header.
    corrupted.writeUInt16LE(99, centralDirOffset + 10);
    expect(() => readZipEntries(new Uint8Array(corrupted))).toThrow(
      /unsupported compression method 99/,
    );
  });
});
