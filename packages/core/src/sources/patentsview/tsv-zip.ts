import { createReadStream } from "node:fs";
import { Unzip, UnzipInflate } from "fflate";

/**
 * Streaming TSV-out-of-ZIP reader for the PatentsView bulk table files.
 * These archives are ~0.5–2 GB compressed with multi-GB TSVs inside, so
 * nothing here may ever hold a whole file: the ZIP is read from disk in
 * 64 KiB chunks, decompressed incrementally with fflate's streaming `Unzip`
 * (already a dependency — house-clerk uses its in-memory API; the FEC
 * reader and fflate's `unzipSync` both buffer whole archives and are
 * unusable at this size), and rows are handed to the caller as they
 * complete. fflate's streaming unzipper reads local file headers, including
 * their ZIP64 extra fields and data-descriptor entries, so large
 * standard-tool archives decode without a new dependency or a spawned
 * system `unzip` binary ([verify-live] against a real table zip — see
 * docs/sources/patentsview.md).
 *
 * TSV dialect: one header row, fields split on tabs; a field may be quoted
 * (`"`-delimited, `""` escaping a literal quote), and a quoted field may
 * contain tabs and newlines. Records are assembled line-by-line and a line
 * with an unbalanced quote count continues the record across the newline —
 * so the fast path (no quotes at all, the overwhelming majority of rows)
 * stays a plain `split`.
 */

/** A ZIP that can't be read, or that doesn't contain the entry the caller named. */
export class TsvZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsvZipError";
  }
}

export interface TsvZipStreamResult {
  /** Data records handed to `onRecord` (the header row excluded). */
  records: number;
  /** True when `onRecord` returned `false` before the entry was fully read. */
  stopped: boolean;
}

/**
 * Splits one complete TSV record into raw field values. Fields containing
 * no quote split on tabs verbatim; a field STARTING with `"` is quoted —
 * its content runs to the matching close quote (with `""` unescaping to
 * `"`), and anything between the close quote and the next tab is kept
 * literally rather than thrown away (lenient, like most TSV consumers).
 * A quote appearing mid-field is literal.
 */
export function parseTsvRecord(record: string): string[] {
  if (!record.includes('"')) return record.split("\t");

  const fields: string[] = [];
  const n = record.length;
  let i = 0;
  for (;;) {
    let value = "";
    if (record[i] === '"') {
      i += 1;
      for (;;) {
        const q = record.indexOf('"', i);
        if (q === -1) {
          // Unterminated quote: take the rest verbatim rather than dropping data.
          value += record.slice(i);
          i = n;
          break;
        }
        value += record.slice(i, q);
        if (record[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      const tab = record.indexOf("\t", i);
      if (tab === -1) {
        value += record.slice(i);
        i = n;
      } else {
        value += record.slice(i, tab);
        i = tab;
      }
    } else {
      const tab = record.indexOf("\t", i);
      if (tab === -1) {
        value = record.slice(i);
        i = n;
      } else {
        value = record.slice(i, tab);
        i = tab;
      }
    }
    fields.push(value);
    if (i >= n) break;
    i += 1; // step over the tab
  }
  return fields;
}

function countQuotes(s: string): number {
  let count = 0;
  let i = s.indexOf('"');
  while (i !== -1) {
    count += 1;
    i = s.indexOf('"', i + 1);
  }
  return count;
}

/**
 * Streams the named TSV entry out of a ZIP on disk, calling `onHeader` once
 * with the first record's columns and `onRecord` for every data record.
 * `onRecord` may return `false` (sync or async) to stop early — the read
 * stream is abandoned mid-archive and `stopped: true` is returned.
 *
 * The entry is matched by basename, case-insensitively, tolerant of any
 * directory prefix. Every OTHER entry is decompressed and discarded on the
 * fly — fflate buffers the compressed bytes of any entry that is never
 * `start()`ed, so skipping via "don't start" would hold a whole stray entry
 * in memory.
 */
export async function streamTsvFromZip(
  zipPath: string,
  entryBasename: string,
  onHeader: (columns: string[]) => void | Promise<void>,
  onRecord: (fields: string[]) => void | boolean | Promise<void | boolean>,
): Promise<TsvZipStreamResult> {
  const wanted = entryBasename.toLowerCase();
  const decoder = new TextDecoder("utf-8");
  const seenEntries: string[] = [];
  const decodedParts: string[] = [];
  let matched = false;
  let entryFinal = false;
  let inflateError: TsvZipError | null = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    seenEntries.push(file.name);
    const base = file.name.split("/").pop() ?? file.name;
    if (!matched && base.toLowerCase() === wanted) {
      matched = true;
      file.ondata = (err, chunk, final) => {
        if (err) {
          inflateError ??= new TsvZipError(
            `${zipPath}: entry '${file.name}' failed to decompress: ${err.message}`,
          );
          return;
        }
        if (chunk && chunk.length > 0) decodedParts.push(decoder.decode(chunk, { stream: true }));
        if (final) {
          decodedParts.push(decoder.decode());
          entryFinal = true;
        }
      };
    } else {
      file.ondata = () => {}; // decompress-and-discard (see docblock)
    }
    file.start();
  };

  const push = (chunk: Uint8Array, final: boolean): void => {
    try {
      unzip.push(chunk, final);
    } catch (error) {
      throw new TsvZipError(
        `${zipPath}: not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Record assembly state. `lineRemainder` holds text after the last
  // newline; `pendingRecord` holds a record whose quotes are unbalanced so
  // far (a quoted field spanning newlines).
  let lineRemainder = "";
  let pendingRecord: string | null = null;
  let pendingQuotes = 0;
  let header: string[] | null = null;
  let records = 0;
  let stopped = false;

  const emit = async (record: string): Promise<void> => {
    if (header === null) {
      header = parseTsvRecord(record);
      await onHeader(header);
      return;
    }
    records += 1;
    if ((await onRecord(parseTsvRecord(record))) === false) stopped = true;
  };

  const feedLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (pendingRecord === null) {
      if (line === "") return; // blank line between records (or the trailing newline)
      pendingRecord = line;
      pendingQuotes = countQuotes(line);
    } else {
      pendingRecord += `\n${line}`;
      pendingQuotes += countQuotes(line);
    }
    if (pendingQuotes % 2 === 0) {
      const record = pendingRecord;
      pendingRecord = null;
      pendingQuotes = 0;
      await emit(record);
    }
  };

  const drain = async (): Promise<void> => {
    if (decodedParts.length === 0) return;
    const text = decodedParts.join("");
    decodedParts.length = 0;
    const parts = (lineRemainder + text).split("\n");
    lineRemainder = parts.pop() ?? "";
    for (const rawLine of parts) {
      if (stopped) return;
      await feedLine(rawLine);
    }
  };

  const finishRecords = async (): Promise<void> => {
    await drain();
    if (stopped) return;
    if (lineRemainder !== "") {
      const lastLine = lineRemainder;
      lineRemainder = "";
      await feedLine(lastLine); // file without a trailing newline
    }
    if (!stopped && pendingRecord !== null) {
      // Unterminated quoted record at EOF: emit what we have (lenient).
      const record = pendingRecord;
      pendingRecord = null;
      await emit(record);
    }
  };

  const stream = createReadStream(zipPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      push(chunk as Uint8Array, false);
      if (inflateError) throw inflateError;
      await drain();
      // Early exit once the wanted entry is fully decoded (or the caller
      // stopped): the rest of the archive is other entries + the central
      // directory, none of which this reader needs.
      if (stopped || entryFinal) break;
    }
    if (!stopped && !entryFinal) {
      push(new Uint8Array(0), true); // throws on a truncated final entry
      if (inflateError) throw inflateError;
    }
    if (!stopped) await finishRecords();
    if (!matched) {
      throw new TsvZipError(
        `no '${entryBasename}' entry inside ${zipPath} (entries: ${seenEntries.join(", ") || "none"})`,
      );
    }
  } finally {
    stream.destroy();
  }

  return { records, stopped };
}
