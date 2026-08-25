import { inflateRawSync } from "node:zlib";

/**
 * A minimal, self-contained ZIP reader: no dependency beyond `node:zlib`.
 *
 * `house-clerk/client.ts` already parses a ZIP, but via the `fflate`
 * library and coupled to finding one specific expected filename inside it.
 * This module is the opposite shape on purpose: it lists every entry in an
 * arbitrary ZIP (the FEC ships four differently-shaped bulk files, each its
 * own single-entry archive) without pulling `fflate` into this source, per
 * this sprint's zero-new-dependencies constraint.
 *
 * Entries are located via the End-Of-Central-Directory record and the
 * central directory it points to (never by scanning local file headers
 * sequentially), so sizes and offsets are always read from the
 * authoritative central-directory copy — the one place they're guaranteed
 * correct even when a local header used a streaming data descriptor.
 * "Stored" (method 0) and "deflate" (method 8) entries are supported, which
 * is everything a standard `zip`/`zipfile` writer produces and everything
 * the FEC's bulk downloads need. ZIP64 (the 64-bit size/offset extension,
 * needed only past the 4 GiB / 65,535-entry mark) is deliberately
 * unsupported — an unambiguous `ZipError` is thrown rather than
 * misinterpreting the 0xFFFFFFFF sentinel fields it leaves behind.
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

/** Central-directory sentinel value marking "see the ZIP64 extra field instead" — unsupported here. */
const ZIP64_SENTINEL_32 = 0xffffffff;
/** Same sentinel, for the 16-bit entry-count fields. */
const ZIP64_SENTINEL_16 = 0xffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Full in-archive path, exactly as stored (may include `/`-separated directories). */
  name: string;
  data: Uint8Array;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Locates the End-Of-Central-Directory record by scanning backward from the
 * end of the file — the record is followed only by an optional comment of
 * up to 65,535 bytes, so it is always within that window of the end. Each
 * signature match is confirmed by checking that its declared comment length
 * lands exactly on the buffer's end, which rules out a signature-shaped
 * byte sequence occurring inside the comment itself.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const EOCD_FIXED_SIZE = 22;
  const MAX_COMMENT_SIZE = 0xffff;
  const searchFloor = Math.max(0, bytes.length - EOCD_FIXED_SIZE - MAX_COMMENT_SIZE);
  for (let offset = bytes.length - EOCD_FIXED_SIZE; offset >= searchFloor; offset--) {
    if (readUInt32LE(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUInt16LE(bytes, offset + 20);
    if (offset + EOCD_FIXED_SIZE + commentLength === bytes.length) return offset;
  }
  throw new ZipError("not a valid ZIP: no end-of-central-directory record found");
}

interface CentralDirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(bytes: Uint8Array, eocdOffset: number): CentralDirectoryEntry[] {
  const totalEntries = readUInt16LE(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32LE(bytes, eocdOffset + 16);
  if (totalEntries === ZIP64_SENTINEL_16 || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw new ZipError("ZIP64 archives are not supported by this minimal reader");
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (readUInt32LE(bytes, cursor) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      throw new ZipError(`malformed central directory: entry ${i} at offset ${cursor}`);
    }
    const method = readUInt16LE(bytes, cursor + 10);
    const compressedSize = readUInt32LE(bytes, cursor + 20);
    const nameLength = readUInt16LE(bytes, cursor + 28);
    const extraLength = readUInt16LE(bytes, cursor + 30);
    const commentLength = readUInt16LE(bytes, cursor + 32);
    const localHeaderOffset = readUInt32LE(bytes, cursor + 42);
    if (compressedSize === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      throw new ZipError("ZIP64 archives are not supported by this minimal reader");
    }

    const nameStart = cursor + 46;
    const name = Buffer.from(bytes.slice(nameStart, nameStart + nameLength)).toString("utf8");
    entries.push({ name, method, compressedSize, localHeaderOffset });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads one entry's compressed bytes and decompresses them. The local file
 * header is consulted only to find where the data starts (its own
 * name/extra-field lengths, which can differ from the central directory's
 * copy) — never for sizes, which come from the central directory and are
 * always trustworthy even when a streaming writer left the local header's
 * size fields zeroed.
 */
function readEntryData(bytes: Uint8Array, entry: CentralDirectoryEntry): ZipEntry {
  const { localHeaderOffset } = entry;
  if (readUInt32LE(bytes, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipError(`malformed local file header for '${entry.name}'`);
  }
  const nameLength = readUInt16LE(bytes, localHeaderOffset + 26);
  const extraLength = readUInt16LE(bytes, localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === COMPRESSION_STORED) {
    return { name: entry.name, data: compressed };
  }
  if (entry.method === COMPRESSION_DEFLATE) {
    const inflated = inflateRawSync(compressed);
    return { name: entry.name, data: new Uint8Array(inflated) };
  }
  throw new ZipError(`unsupported compression method ${entry.method} for '${entry.name}'`);
}

/** Reads every entry out of a ZIP archive's raw bytes. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const centralDirectory = readCentralDirectory(bytes, eocdOffset);
  return centralDirectory.map((entry) => readEntryData(bytes, entry));
}

/** Finds one entry by basename, case-insensitively and tolerant of any directory prefix. */
export function findZipEntry(entries: ZipEntry[], basename: string): ZipEntry | null {
  const wanted = basename.toLowerCase();
  for (const entry of entries) {
    const base = entry.name.split("/").pop()?.toLowerCase() ?? "";
    if (base === wanted) return entry;
  }
  return null;
}
