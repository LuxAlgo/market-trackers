import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * Patent-side join scratch: per-patent assignee/CPC aggregates keyed by
 * patent_id, staged in a throwaway better-sqlite3 file while the three
 * bulk tables stream past.
 *
 * Why a temp SQLite file and not two in-heap Maps: the product covers
 * ~9.5M granted patents, and two Maps that size retain roughly 2–3 GB of
 * heap — fine on CI (12 GB `NODE_OPTIONS` heap) but flirting with Node's
 * default old-space ceiling on the end-user machines that run
 * `npx @luxalgo/market-trackers-cli sync`. A scratch table keeps memory flat no
 * matter how the dataset grows, works identically whether the main store
 * is SQLite or Postgres (better-sqlite3 is already a core dependency), and
 * costs low minutes of insert/lookup time on a job that already downloads
 * multiple gigabytes once a quarter.
 *
 * Durability is deliberately zero (`journal_mode = MEMORY`,
 * `synchronous = OFF`): the file lives in the sync's temp dir and a crash
 * simply reruns the sync.
 */

/** Ordering sentinel for a row whose sequence didn't parse: never beats a real one. */
const SEQ_UNKNOWN = 2_147_483_647;

/** Inserts per transaction — large enough to amortize BEGIN/COMMIT, small enough to stay boring. */
const BATCH_SIZE = 50_000;

export interface PatentJoinLookup {
  /** Organization on the lowest-sequence org-bearing assignee row; null when none. */
  orgName: string | null;
  /** Total assignee rows for the patent, individuals included. */
  assigneeCount: number;
  /** cpc_class on the lowest-sequence row that has one; null when none. */
  cpcClass: string | null;
}

export interface PatentJoinScratch {
  addAssignee(patentId: string, sequence: number | null, org: string | null): void;
  addCpc(patentId: string, sequence: number | null, cpcClass: string): void;
  /** Commits the open insert batch; call once between the insert and lookup phases. */
  seal(): void;
  lookup(patentId: string): PatentJoinLookup;
  close(): void;
}

export async function openPatentJoinScratch(path: string): Promise<PatentJoinScratch> {
  // Same dynamic-import pattern as store/sql-driver.ts.
  const { default: Database } = await import("better-sqlite3");
  const db: SqliteDatabase = new Database(path);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.exec(`
    CREATE TABLE assignee (
      patent_id TEXT PRIMARY KEY,
      org TEXT,
      org_seq INTEGER,
      n INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE cpc (
      patent_id TEXT PRIMARY KEY,
      cls TEXT NOT NULL,
      seq INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);

  // "First-listed organization" = lowest assignee_sequence that carries an
  // org, regardless of file order; individuals (org-less rows) only bump
  // the count. Mirrors the legacy API mapping exactly.
  const insertAssignee = db.prepare(`
    INSERT INTO assignee (patent_id, org, org_seq, n) VALUES (?, ?, ?, 1)
    ON CONFLICT(patent_id) DO UPDATE SET
      n = n + 1,
      org = CASE
        WHEN excluded.org IS NOT NULL AND (assignee.org IS NULL OR excluded.org_seq < assignee.org_seq)
        THEN excluded.org ELSE assignee.org END,
      org_seq = CASE
        WHEN excluded.org IS NOT NULL AND (assignee.org IS NULL OR excluded.org_seq < assignee.org_seq)
        THEN excluded.org_seq ELSE assignee.org_seq END
  `);
  const insertCpc = db.prepare(`
    INSERT INTO cpc (patent_id, cls, seq) VALUES (?, ?, ?)
    ON CONFLICT(patent_id) DO UPDATE SET cls = excluded.cls, seq = excluded.seq
    WHERE excluded.seq < cpc.seq
  `);
  const selectAssignee = db.prepare(`SELECT org, n FROM assignee WHERE patent_id = ?`);
  const selectCpc = db.prepare(`SELECT cls FROM cpc WHERE patent_id = ?`);

  let inTx = false;
  let opsInTx = 0;

  const batched = (run: () => void): void => {
    if (!inTx) {
      db.exec("BEGIN");
      inTx = true;
    }
    run();
    opsInTx += 1;
    if (opsInTx >= BATCH_SIZE) {
      db.exec("COMMIT");
      inTx = false;
      opsInTx = 0;
    }
  };
  const seal = (): void => {
    if (inTx) {
      db.exec("COMMIT");
      inTx = false;
      opsInTx = 0;
    }
  };

  return {
    addAssignee(patentId, sequence, org) {
      const hasOrg = org !== null && org !== "";
      batched(() =>
        insertAssignee.run(
          patentId,
          hasOrg ? org : null,
          hasOrg ? (sequence ?? SEQ_UNKNOWN) : null,
        ),
      );
    },
    addCpc(patentId, sequence, cpcClass) {
      batched(() => insertCpc.run(patentId, cpcClass, sequence ?? SEQ_UNKNOWN));
    },
    seal,
    lookup(patentId) {
      const a = selectAssignee.get(patentId) as { org: string | null; n: number } | undefined;
      const c = selectCpc.get(patentId) as { cls: string } | undefined;
      return {
        orgName: a?.org ?? null,
        assigneeCount: a?.n ?? 0,
        cpcClass: c?.cls ?? null,
      };
    },
    close() {
      seal();
      db.close();
    },
  };
}
