import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatasetDefinition, DatasetId } from "../schema/datasets.js";
import type { CongressTrade } from "../schema/congress-trade.js";
import type { InsiderTransaction } from "../schema/insider-transaction.js";
import type { ThirteenfHolding } from "../schema/thirteenf-holding.js";
import type { GovContractAward } from "../schema/gov-contract-award.js";
import type { LobbyingFiling } from "../schema/lobbying-filing.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";
import type { Patent } from "../schema/patent.js";
import type { ClinicalTrial } from "../schema/clinical-trial.js";
import type { FdaApproval } from "../schema/fda-approval.js";
import type { WikiPageview } from "../schema/wiki-pageview.js";
import type { AltDataStore } from "../store/store.js";
import { addDays } from "../lib/dates.js";
import { buildRssFeed, type FeedRow } from "./feeds.js";

/**
 * Per-entity RSS feeds: zero-server alerting for one ticker (or, for
 * congress trades, one member) instead of a whole dataset. A reader who only
 * cares about one company doesn't want to filter a 100-item dataset feed by
 * hand — they want a feed that is already just that company.
 *
 * Scope is bounded on purpose: only entities active in the last
 * `windowDays` (default 30, by `provenance.retrievedAt`, relative to the
 * export's `generatedAt`) get a feed at all, and each kind (ticker/member)
 * is capped at the `cap` most-active entities (default 200) per dataset —
 * otherwise a long-lived dataset could accumulate an unbounded number of
 * tiny feed files. A feed's items are drawn from that same recency window
 * (not the entity's full history — the dataset's snapshot files already
 * serve that), newest-first, same as the whole-dataset `feed.xml`.
 */

export const ENTITY_FEED_DEFAULT_WINDOW_DAYS = 30;
export const ENTITY_FEED_DEFAULT_CAP = 200;

const TICKER_SAFE_RE = /^[A-Z0-9.-]+$/;
const BIOGUIDE_SAFE_RE = /^[A-Z0-9]+$/;

/**
 * How each dataset's rows map to zero, one, or many tickers — the
 * entity-feed counterpart of `tickerMatchClause` in `store/queries.ts`
 * (which answers the same "does this dataset have a ticker, and how" at the
 * SQL layer, for search). Keep the two in sync if a dataset's ticker shape
 * ever changes. A dataset with no entry here has no ticker concept and gets
 * no by-ticker feeds — e.g. committee-assignments, cot-reports, bills,
 * fec-candidates, fec-contributions.
 *
 * Cast to `never` follows the same erasure trick `feeds.ts` uses for
 * `TITLERS`: the registry is written with each dataset's real record type
 * for readability, then read back through a single cast at the call site.
 */
type TickerKeysFn = (record: never) => readonly string[];

const TICKER_KEYS: Partial<Record<DatasetId, TickerKeysFn>> = {
  "congress-trades": ((r: CongressTrade) => (r.ticker ? [r.ticker] : [])) as TickerKeysFn,
  "insider-transactions": ((r: InsiderTransaction) => (r.ticker ? [r.ticker] : [])) as TickerKeysFn,
  "thirteenf-holdings": ((r: ThirteenfHolding) => (r.ticker ? [r.ticker] : [])) as TickerKeysFn,
  "short-volume": ((r: ShortVolumeDay) => [r.ticker]) as TickerKeysFn,
  "gov-contracts": ((r: GovContractAward) => r.recipient.tickers) as TickerKeysFn,
  "gov-grants": ((r: GovContractAward) => r.recipient.tickers) as TickerKeysFn,
  "lobbying-filings": ((r: LobbyingFiling) => r.client.tickers) as TickerKeysFn,
  patents: ((r: Patent) => r.assignee.tickers) as TickerKeysFn,
  "clinical-trials": ((r: ClinicalTrial) => r.sponsor.tickers) as TickerKeysFn,
  "fda-approvals": ((r: FdaApproval) => r.sponsor.tickers) as TickerKeysFn,
  "wiki-pageviews": ((r: WikiPageview) => r.tickers) as TickerKeysFn,
};

export interface EntityFeedCounts {
  byTicker: number;
  byMember: number;
}

export interface EntityFeedResult extends EntityFeedCounts {
  filesWritten: string[];
  /**
   * Rows excluded because their entity key wasn't filesystem-safe (tickers:
   * `[A-Z0-9.-]+`; bioguideIds: `[A-Z0-9]+`) — skipped and counted, never
   * silently dropped. In practice this should stay at 0: every ticker and
   * bioguideId already flowing through this pipeline is produced by the
   * curated resolution maps, which only ever emit safe strings.
   */
  rejected: EntityFeedCounts;
}

export interface EntityFeedOptions {
  /** Only rows ingested within this many days of `generatedAt` are eligible (default 30). */
  windowDays?: number;
  /** Cap on distinct entities per feed kind (ticker, member), most-active first (default 200). */
  cap?: number;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function groupByKey(
  rows: readonly FeedRow[],
  keysOf: (record: FeedRow) => readonly string[],
  isSafe: (key: string) => boolean,
): { grouped: Map<string, FeedRow[]>; rejected: number } {
  const grouped = new Map<string, FeedRow[]>();
  let rejected = 0;
  for (const row of rows) {
    for (const key of keysOf(row)) {
      if (!isSafe(key)) {
        rejected += 1;
        continue;
      }
      const existing = grouped.get(key);
      if (existing) existing.push(row);
      else grouped.set(key, [row]);
    }
  }
  return { grouped, rejected };
}

/** Most rows in the window first; ties broken alphabetically for determinism. */
function mostActive(grouped: Map<string, FeedRow[]>, cap: number): [string, FeedRow[]][] {
  return [...grouped.entries()]
    .sort(([keyA, rowsA], [keyB, rowsB]) => {
      if (rowsB.length !== rowsA.length) return rowsB.length - rowsA.length;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .slice(0, Math.max(0, cap));
}

function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Rewrites `dirPath` to hold exactly `feeds` (keyed by filename stem) — stale entities gone. */
function writeFeedFiles(dirPath: string, feeds: Map<string, string>): string[] {
  const desired = new Set([...feeds.keys()].map((key) => `${key}.xml`));
  if (existsSync(dirPath)) {
    for (const entry of readdirSync(dirPath)) {
      if (entry.endsWith(".xml") && !desired.has(entry)) {
        unlinkSync(join(dirPath, entry));
      }
    }
  }
  const filesWritten: string[] = [];
  for (const [key, xml] of feeds) {
    const path = join(dirPath, `${key}.xml`);
    writeFileAtomic(path, xml);
    filesWritten.push(path);
  }
  return filesWritten;
}

function buildFeedSet(
  dataset: DatasetDefinition,
  rows: readonly FeedRow[],
  generatedAt: string,
  keysOf: (record: FeedRow) => readonly string[],
  isSafe: (key: string) => boolean,
  titleSuffixOf: (key: string, rowsForKey: FeedRow[]) => string,
  cap: number,
): { feeds: Map<string, string>; rejected: number } {
  const { grouped, rejected } = groupByKey(rows, keysOf, isSafe);
  const feeds = new Map<string, string>();
  for (const [key, rowsForKey] of mostActive(grouped, cap)) {
    feeds.set(
      key,
      buildRssFeed(
        dataset as DatasetDefinition<FeedRow>,
        rowsForKey,
        generatedAt,
        titleSuffixOf(key, rowsForKey),
      ),
    );
  }
  return { feeds, rejected };
}

function mostRecentMemberName(rows: readonly CongressTrade[]): string {
  let best: CongressTrade | undefined;
  for (const row of rows) {
    if (!best || row.provenance.retrievedAt > best.provenance.retrievedAt) best = row;
  }
  return best?.member.name ?? "unknown member";
}

/**
 * Writes (or clears, when nothing qualifies) `feeds/by-ticker/{TICKER}.xml`
 * and — for `congress-trades` only — `feeds/by-member/{bioguideId}.xml`
 * under `datasetDir` (the dataset's export directory, e.g.
 * `<outDir>/congress/trades`). Rows with no resolved ticker (or, for
 * members, a null `bioguideId`) are simply not part of any group — that's
 * an ordinary coverage limit, not something to flag, same as the dataset
 * feed and the analytics adapters. Directories for datasets with no ticker
 * (or member) concept are never created or touched.
 */
export async function writeEntityFeeds(
  store: AltDataStore,
  dataset: DatasetDefinition,
  datasetDir: string,
  generatedAt: string,
  options: EntityFeedOptions = {},
): Promise<EntityFeedResult> {
  const windowDays = options.windowDays ?? ENTITY_FEED_DEFAULT_WINDOW_DAYS;
  const cap = options.cap ?? ENTITY_FEED_DEFAULT_CAP;

  const tickerKeysOfRaw = TICKER_KEYS[dataset.id];
  const includeMembers = dataset.id === "congress-trades";

  const result: EntityFeedResult = {
    byTicker: 0,
    byMember: 0,
    filesWritten: [],
    rejected: { byTicker: 0, byMember: 0 },
  };
  if (!tickerKeysOfRaw && !includeMembers) return result;

  const generatedDay = generatedAt.slice(0, 10);
  const sinceDay = addDays(generatedDay, -windowDays);
  const allDays = await store.ingestionDays(dataset.id);
  // Bounded both ends: strictly the last `windowDays` days as of `generatedAt`,
  // never a day after it either (ingestion days shouldn't be in the future
  // relative to the export, but this keeps the window meaning exact either way).
  const recentDays = allDays.filter((day) => day >= sinceDay && day <= generatedDay);
  const recentRows: FeedRow[] = [];
  for (const day of recentDays) {
    const rows = await store.rowsIngestedOn(dataset, day);
    recentRows.push(...(rows as unknown as FeedRow[]));
  }

  if (tickerKeysOfRaw) {
    const keysOf = tickerKeysOfRaw as unknown as (record: FeedRow) => readonly string[];
    const { feeds, rejected } = buildFeedSet(
      dataset,
      recentRows,
      generatedAt,
      keysOf,
      (key) => TICKER_SAFE_RE.test(key),
      (ticker) => ticker,
      cap,
    );
    result.filesWritten.push(...writeFeedFiles(join(datasetDir, "feeds", "by-ticker"), feeds));
    result.byTicker = feeds.size;
    result.rejected.byTicker = rejected;
  }

  if (includeMembers) {
    const keysOf = (record: FeedRow): readonly string[] => {
      const bioguideId = (record as unknown as CongressTrade).member.bioguideId;
      return isNonNull(bioguideId) ? [bioguideId] : [];
    };
    const titleSuffixOf = (_key: string, rowsForKey: FeedRow[]): string =>
      mostRecentMemberName(rowsForKey as unknown as CongressTrade[]);
    const { feeds, rejected } = buildFeedSet(
      dataset,
      recentRows,
      generatedAt,
      keysOf,
      (key) => BIOGUIDE_SAFE_RE.test(key),
      titleSuffixOf,
      cap,
    );
    result.filesWritten.push(...writeFeedFiles(join(datasetDir, "feeds", "by-member"), feeds));
    result.byMember = feeds.size;
    result.rejected.byMember = rejected;
  }

  return result;
}
