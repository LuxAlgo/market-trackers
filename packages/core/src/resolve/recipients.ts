import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizeEntityName } from "./normalize.js";

/**
 * Recipient/client → ticker resolution against the curated map shipped in
 * `data/recipient-tickers.json` — public-company primes and their well-known
 * subsidiaries, used by the USAspending and Senate LDA ingestors.
 *
 * Matching stays deliberately conservative: exact UEI, then exact normalized
 * name, then a word-boundary prefix match only when it hits exactly one map
 * entry. Anything ambiguous resolves to `[]` — a wrong ticker is worse than
 * an empty one, and unmatched entities are stored anyway.
 */

export const recipientTickerMapSchema = z.object({
  version: z.number().int().positive(),
  entries: z.array(
    z.object({
      tickers: z.array(z.string().min(1)).min(1),
      /** Entity names, pre-normalized to `normalizeEntityName` output. */
      names: z.array(z.string().min(1)),
      /** SAM.gov Unique Entity IDs; exact-match, highest precedence. */
      uei: z.array(z.string().min(1)),
    }),
  ),
});

export type RecipientTickerMap = z.infer<typeof recipientTickerMapSchema>;

export interface RecipientTickerIndex {
  byUei: Map<string, readonly string[]>;
  byName: Map<string, readonly string[]>;
  /** Every normalized name with its owning entry, for prefix scans. */
  names: { name: string; entry: number; tickers: readonly string[] }[];
}

export function buildRecipientIndex(map: RecipientTickerMap): RecipientTickerIndex {
  const byUei = new Map<string, readonly string[]>();
  const byName = new Map<string, readonly string[]>();
  const names: RecipientTickerIndex["names"] = [];

  map.entries.forEach((entry, i) => {
    const tickers = Object.freeze([...entry.tickers]);
    for (const uei of entry.uei) {
      const key = uei.trim().toUpperCase();
      if (byUei.has(key)) throw new Error(`recipient-tickers map: duplicate UEI '${key}'`);
      byUei.set(key, tickers);
    }
    for (const name of entry.names) {
      // Names ship pre-normalized; re-normalizing is an idempotent guard.
      const key = normalizeEntityName(name);
      if (byName.has(key)) throw new Error(`recipient-tickers map: duplicate name '${key}'`);
      byName.set(key, tickers);
      names.push({ name: key, entry: i, tickers });
    }
  });

  return { byUei, byName, names };
}

export interface EntityTickerQuery {
  name?: string | null;
  uei?: string | null;
}

/** Pure resolution against an explicit index — the testable core. */
export function resolveWithIndex(index: RecipientTickerIndex, query: EntityTickerQuery): string[] {
  const uei = query.uei?.trim().toUpperCase();
  if (uei) {
    const hit = index.byUei.get(uei);
    if (hit) return [...hit];
  }

  const raw = query.name?.trim();
  if (!raw) return [];
  const normalized = normalizeEntityName(raw);
  if (!normalized) return [];

  const exact = index.byName.get(normalized);
  if (exact) return [...exact];

  // Word-boundary prefix ("LOCKHEED MARTIN" matches "LOCKHEED MARTIN
  // AERONAUTICS", never "LOCKHEED MARTINI") — and only when exactly one map
  // entry matches; two candidate entries means ambiguity, which returns [].
  const matchedEntries = new Set<number>();
  let matchedTickers: readonly string[] | null = null;
  for (const candidate of index.names) {
    if (normalized.startsWith(`${candidate.name} `)) {
      matchedEntries.add(candidate.entry);
      matchedTickers = candidate.tickers;
    }
  }
  if (matchedEntries.size === 1 && matchedTickers) return [...matchedTickers];
  return [];
}

let cachedIndex: RecipientTickerIndex | null = null;

/**
 * The shipped map, loaded and indexed once per process. The JSON lives at
 * the package root (`data/`), one level above both `src/` and `dist/`, so
 * the relative URL resolves identically from sources and compiled output.
 */
export function recipientTickerIndex(): RecipientTickerIndex {
  if (cachedIndex === null) {
    const raw = readFileSync(new URL("../../data/recipient-tickers.json", import.meta.url), "utf8");
    cachedIndex = buildRecipientIndex(recipientTickerMapSchema.parse(JSON.parse(raw)));
  }
  return cachedIndex;
}

/**
 * Best-effort tickers for a contract recipient or lobbying client. Exact UEI
 * first, then exact normalized name, then an unambiguous prefix; `[]` when
 * nothing matches — callers store the record either way.
 */
export function resolveEntityTickers(query: EntityTickerQuery): string[] {
  return resolveWithIndex(recipientTickerIndex(), query);
}
