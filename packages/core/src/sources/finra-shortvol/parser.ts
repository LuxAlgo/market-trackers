import {
  shortVolumeDayId,
  shortVolumeDaySchema,
  type ShortVolumeDay,
} from "../../schema/short-volume-day.js";
import { expandCompactDate } from "../../lib/dates.js";

/**
 * Parser for FINRA Reg SHO daily short-sale volume files
 * (pipe-delimited: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market).
 *
 * Parser id: finra-shortvol@1
 *
 * FINRA moved to decimal volume formats effective 2026-02-23; this parser
 * accepts both integer-era and decimal-era values so backfills normalize
 * identically to current files.
 */

export const FINRA_SHORTVOL_PARSER = "finra-shortvol@1";

export interface ShortVolumeParseInput {
  text: string;
  /** File market code, e.g. "CNMS" — part of the natural key. */
  market: string;
  sourceUrl: string;
  retrievedAt: string;
}

export interface ShortVolumeParseResult {
  rows: ShortVolumeDay[];
  headerLine: string | null;
  stats: { attempted: number; succeeded: number };
}

function volume(field: string): number | null {
  const value = Number(field);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseShortVolumeFile(input: ShortVolumeParseInput): ShortVolumeParseResult {
  const lines = input.text.split(/\r?\n/);
  const rows: ShortVolumeDay[] = [];
  const stats = { attempted: 0, succeeded: 0 };
  let headerLine: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split("|");
    if (headerLine === null && /^date/i.test(trimmed)) {
      headerLine = trimmed;
      continue;
    }
    // Data rows start with an 8-digit compact date.
    if (!/^\d{8}$/.test(fields[0] ?? "")) continue;
    stats.attempted += 1;

    const date = expandCompactDate(fields[0] as string);
    const ticker = fields[1]?.trim().toUpperCase();
    const shortVolume = volume(fields[2] ?? "");
    const shortExemptVolume = volume(fields[3] ?? "");
    const totalVolume = volume(fields[4] ?? "");
    if (
      !date ||
      !ticker ||
      shortVolume === null ||
      shortExemptVolume === null ||
      totalVolume === null
    ) {
      continue;
    }

    const shortRatio = totalVolume > 0 ? Math.round((shortVolume / totalVolume) * 1e6) / 1e6 : null;

    rows.push(
      shortVolumeDaySchema.parse({
        id: shortVolumeDayId(date, ticker, input.market),
        date,
        ticker,
        market: input.market,
        shortVolume,
        shortExemptVolume,
        totalVolume,
        shortRatio,
        provenance: {
          source: "finra",
          sourceUrl: input.sourceUrl,
          retrievedAt: input.retrievedAt,
          parser: FINRA_SHORTVOL_PARSER,
          confidence: 1,
          needsReview: false,
        },
      } satisfies ShortVolumeDay),
    );
    stats.succeeded += 1;
  }

  return { rows, headerLine, stats };
}
