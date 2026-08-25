import type { AltDataStore } from "../store/store.js";
import { normalizeEntityName } from "./normalize.js";
import { resolveEntityTickers, type EntityTickerQuery } from "./recipients.js";

/**
 * SEC issuer-name resolution — a second, lower-precedence tier behind the
 * curated map (`resolve/recipients.ts`). The store's `cik_tickers` table
 * (the SEC's own `company_tickers.json`, refreshed by
 * `refreshCikTickersIfStale` during EDGAR syncs — see `resolve/cik-ticker.ts`)
 * carries `(cik, ticker, name)` for every currently listed issuer: free,
 * keyless, ~10k rows.
 *
 * That's a much bigger surface than the curated map's hand-picked entries,
 * and it's issuer *titles*, not the subsidiary/DBA strings that show up as
 * USAspending recipients, patent assignees, trial sponsors, or FDA
 * application sponsors. Matching therefore stays exact-normalized-name
 * only — no prefix, no fuzzy. Prefix matching against ~10k SEC titles is
 * exactly where garbage would get in (a subsidiary like "APPLE OPERATIONS
 * INTERNATIONAL" must never inherit AAPL just because "APPLE" is an issuer
 * title); only entries a human curated into `recipient-tickers.json` earn
 * that judgment call, and only at word boundaries there.
 *
 * A normalized name carried by two *different* issuers (distinct CIKs) is a
 * genuine ambiguity — excluded from the index entirely, never guessed. One
 * issuer with several share classes (e.g. GOOGL/GOOG on one CIK) keeps every
 * one of its tickers.
 */

export interface SecNameIndex {
  /** normalizeEntityName(issuer title) -> tickers, sorted; ambiguous names absent. */
  byName: ReadonlyMap<string, readonly string[]>;
}

interface CachedIndex {
  /** The `cik_tickers` freshness stamp (see `store.cikTickersRefreshedAt()`) the index was built from. */
  refreshedAt: string | null;
  index: SecNameIndex;
}

/**
 * One cache slot per store instance. A dedicated invalidation hook would be
 * overkill for a table that changes only when `refreshCikTickersIfStale`
 * (or a test) touches it, so invalidation instead rides the store's own
 * freshness stamp — `cikTickersRefreshedAt()`, the same timestamp
 * `touchCikTickersRefreshedAt()`/`replaceCikTickers()` bump on every refresh
 * (including the conditional-GET 304 path). Checking it is one cheap query,
 * so a long-lived process picks up a refreshed map automatically instead of
 * only ever seeing the index as of first use. The one edge case this doesn't
 * cover is two distinct `cik_tickers` states sharing the exact same
 * millisecond stamp back-to-back; nothing in this codebase refreshes that
 * table fast enough for that to matter in practice.
 */
const indexCache = new WeakMap<AltDataStore, CachedIndex>();

async function loadIndex(store: AltDataStore): Promise<SecNameIndex> {
  const rows = await store.driver.all<{ cik: string; ticker: string; name: string }>(
    `SELECT "cik", "ticker", "name" FROM "cik_tickers"`,
  );

  const grouped = new Map<string, { ciks: Set<string>; tickers: Set<string> }>();
  for (const row of rows) {
    const key = normalizeEntityName(row.name ?? "");
    if (!key) continue;
    let group = grouped.get(key);
    if (!group) {
      group = { ciks: new Set(), tickers: new Set() };
      grouped.set(key, group);
    }
    group.ciks.add(row.cik);
    const ticker = row.ticker?.trim().toUpperCase();
    if (ticker) group.tickers.add(ticker);
  }

  const byName = new Map<string, readonly string[]>();
  for (const [name, group] of grouped) {
    // More than one distinct CIK behind the same normalized name is a
    // genuine ambiguity (a renamed/merged issuer reusing a title, a
    // hand-seeded test collision, …) — excluded rather than guessed.
    if (group.ciks.size > 1 || group.tickers.size === 0) continue;
    byName.set(name, Object.freeze([...group.tickers].sort()));
  }

  return { byName };
}

/**
 * Builds (or returns the cached) SEC issuer-name index for this store.
 * Exported so tests can assert on the index directly — e.g. that a
 * two-CIK collision is excluded — without going through resolution.
 */
export async function buildSecNameIndex(store: AltDataStore): Promise<SecNameIndex> {
  const refreshedAt = await store.cikTickersRefreshedAt();
  const cached = indexCache.get(store);
  if (cached && cached.refreshedAt === refreshedAt) return cached.index;

  const index = await loadIndex(store);
  indexCache.set(store, { refreshedAt, index });
  return index;
}

export interface SecNameQuery {
  name?: string | null;
}

/**
 * Best-effort ticker(s) for an entity name through the SEC issuer-title
 * index alone — exact normalized-name match only. `[]` on a miss, an
 * ambiguous name, or empty/whitespace/null input. Never consults the
 * curated map; see `resolveEntityTickersTiered` for the combined order.
 */
export async function resolveEntityTickersSec(
  store: AltDataStore,
  query: SecNameQuery,
): Promise<string[]> {
  const raw = query.name?.trim();
  if (!raw) return [];
  const normalized = normalizeEntityName(raw);
  if (!normalized) return [];

  const index = await buildSecNameIndex(store);
  const hit = index.byName.get(normalized);
  return hit ? [...hit] : [];
}

/**
 * The two-tier resolver sources should call: the curated map
 * (`resolveEntityTickers` — authoritative, handles UEI and the
 * word-boundary prefix judgment calls that only hand-curated entries earn)
 * first, then the SEC exact-name index as a fallback. `[]` when neither
 * tier matches — callers store the record either way; absence of a ticker
 * is never treated as absence of the row.
 */
export async function resolveEntityTickersTiered(
  store: AltDataStore,
  query: EntityTickerQuery,
): Promise<string[]> {
  const curated = resolveEntityTickers(query);
  if (curated.length > 0) return curated;
  return resolveEntityTickersSec(store, { name: query.name });
}
