/**
 * Column positions (0-indexed into a line split on `|`) for the FEC's
 * headerless pipe-delimited bulk files.
 *
 * `[verify-live]` every position below. This ingestor was built and tested
 * fully offline (see docs/sources/fec.md — the network here can reach only
 * GitHub) against hand-built fixtures whose rows were written to match the
 * layouts here, following the FEC's published "file description" data
 * dictionaries as best recalled at the time of writing. That makes the
 * fixtures self-consistent by construction, not independent proof the live
 * files still match. Before depending on a production sync, cross-check
 * every position against the FEC's own current file-description PDFs
 * (linked from https://www.fec.gov/data/browse-data/?tab=bulk-data), and
 * watch the sync's per-file fingerprint (`fec.weball.columns`,
 * `fec.pas2.columns`, `fec.cn.columns`, `fec.cm.columns` — each just the
 * pipe count of the file's first line): it turns the canary red the moment
 * a live file's column *count* stops matching what's assumed here. It
 * cannot catch two columns silently swapping order while the total count
 * stays the same — that class of drift needs a human re-check against the
 * live data dictionary.
 */

/**
 * weball{yy}.txt — the "all candidates" summary file. 30 columns total;
 * only the columns this ingestor reads are named. The untouched columns
 * that exist in the real file (TRANS_FROM_AUTH, TRANS_TO_AUTH, COH_BOP,
 * CAND_CONTRIB, CAND_LOANS, OTHER_LOANS, CAND_LOAN_REPAY,
 * OTHER_LOAN_REPAY, DEBTS_OWED_BY, TTL_INDIV_CONTRIB, SPEC_ELECTION,
 * PRIM_ELECTION, RUN_ELECTION, GEN_ELECTION, GEN_ELECTION_PERCENT,
 * OTHER_POL_CMTE_CONTRIB, POL_PTY_CONTRIB, INDIV_REFUNDS, CMTE_REFUNDS)
 * are why the named indices below are non-contiguous.
 */
export const WEBALL = {
  CAND_ID: 0,
  CAND_NAME: 1,
  CAND_ICI: 2,
  /** Numeric party code (e.g. "1"/"2"/"3"). Positioned here but not read —
   *  `CAND_PTY_AFFILIATION` (the 3-letter code the schema documents, e.g.
   *  "DEM"/"REP") is the one this ingestor maps to `party`. */
  PTY_CD: 3,
  CAND_PTY_AFFILIATION: 4,
  TTL_RECEIPTS: 5,
  TTL_DISB: 7,
  COH_COP: 10,
  CAND_OFFICE_ST: 18,
  CAND_OFFICE_DISTRICT: 19,
  CVG_END_DT: 27,
} as const;

/**
 * pas2{yy}.zip → itpas2.txt — committee-to-candidate contributions. 22
 * columns total; named in full since the file has few enough columns that
 * omitting the untouched ones would save little. `SUB_ID` is the FEC's own
 * unique record id for the transaction and is the last column.
 */
export const PAS2 = {
  CMTE_ID: 0,
  AMNDT_IND: 1,
  RPT_TP: 2,
  TRANSACTION_PGI: 3,
  IMAGE_NUM: 4,
  TRANSACTION_TP: 5,
  ENTITY_TP: 6,
  NAME: 7,
  CITY: 8,
  STATE: 9,
  ZIP_CODE: 10,
  EMPLOYER: 11,
  OCCUPATION: 12,
  TRANSACTION_DT: 13,
  TRANSACTION_AMT: 14,
  OTHER_ID: 15,
  CAND_ID: 16,
  TRAN_ID: 17,
  FILE_NUM: 18,
  MEMO_CD: 19,
  MEMO_TEXT: 20,
  SUB_ID: 21,
} as const;

/**
 * cn{yy}.zip → cn.txt — candidate master. Used only to join `candidateName`
 * onto contribution rows, so only the id/name columns are named; the
 * remaining 13 columns in the real 15-column file (party, election year,
 * office, status, principal campaign committee id, address, …) are never
 * read.
 */
export const CN = {
  CAND_ID: 0,
  CAND_NAME: 1,
} as const;

/**
 * cm{yy}.zip → cm.txt — committee master. Used only to join
 * `committeeName` onto contribution rows; the remaining 13 columns in the
 * real 15-column file (treasurer, address, designation, type, filing
 * frequency, …) are never read.
 */
export const CM = {
  CMTE_ID: 0,
  CMTE_NM: 1,
} as const;
