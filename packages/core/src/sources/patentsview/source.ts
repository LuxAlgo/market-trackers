import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AltDataSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import type { Patent } from "../../schema/patent.js";
import { ALT_DATA_VERSION } from "../../config.js";
import { hoursSince } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import type { AltDataStore } from "../../store/store.js";
import { resolveEntityTickersTiered } from "../../resolve/sec-names.js";
import {
  createPatentsviewFetch,
  downloadProductFile,
  fetchProductMetadata,
  fileEntryFingerprint,
  OdpProductDriftError,
  patentDocumentUrl,
  PATENTSVIEW_TABLE_FILES,
  selectTableFile,
  type OdpProductMetadata,
} from "./client.js";
import { streamTsvFromZip } from "./tsv-zip.js";
import {
  openPatentJoinScratch,
  type PatentJoinLookup,
  type PatentJoinScratch,
} from "./join-scratch.js";

export {
  ODP_API_BASE,
  ODP_PRODUCT_ID,
  ODP_PRODUCT_URL,
  OdpProductDriftError,
  PATENTSVIEW_TABLE_FILES,
  downloadProductFile,
  fetchProductMetadata,
  fileEntryFingerprint,
  patentDocumentUrl,
  selectTableFile,
} from "./client.js";
export { TsvZipError, parseTsvRecord, streamTsvFromZip } from "./tsv-zip.js";
export { openPatentJoinScratch } from "./join-scratch.js";

/**
 * PatentsView granted-patent bulk data via the USPTO Open Data Portal —
 * the `pvgpatdis` product, refreshed QUARTERLY as whole-table replacement
 * files (the legacy PatentsView query API is decommissioned; see
 * client.ts). Natural key is `patent_id`, so re-ingesting a release upserts
 * rather than duplicates.
 *
 * Because each release replaces the entire 1976→present history, sync is
 * release-driven, not date-windowed: fetch the product metadata; if its
 * `lastModifiedDateTime` is already covered by the `patentsview.odpRelease`
 * watermark (and not `--full`), no-op with a note; otherwise download the
 * three table zips to a temp dir, stream the assignee and CPC tables into a
 * per-patent join scratch (see join-scratch.ts), then stream `g_patent`
 * and upsert finished rows in batches. One completed sync IS the full
 * backfill — `--since`/`--until` are meaningless here and the backfill
 * engine skips this source (`DATE_UNBOUNDED_SOURCES`).
 *
 * A missing key never crashes a multi-source `sync`: the source skips with
 * a polite note (and the canary soft-skips), because the key — while free —
 * is the one credential in the project and keyless runs must still ship
 * every other source's data.
 */

export const PATENTSVIEW_PARSER = "patentsview-odp@1";

const WATERMARK_KEY = "patentsview.odpRelease";
const FINGERPRINT_KEY = "patentsview.odp-file-entry-fields";
/** Patents staged per store upsert while streaming g_patent. */
const UPSERT_BATCH = 500;

/** The TSV entry inside each table zip: the zip's file name minus `.zip`. */
const TABLE_ENTRY = {
  patent: PATENTSVIEW_TABLE_FILES.patent.replace(/\.zip$/, ""),
  assignee: PATENTSVIEW_TABLE_FILES.assignee.replace(/\.zip$/, ""),
  cpc: PATENTSVIEW_TABLE_FILES.cpc.replace(/\.zip$/, ""),
} as const;

export const PATENTSVIEW_MISSING_KEY_NOTE =
  "skipped: no USPTO Open Data Portal API key configured (ALT_DATA_PATENTSVIEW_KEY, or " +
  "patentsviewApiKey in alt-data.config.json — the key is free: create a USPTO.gov account, " +
  "complete the Open Data Portal fields on your profile, then Manage API Key at " +
  "https://data.uspto.gov)";

/** Columns each table's header must carry; a rename is drift, not an empty run. */
const PATENT_COLUMNS = ["patent_id", "patent_date", "patent_title", "wipo_kind", "withdrawn"];
const ASSIGNEE_COLUMNS = ["patent_id", "assignee_sequence", "disambig_assignee_organization"];
const CPC_COLUMNS = ["patent_id", "cpc_sequence", "cpc_class"];

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createPatentsviewFetch({
    userAgent: ctx.config.userAgent ?? `alt-data/${ALT_DATA_VERSION}`,
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("patentsview"),
  });
}

/**
 * Maps required column names to their header positions, case-insensitively
 * (first occurrence wins on a duplicated name). A required column missing
 * from a table's header would otherwise blank the same field on every one
 * of ~9.5M rows — that's format drift and must fail the run loudly.
 */
function requireColumns(
  entryName: string,
  header: string[],
  wanted: string[],
): Record<string, number> {
  const index: Record<string, number> = {};
  header.forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (!(key in index)) index[key] = i;
  });
  const missing = wanted.filter((name) => index[name] === undefined);
  if (missing.length > 0) {
    throw new OdpProductDriftError(
      `${entryName}: header is missing required column(s) [${missing.join(", ")}] — got [${header.join(", ")}]`,
    );
  }
  return index;
}

/** Non-negative integer sequence, or null when blank/garbage (ordered last, still counted). */
function parseSequence(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** [verify-live] `withdrawn` values assumed "0"/"1" (boolean-ish tolerated). */
function isWithdrawn(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Builds one schema-shaped `Patent` from a g_patent row plus its joined
 * assignee/CPC aggregates; throws when a required field is unusable. The
 * emitted shape is identical to the legacy API mapping: first-listed
 * organization (or null), total assignee count, first CPC class uppercased.
 *
 * `tickerMemo` (org name → resolved tickers) exists because the same few
 * hundred thousand distinct assignees repeat across ~9.5M patents; rows
 * share the memoized array, which is safe — upserts serialize it per row.
 */
export async function normalizePatentRow(
  raw: { patentId: string; grantDate: string; title: string; wipoKind: string },
  joined: PatentJoinLookup,
  retrievedAt: string,
  store: AltDataStore,
  tickerMemo?: Map<string, string[]>,
): Promise<Patent> {
  const patentId = raw.patentId.trim();
  if (!patentId) throw new Error("patent row: missing patent_id");
  const title = raw.title.trim();
  if (!title) throw new Error(`patent ${patentId}: missing title`);
  const grantDateMatch = /^\d{4}-\d{2}-\d{2}/.exec(raw.grantDate.trim());
  if (!grantDateMatch) throw new Error(`patent ${patentId}: unparseable patent_date`);
  const grantDate = grantDateMatch[0];

  const orgName = joined.orgName?.trim() || null;
  let tickers: string[] = [];
  if (orgName) {
    const cached = tickerMemo?.get(orgName);
    if (cached) {
      tickers = cached;
    } else {
      tickers = await resolveEntityTickersTiered(store, { name: orgName });
      tickerMemo?.set(orgName, tickers);
    }
  }

  const cpcClass = joined.cpcClass?.trim();
  return {
    id: patentId,
    patentId,
    title,
    grantDate,
    assignee: { name: orgName, tickers },
    assigneeCount: joined.assigneeCount,
    kind: raw.wipoKind.trim() || null,
    cpcClass: cpcClass ? cpcClass.toUpperCase() : null,
    provenance: {
      source: "patentsview",
      sourceUrl: patentDocumentUrl(patentId),
      retrievedAt,
      parser: PATENTSVIEW_PARSER,
      confidence: 1,
      needsReview: false,
    },
  };
}

interface SideTableStats {
  rows: number;
  /** Rows with no usable patent_id — can't join, worth a note when > 0. */
  unusable: number;
}

/** Streams g_assignee_disambiguated into the scratch: org of min org-bearing sequence + row count. */
async function loadAssigneeTable(
  zipPath: string,
  scratch: PatentJoinScratch,
): Promise<SideTableStats> {
  const stats: SideTableStats = { rows: 0, unusable: 0 };
  let cols: Record<string, number> | null = null;
  await streamTsvFromZip(
    zipPath,
    TABLE_ENTRY.assignee,
    (header) => {
      cols = requireColumns(TABLE_ENTRY.assignee, header, ASSIGNEE_COLUMNS);
    },
    (fields) => {
      if (!cols) throw new OdpProductDriftError(`${TABLE_ENTRY.assignee}: record before header`);
      const patentId = (fields[cols["patent_id"] ?? -1] ?? "").trim();
      if (!patentId) {
        stats.unusable += 1;
        return;
      }
      stats.rows += 1;
      const org = (fields[cols["disambig_assignee_organization"] ?? -1] ?? "").trim();
      scratch.addAssignee(
        patentId,
        parseSequence(fields[cols["assignee_sequence"] ?? -1]),
        org || null,
      );
    },
  );
  return stats;
}

/** Streams g_cpc_current into the scratch: first (lowest-sequence) non-empty cpc_class per patent. */
async function loadCpcTable(zipPath: string, scratch: PatentJoinScratch): Promise<SideTableStats> {
  const stats: SideTableStats = { rows: 0, unusable: 0 };
  let cols: Record<string, number> | null = null;
  await streamTsvFromZip(
    zipPath,
    TABLE_ENTRY.cpc,
    (header) => {
      cols = requireColumns(TABLE_ENTRY.cpc, header, CPC_COLUMNS);
    },
    (fields) => {
      if (!cols) throw new OdpProductDriftError(`${TABLE_ENTRY.cpc}: record before header`);
      const patentId = (fields[cols["patent_id"] ?? -1] ?? "").trim();
      if (!patentId) {
        stats.unusable += 1;
        return;
      }
      stats.rows += 1;
      // Rows with an empty cpc_class are legitimate to pass over — the
      // mapping wants the first *present* class, same as the legacy API.
      const cpcClass = (fields[cols["cpc_class"] ?? -1] ?? "").trim();
      if (!cpcClass) return;
      scratch.addCpc(patentId, parseSequence(fields[cols["cpc_sequence"] ?? -1]), cpcClass);
    },
  );
  return stats;
}

export const patentsviewSource: AltDataSource = {
  id: "patentsview",
  title: "PatentsView (granted US patents)",
  datasets: ["patents"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("patentsview");
    const result = emptySyncResult("patentsview", true);
    if (opts.datasets && !opts.datasets.includes("patents")) return result;

    const apiKey = ctx.config.patentsviewApiKey;
    if (!apiKey) {
      result.notes.push(PATENTSVIEW_MISSING_KEY_NOTE);
      return result;
    }
    if (opts.since || opts.until) {
      result.notes.push(
        "since/until ignored: the ODP product ships whole-history quarterly releases " +
          "(each completed sync covers 1976→present)",
      );
    }

    const politeFetch = buildFetch(ctx);
    const now = ctx.now?.() ?? new Date();
    const retrievedAt = now.toISOString();

    let meta: OdpProductMetadata;
    try {
      meta = await fetchProductMetadata(politeFetch, apiKey);
    } catch (error) {
      // Transient HTTP trouble: keep the run alive, leave the watermark put.
      // Anything else (drift, rejected key) must fail loudly.
      if (error instanceof HttpError) {
        result.notes.push(error.message);
        return result;
      }
      throw error;
    }

    if (meta.sampleFileRow) {
      await ctx.store.setFingerprint(
        "patentsview",
        FINGERPRINT_KEY,
        fileEntryFingerprint(meta.sampleFileRow),
      );
    }

    const watermark = opts.full ? null : await ctx.store.getWatermark("patentsview", WATERMARK_KEY);
    if (watermark !== null && meta.lastModifiedDateTime <= watermark) {
      result.notes.push(
        `release ${meta.lastModifiedDateTime} already ingested (watermark ${watermark}); nothing to do`,
      );
      return result;
    }

    // Select before downloading anything: a missing table zip is drift and
    // must fail before gigabytes move.
    const tableFiles = {
      patent: selectTableFile(meta.files, PATENTSVIEW_TABLE_FILES.patent),
      assignee: selectTableFile(meta.files, PATENTSVIEW_TABLE_FILES.assignee),
      cpc: selectTableFile(meta.files, PATENTSVIEW_TABLE_FILES.cpc),
    };

    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const tmpDir = await mkdtemp(join(tmpdir(), "alt-data-patentsview-"));
    try {
      const zipPaths = { patent: "", assignee: "", cpc: "" };
      for (const key of ["patent", "assignee", "cpc"] as const) {
        const file = tableFiles[key];
        const dest = join(tmpDir, file.fileName);
        logger.info(
          `downloading ${file.fileName}` + (file.fileSize ? ` (${file.fileSize} bytes)` : ""),
        );
        try {
          await downloadProductFile(politeFetch, apiKey, file.fileDownloadURI, dest);
        } catch (error) {
          if (error instanceof HttpError) {
            result.notes.push(error.message);
            return result;
          }
          throw error;
        }
        zipPaths[key] = dest;
      }

      const scratch = await openPatentJoinScratch(join(tmpDir, "join-scratch.db"));
      try {
        const assigneeStats = await loadAssigneeTable(zipPaths.assignee, scratch);
        logger.info(`${TABLE_ENTRY.assignee}: ${assigneeStats.rows} assignee rows staged`);
        const cpcStats = await loadCpcTable(zipPaths.cpc, scratch);
        logger.info(`${TABLE_ENTRY.cpc}: ${cpcStats.rows} CPC rows staged`);
        scratch.seal();
        for (const [entry, stats] of [
          [TABLE_ENTRY.assignee, assigneeStats],
          [TABLE_ENTRY.cpc, cpcStats],
        ] as const) {
          if (stats.unusable > 0) {
            result.notes.push(`${entry}: ${stats.unusable} unusable row(s) skipped`);
          }
        }

        const tickerMemo = new Map<string, string[]>();
        const batch: Patent[] = [];
        let emitted = 0;
        let withdrawnSkipped = 0;
        let cols: Record<string, number> | null = null;

        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          const { rows } = await ctx.store.upsert(DATASETS.patents, batch);
          result.rowsUpserted += rows;
          result.perDataset.patents = (result.perDataset.patents ?? 0) + rows;
          batch.length = 0;
        };

        const outcome = await streamTsvFromZip(
          zipPaths.patent,
          TABLE_ENTRY.patent,
          (header) => {
            cols = requireColumns(TABLE_ENTRY.patent, header, PATENT_COLUMNS);
          },
          async (fields) => {
            if (!cols)
              throw new OdpProductDriftError(`${TABLE_ENTRY.patent}: record before header`);
            result.parse.attempted += 1;
            try {
              // Withdrawn patents never issued as granted patents in force;
              // they parse fine but are not emitted into the dataset.
              if (isWithdrawn(fields[cols["withdrawn"] ?? -1])) {
                result.parse.succeeded += 1;
                withdrawnSkipped += 1;
                return;
              }
              const patentId = (fields[cols["patent_id"] ?? -1] ?? "").trim();
              const patent = await normalizePatentRow(
                {
                  patentId,
                  grantDate: fields[cols["patent_date"] ?? -1] ?? "",
                  title: fields[cols["patent_title"] ?? -1] ?? "",
                  wipoKind: fields[cols["wipo_kind"] ?? -1] ?? "",
                },
                scratch.lookup(patentId),
                retrievedAt,
                ctx.store,
                tickerMemo,
              );
              batch.push(patent);
              result.parse.succeeded += 1;
              emitted += 1;
              if (batch.length >= UPSERT_BATCH) await flush();
              if (emitted >= limit) return false; // soft cap: stop streaming
            } catch (error) {
              logger.warn("patent row failed to normalize", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return undefined;
          },
        );
        await flush();

        if (withdrawnSkipped > 0) {
          result.notes.push(`skipped ${withdrawnSkipped} withdrawn patent(s)`);
        }
        logger.info(
          `${TABLE_ENTRY.patent}: ${result.parse.succeeded}/${result.parse.attempted} rows parsed, ` +
            `${result.rowsUpserted} upserted (release ${meta.lastModifiedDateTime})`,
        );

        if (outcome.stopped) {
          result.notes.push(`stopped at --limit ${opts.limit}; watermark not advanced`);
        } else {
          // Only a fully-streamed release may advance the watermark, and
          // only forward — a partial ingest must never mask the rest.
          const existing = await ctx.store.getWatermark("patentsview", WATERMARK_KEY);
          if (existing === null || meta.lastModifiedDateTime > existing) {
            await ctx.store.setWatermark("patentsview", WATERMARK_KEY, meta.lastModifiedDateTime);
          }
        }
      } finally {
        scratch.close();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();

    if (!ctx.config.patentsviewApiKey) {
      checks.push({
        name: "probe-product",
        ok: false,
        severity: "soft",
        note:
          "skipped: no USPTO Open Data Portal API key configured (ALT_DATA_PATENTSVIEW_KEY, or " +
          "patentsviewApiKey in alt-data.config.json — the key is free)",
      });
    } else {
      const politeFetch = buildFetch(ctx);
      try {
        const meta = await fetchProductMetadata(politeFetch, ctx.config.patentsviewApiKey);
        const wanted = PATENTSVIEW_TABLE_FILES.patent.toLowerCase();
        const hasPatentTable = meta.files.some((f) => f.fileName.toLowerCase() === wanted);
        checks.push({
          name: "probe-product",
          ok: hasPatentTable,
          severity: "hard",
          note: hasPatentTable
            ? `${meta.files.length} file(s); release ${meta.lastModifiedDateTime}`
            : `no '${PATENTSVIEW_TABLE_FILES.patent}' among the product's ${meta.files.length} file(s)`,
        });

        if (meta.sampleFileRow) {
          const hash = fileEntryFingerprint(meta.sampleFileRow);
          const stored = await ctx.store.getFingerprint("patentsview", FINGERPRINT_KEY);
          if (stored === null) {
            await ctx.store.setFingerprint("patentsview", FINGERPRINT_KEY, hash);
            checks.push({
              name: "fingerprint",
              ok: true,
              severity: "hard",
              note: "baseline recorded",
            });
          } else {
            checks.push({
              name: "fingerprint",
              ok: stored === hash,
              severity: "hard",
              note: stored === hash ? undefined : "product file-entry field names changed",
            });
          }
        }
      } catch (error) {
        checks.push({
          name: "probe-product",
          ok: false,
          severity: "hard",
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Re-parsing live rows would mean re-downloading a multi-GB table, so
    // the parse-rate check reuses the last recorded sync run's stats — the
    // govinfo/house-clerk/senate-efd/edgar pattern.
    const lastSync = await ctx.store.latestSyncRun("patentsview");
    if (lastSync && lastSync.parseAttempted > 0) {
      const rate = lastSync.parseSucceeded / lastSync.parseAttempted;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.99,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% over ${lastSync.parseAttempted} rows (last sync)`,
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("patents");
    checks.push({
      name: "freshness-patents",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS.patents.freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
