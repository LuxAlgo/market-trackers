import {
  wikiPageviewId,
  wikiPageviewSchema,
  type WikiPageview,
} from "../../schema/wiki-pageview.js";
import type { WikimediaPageviewItem } from "./client.js";

/**
 * Normalizer for one Wikimedia REST pageviews response item into a
 * `WikiPageview`. Every field is validated on its own terms and the whole
 * item throws together on the first problem found — a malformed item is a
 * parse failure, never a row with a zeroed-out field (mirrors
 * `cftc/source.ts`'s `normalizeCotRow`).
 */

export const WIKIMEDIA_PARSER = "wikimedia-pageviews@1";

/**
 * "2026080100" → "2026-08-01". Rejects anything that isn't exactly 10
 * digits, doesn't end in the "00" hour suffix daily granularity always
 * uses, or doesn't name a real calendar day.
 */
export function parseDailyTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{10}$/.test(raw)) return null;
  if (raw.slice(8, 10) !== "00") return null;
  const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const asDate = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== day) return null;
  return day;
}

/** A non-negative integer view count, from either a JSON number or a digit string. */
export function parseViews(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export interface NormalizePageviewItemInput {
  /** The article map entry this response was fetched for — the source of truth, not the item's echo. */
  expectedProject: string;
  expectedArticle: string;
  tickers: string[];
  /** The exact request URL that produced this item. */
  sourceUrl: string;
  retrievedAt: string;
}

/**
 * Normalizes one raw item. `expectedProject`/`expectedArticle` come from
 * the curated map entry being walked, not the item's own echoed fields —
 * but the echo is cross-checked against them so a misattributed item
 * (a pagination or mixing bug on either side) fails loudly instead of
 * silently landing under the wrong article.
 */
export function normalizePageviewItem(
  raw: WikimediaPageviewItem,
  input: NormalizePageviewItemInput,
): WikiPageview {
  const context = `${input.expectedProject}/${input.expectedArticle}`;
  if (raw.project !== input.expectedProject) {
    throw new Error(`${context}: item project '${String(raw.project)}' does not match the request`);
  }
  if (raw.article !== input.expectedArticle) {
    throw new Error(`${context}: item article '${String(raw.article)}' does not match the request`);
  }

  const day = parseDailyTimestamp(raw.timestamp);
  if (!day) throw new Error(`${context}: unusable timestamp '${String(raw.timestamp)}'`);

  const views = parseViews(raw.views);
  if (views === null)
    throw new Error(`${context}:${day}: unusable views value '${String(raw.views)}'`);

  return wikiPageviewSchema.parse({
    id: wikiPageviewId(input.expectedProject, input.expectedArticle, day),
    project: input.expectedProject,
    article: input.expectedArticle,
    day,
    views,
    tickers: input.tickers,
    provenance: {
      source: "wikimedia",
      sourceUrl: input.sourceUrl,
      retrievedAt: input.retrievedAt,
      parser: WIKIMEDIA_PARSER,
      confidence: 1,
      needsReview: false,
    },
  } satisfies WikiPageview);
}
