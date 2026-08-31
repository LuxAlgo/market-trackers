import type { TrackerSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import {
  insiderTransactionId,
  insiderTransactionSchema,
  type InsiderTransaction,
} from "../../schema/insider-transaction.js";
import { buildUserAgent } from "../../config.js";
import { addDays, hoursSince, toDateString } from "../../lib/dates.js";
import { HttpError, type PoliteFetch } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import { padCik } from "../edgar/full-submission.js";
import { findZipEntry, readZipEntries, type ZipEntry } from "../fec/zip.js";
import {
  BulkFormatError,
  cell,
  columnPicker,
  compareQuarters,
  createBulkFetch,
  EARLIEST_QUARTER,
  fetchQuarterArchive,
  flagValue,
  nextQuarter,
  normalizeSetDate,
  numberValue,
  parseQuarterLabel,
  parseTsvTable,
  previousQuarter,
  quarterEnd,
  quarterLabel,
  quarterOfDate,
  quarterZipUrl,
  type Quarter,
} from "./client.js";

/**
 * SEC insider-transactions data sets — DERA's official quarterly bulk
 * extraction of Forms 3/4/5, ingested a quarter at a time into the same
 * `insider-transactions` dataset the EDGAR daily-index walk feeds.
 *
 * Row identity is shared with the XML walk on purpose: within each filing,
 * rows are ordered transactions-then-holdings per table, with the data
 * sets' surrogate keys (assigned in document order by DERA's own parser —
 * [verify-live]) standing in for XML document order. The same physical
 * transaction therefore gets the same `${accession}:${nd|d}:${index}` id
 * from either path, and overlapping coverage dedupes through the upsert.
 *
 * Division of labor: this source owns the deep history (2006 Q1 → the
 * newest published quarter); the EDGAR daily-index walk owns 2004–2005 and
 * the live edge the quarterly files haven't reached yet. A backfill run
 * that reaches an unpublished quarter is COMPLETE by design — each future
 * quarterly release is picked up by this source's daily top-up instead.
 */

export const EDGAR_BULK_PARSER = "form345-dataset@1";

/** The newest quarter already ingested by the daily top-up path. */
const LAST_QUARTER_KEY = "edgar-bulk.lastQuarter";
/** A quarter's ZIP publishes roughly this long after the quarter ends. [verify-live] */
const PUBLICATION_LAG_DAYS = 45;
/** A 404 on a quarter this far past its end is URL/catalog drift, not lag. */
const MISSING_QUARTER_GRACE_DAYS = 200;
/** A run that fetches this many rows with zero parsed is format drift. */
const ZERO_PARSE_TRIPWIRE_MIN = 100;
/** Upsert batch size — a dense quarter carries a few hundred thousand rows. */
const UPSERT_BATCH = 5_000;

/** Same canonical filing link the daily-index walk records. */
function filingIndexUrl(issuerCik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(issuerCik)}/${accessionNumber}-index.htm`;
}

/** Mirror of the ownership-XML parser's ticker normalization. */
function normalizeTicker(raw: string | null): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();
  if (upper === "" || upper === "NONE" || upper === "N/A" || upper === "NA") return null;
  return upper;
}

const FORM_TYPES = new Set(["3", "4", "5", "3/A", "4/A", "5/A"]);

interface BulkSubmission {
  formType: string;
  filedAt: string | null;
  issuerCik: string;
  issuerName: string | null;
  ticker: string | null;
}

interface BulkOwner {
  name: string | null;
  cik: string | null;
  title: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPctOwner: boolean;
}

interface BulkEntry {
  sk: number;
  kind: "transaction" | "holding";
  securityTitle: string | null;
  transactedAt: string | null;
  code: string | null;
  acquiredDisposed: string | null;
  shares: number | null;
  pricePerShare: number | null;
  sharesOwnedAfter: number | null;
  directOrIndirect: string | null;
}

interface QuarterTables {
  submissions: Map<string, BulkSubmission>;
  owners: Map<string, BulkOwner[]>;
  nonDerivative: Map<string, BulkEntry[]>;
  derivative: Map<string, BulkEntry[]>;
}

function requireEntry(entries: ZipEntry[], basename: string): ZipEntry {
  const entry = findZipEntry(entries, basename);
  if (!entry) throw new BulkFormatError(`quarter archive has no ${basename}`);
  return entry;
}

function readSubmissions(entry: ZipEntry): Map<string, BulkSubmission> {
  const table = parseTsvTable(entry.data);
  const pick = columnPicker(table, "SUBMISSION.tsv");
  const accession = pick("ACCESSION_NUMBER");
  const filingDate = pick("FILING_DATE");
  const formType = pick("DOCUMENT_TYPE", false) >= 0 ? pick("DOCUMENT_TYPE", false) : pick("FORM_TYPE");
  const issuerCik = pick("ISSUERCIK");
  const issuerName = pick("ISSUERNAME");
  const symbol = pick("ISSUERTRADINGSYMBOL", false);

  const out = new Map<string, BulkSubmission>();
  for (const row of table.rows) {
    const acc = cell(row, accession);
    const cik = cell(row, issuerCik);
    if (!acc || !cik) continue;
    out.set(acc, {
      formType: cell(row, formType) ?? "",
      filedAt: normalizeSetDate(cell(row, filingDate)),
      issuerCik: padCik(cik),
      issuerName: cell(row, issuerName),
      ticker: normalizeTicker(cell(row, symbol)),
    });
  }
  return out;
}

function readOwners(entry: ZipEntry): Map<string, BulkOwner[]> {
  const table = parseTsvTable(entry.data);
  const pick = columnPicker(table, "REPORTINGOWNER.tsv");
  const accession = pick("ACCESSION_NUMBER");
  const cik = pick("RPTOWNERCIK");
  const name = pick("RPTOWNERNAME");
  // Relationship shipping varies by vintage: boolean columns, or one text
  // column naming the roles. Accept either; absent both, flags stay false
  // (attribution metadata only — amounts and identity are never affected).
  const isDirector = pick("RPTOWNER_ISDIRECTOR", false) >= 0 ? pick("RPTOWNER_ISDIRECTOR", false) : pick("ISDIRECTOR", false);
  const isOfficer = pick("RPTOWNER_ISOFFICER", false) >= 0 ? pick("RPTOWNER_ISOFFICER", false) : pick("ISOFFICER", false);
  const isTenPct = pick("RPTOWNER_ISTENPERCENTOWNER", false) >= 0 ? pick("RPTOWNER_ISTENPERCENTOWNER", false) : pick("ISTENPERCENTOWNER", false);
  const title = pick("RPTOWNER_OFFICERTITLE", false) >= 0 ? pick("RPTOWNER_OFFICERTITLE", false) : pick("OFFICERTITLE", false);
  const relationshipText = pick("RPTOWNER_RELATIONSHIP", false);

  const out = new Map<string, BulkOwner[]>();
  for (const row of table.rows) {
    const acc = cell(row, accession);
    if (!acc) continue;
    const relationship = (cell(row, relationshipText) ?? "").toLowerCase();
    const owner: BulkOwner = {
      name: cell(row, name),
      cik: cell(row, cik) === null ? null : padCik(cell(row, cik) as string),
      title: cell(row, title),
      isDirector: flagValue(cell(row, isDirector)) || relationship.includes("director"),
      isOfficer: flagValue(cell(row, isOfficer)) || relationship.includes("officer"),
      isTenPctOwner:
        flagValue(cell(row, isTenPct)) ||
        relationship.includes("10%") ||
        relationship.includes("tenpercent") ||
        relationship.includes("ten percent"),
    };
    const list = out.get(acc);
    if (list) list.push(owner);
    else out.set(acc, [owner]);
  }
  return out;
}

function readEntries(
  entry: ZipEntry | null,
  tableName: string,
  skColumn: string,
  kind: "transaction" | "holding",
  into: Map<string, BulkEntry[]>,
): void {
  if (!entry) return;
  const table = parseTsvTable(entry.data);
  const pick = columnPicker(table, tableName);
  const accession = pick("ACCESSION_NUMBER");
  const sk = pick(skColumn);
  const securityTitle = pick("SECURITY_TITLE", false);
  const transDate = kind === "transaction" ? pick("TRANS_DATE", false) : -1;
  const transCode = kind === "transaction" ? pick("TRANS_CODE", false) : -1;
  const acqDisp = kind === "transaction" ? pick("TRANS_ACQUIRED_DISP_CD", false) : -1;
  const shares = kind === "transaction" ? pick("TRANS_SHARES", false) : -1;
  const price = kind === "transaction" ? pick("TRANS_PRICEPERSHARE", false) : -1;
  const owned = pick("SHRS_OWND_FOLWNG_TRANS", false);
  const directIndirect = pick("DIRECT_INDIRECT_OWNERSHIP", false);

  for (const row of table.rows) {
    const acc = cell(row, accession);
    if (!acc) continue;
    const parsed: BulkEntry = {
      sk: numberValue(cell(row, sk)) ?? Number.MAX_SAFE_INTEGER,
      kind,
      securityTitle: cell(row, securityTitle),
      transactedAt: kind === "transaction" ? normalizeSetDate(cell(row, transDate)) : null,
      code: kind === "transaction" ? cell(row, transCode) : null,
      acquiredDisposed: kind === "transaction" ? cell(row, acqDisp) : null,
      shares: kind === "transaction" ? numberValue(cell(row, shares)) : null,
      pricePerShare: kind === "transaction" ? numberValue(cell(row, price)) : null,
      sharesOwnedAfter: numberValue(cell(row, owned)),
      directOrIndirect: cell(row, directIndirect),
    };
    const list = into.get(acc);
    if (list) list.push(parsed);
    else into.set(acc, [parsed]);
  }
}

export function readQuarterTables(bytes: Uint8Array): QuarterTables {
  const entries = readZipEntries(bytes);
  const submissions = readSubmissions(requireEntry(entries, "SUBMISSION.tsv"));
  const owners = readOwners(requireEntry(entries, "REPORTINGOWNER.tsv"));

  const nonDerivative = new Map<string, BulkEntry[]>();
  const derivative = new Map<string, BulkEntry[]>();
  // Transactions load before holdings so the shared-with-XML row ordering
  // (transactions first, then holdings, each in document order) falls out
  // of a stable per-kind sort below.
  readEntries(
    requireEntry(entries, "NONDERIV_TRANS.tsv"),
    "NONDERIV_TRANS.tsv",
    "NONDERIV_TRANS_SK",
    "transaction",
    nonDerivative,
  );
  readEntries(
    findZipEntry(entries, "NONDERIV_HOLDING.tsv"),
    "NONDERIV_HOLDING.tsv",
    "NONDERIV_HOLDING_SK",
    "holding",
    nonDerivative,
  );
  readEntries(
    findZipEntry(entries, "DERIV_TRANS.tsv"),
    "DERIV_TRANS.tsv",
    "DERIV_TRANS_SK",
    "transaction",
    derivative,
  );
  readEntries(
    findZipEntry(entries, "DERIV_HOLDING.tsv"),
    "DERIV_HOLDING.tsv",
    "DERIV_HOLDING_SK",
    "holding",
    derivative,
  );
  return { submissions, owners, nonDerivative, derivative };
}

/** Transactions first, then holdings; document order (the SK) within each. */
function orderEntries(entries: BulkEntry[]): BulkEntry[] {
  const transactions = entries.filter((e) => e.kind === "transaction").sort((a, b) => a.sk - b.sk);
  const holdings = entries.filter((e) => e.kind === "holding").sort((a, b) => a.sk - b.sk);
  return [...transactions, ...holdings];
}

export function assembleQuarterRows(
  tables: QuarterTables,
  retrievedAt: string,
  result: SourceSyncResult,
  logger: Logger,
): InsiderTransaction[] {
  const rows: InsiderTransaction[] = [];
  const accessions = new Set<string>([...tables.nonDerivative.keys(), ...tables.derivative.keys()]);

  for (const accession of accessions) {
    const byTable: Array<["nd" | "d", BulkEntry[]]> = [
      ["nd", orderEntries(tables.nonDerivative.get(accession) ?? [])],
      ["d", orderEntries(tables.derivative.get(accession) ?? [])],
    ];
    const total = byTable.reduce((n, [, list]) => n + list.length, 0);
    result.parse.attempted += total;

    const submission = tables.submissions.get(accession);
    const owners = tables.owners.get(accession) ?? [];
    const owner = owners[0];
    if (!submission || !owner) {
      logger.warn("filing rows without submission or owner record", { accession });
      continue;
    }
    const needsReview = owners.length > 1;

    for (const [table, list] of byTable) {
      list.forEach((entry, index) => {
        try {
          const row: InsiderTransaction = {
            id: insiderTransactionId(accession, table, index),
            accessionNumber: accession,
            formType: submission.formType as InsiderTransaction["formType"],
            ticker: submission.ticker,
            issuerCik: submission.issuerCik,
            issuerName: submission.issuerName ?? "",
            insider: {
              name: owner.name ?? "",
              cik: owner.cik ?? "",
              title: owner.title,
              isDirector: owner.isDirector,
              isOfficer: owner.isOfficer,
              isTenPctOwner: owner.isTenPctOwner,
            },
            transactedAt: entry.transactedAt,
            filedAt: submission.filedAt ?? "",
            code: entry.code,
            acquiredDisposed:
              entry.acquiredDisposed === "A" || entry.acquiredDisposed === "D"
                ? entry.acquiredDisposed
                : null,
            securityTitle: entry.securityTitle ?? "Unknown security",
            shares: entry.shares,
            pricePerShare: entry.pricePerShare,
            sharesOwnedAfter: entry.sharesOwnedAfter,
            ownership: entry.directOrIndirect === "I" ? "indirect" : "direct",
            isDerivative: table === "d",
            provenance: {
              source: "edgar-bulk",
              sourceUrl: filingIndexUrl(submission.issuerCik, accession),
              retrievedAt,
              parser: EDGAR_BULK_PARSER,
              confidence: 1,
              needsReview,
            },
          };
          if (!FORM_TYPES.has(row.formType)) {
            throw new Error(`unexpected form type '${submission.formType}'`);
          }
          rows.push(insiderTransactionSchema.parse(row));
          result.parse.succeeded += 1;
        } catch (error) {
          logger.warn("data-set row failed to normalize", {
            accession,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }
  return rows;
}

async function ingestQuarter(
  ctx: SourceContext,
  politeFetch: PoliteFetch,
  q: Quarter,
  result: SourceSyncResult,
  logger: Logger,
): Promise<"ingested" | "not-published"> {
  const bytes = await fetchQuarterArchive(politeFetch, q);
  if (bytes === null) return "not-published";

  const retrievedAt = (ctx.now?.() ?? new Date()).toISOString();
  const tables = readQuarterTables(bytes);
  const rows = assembleQuarterRows(tables, retrievedAt, result, logger);
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { rows: upserted } = await ctx.store.upsert(
      DATASETS["insider-transactions"],
      rows.slice(i, i + UPSERT_BATCH),
    );
    result.rowsUpserted += upserted;
    result.perDataset["insider-transactions"] =
      (result.perDataset["insider-transactions"] ?? 0) + upserted;
  }
  if (result.parse.attempted >= ZERO_PARSE_TRIPWIRE_MIN && result.parse.succeeded === 0) {
    throw new BulkFormatError(
      `edgar-bulk: ${result.parse.attempted} rows fetched with zero parsed — format-drift tripwire (${quarterLabel(q)})`,
    );
  }
  await ctx.store.setWatermark("edgar-bulk", LAST_QUARTER_KEY, quarterLabel(q));
  logger.info(`ingested ${quarterLabel(q)}: ${rows.length} rows`);
  result.notes.push(`${quarterLabel(q)}: ${rows.length} rows`);
  return "ingested";
}

/** The newest quarter whose ZIP should exist, given the publication lag. */
export function expectedLatestQuarter(today: string): Quarter {
  const horizon = addDays(today, -PUBLICATION_LAG_DAYS);
  const q = quarterOfDate(horizon);
  return quarterEnd(q) > horizon ? previousQuarter(q) : q;
}

async function backfillSync(
  ctx: SourceContext,
  opts: SyncOptions,
  until: string,
): Promise<SourceSyncResult> {
  const logger = ctx.logger.child("edgar-bulk");
  const result = emptySyncResult("edgar-bulk", true);
  const politeFetch = createBulkFetch({
    userAgent: buildUserAgent(ctx.config),
    fetchImpl: ctx.fetchImpl,
    logger,
  });
  const today = toDateString(ctx.now?.() ?? new Date());

  const sinceQuarter = quarterOfDate(opts.since ?? until);
  let q = compareQuarters(sinceQuarter, EARLIEST_QUARTER) < 0 ? EARLIEST_QUARTER : sinceQuarter;
  const endQuarter = quarterOfDate(until);
  let lastCoveredEnd: string | null = null;

  const pastDeadline = () =>
    opts.deadlineMs !== undefined && (ctx.now?.() ?? new Date()).getTime() >= opts.deadlineMs;

  while (compareQuarters(q, endQuarter) <= 0) {
    if (pastDeadline()) {
      result.stoppedEarly = "deadline";
      result.notes.push(`time budget reached before ${quarterLabel(q)}`);
      break;
    }
    let outcome: "ingested" | "not-published";
    try {
      outcome = await ingestQuarter(ctx, politeFetch, q, result, logger);
    } catch (error) {
      if (error instanceof HttpError) {
        result.notes.push(error.message);
        result.stoppedEarly = "upstream";
        break;
      }
      throw error;
    }
    if (outcome === "not-published") {
      if (quarterEnd(q) < addDays(today, -MISSING_QUARTER_GRACE_DAYS)) {
        // An old quarter answering 404 is URL/catalog drift, never lag.
        result.notes.push(`${quarterLabel(q)}: ZIP missing far past publication lag — URL drift?`);
        result.stoppedEarly = "upstream";
        break;
      }
      // Every published quarter is ingested — the walk is COMPLETE by
      // design; the daily top-up picks up each future quarterly release.
      result.notes.push(`${quarterLabel(q)} not published yet; bulk history is current`);
      break;
    }
    lastCoveredEnd = quarterEnd(q);
    q = nextQuarter(q);
  }

  result.completedThrough =
    lastCoveredEnd === null ? null : lastCoveredEnd < today ? lastCoveredEnd : today;
  return result;
}

export const edgarBulkSource: TrackerSource = {
  id: "edgar-bulk",
  title: "SEC insider transactions data sets (quarterly bulk)",
  datasets: ["insider-transactions"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("edgar-bulk");
    const result = emptySyncResult("edgar-bulk", true);
    if (opts.datasets && !opts.datasets.includes("insider-transactions")) return result;

    // A bounded window is the historical walk — the backfill engine always
    // sets `until`. The daily top-up below never does.
    if (opts.until !== undefined) return backfillSync(ctx, opts, opts.until);

    const politeFetch = createBulkFetch({
      userAgent: buildUserAgent(ctx.config),
      fetchImpl: ctx.fetchImpl,
      logger,
    });
    const today = toDateString(ctx.now?.() ?? new Date());
    const expected = expectedLatestQuarter(today);
    const stored = parseQuarterLabel(await ctx.store.getWatermark("edgar-bulk", LAST_QUARTER_KEY));

    if (stored && compareQuarters(stored, expected) >= 0) {
      result.notes.push(`bulk sets current through ${quarterLabel(stored)}`);
      return result;
    }

    // Cold store: ingest only the newest published quarter — the deep walk
    // belongs to the backfill, not to a daily sync's time budget. The same
    // rule caps catch-up after a long outage at two quarters.
    let q = stored ? nextQuarter(stored) : expected;
    const floor = previousQuarter(expected);
    if (stored && compareQuarters(q, floor) < 0) {
      result.notes.push(
        `catching up from ${quarterLabel(floor)}; older quarters belong to the backfill`,
      );
      q = floor;
    }
    while (compareQuarters(q, expected) <= 0) {
      let outcome: "ingested" | "not-published";
      try {
        outcome = await ingestQuarter(ctx, politeFetch, q, result, logger);
      } catch (error) {
        if (error instanceof HttpError) {
          result.notes.push(error.message);
          result.stoppedEarly = "upstream";
          return result;
        }
        throw error;
      }
      if (outcome === "not-published") {
        // Lag ran longer than assumed; the next daily sync retries.
        result.notes.push(`${quarterLabel(q)} not published yet`);
        return result;
      }
      q = nextQuarter(q);
    }
    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();
    const today = toDateString(now);

    try {
      const politeFetch = createBulkFetch({
        userAgent: buildUserAgent(ctx.config),
        fetchImpl: ctx.fetchImpl,
        logger: ctx.logger,
      });
      // HEAD keeps the probe to headers — these ZIPs run tens of MB.
      // [verify-live] sec.gov answering HEAD on /files/ paths.
      let probe = expectedLatestQuarter(today);
      let response = await politeFetch(quarterZipUrl(probe), { method: "HEAD" });
      if (response.status === 404) {
        // Publication lag runs long sometimes; one quarter of slack.
        probe = previousQuarter(probe);
        response = await politeFetch(quarterZipUrl(probe), { method: "HEAD" });
      }
      checks.push({
        name: "probe-quarter-zip",
        ok: response.ok,
        severity: "hard",
        note: response.ok
          ? `${quarterLabel(probe)} ZIP is served`
          : `HTTP ${response.status} for ${quarterZipUrl(probe)}`,
      });
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      checks.push({
        name: "probe-quarter-zip",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    // The dataset is shared with the EDGAR daily walk, so freshness here is
    // a soft corroboration, not this source's own liveness.
    const lastIngested = await ctx.store.maxRetrievedAt("insider-transactions");
    checks.push({
      name: "freshness-insider-transactions",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["insider-transactions"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
