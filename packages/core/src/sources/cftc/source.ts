import { scaffoldSource } from "../scaffold.js";

/**
 * CFTC Commitments of Traders (legacy futures-only) via the CFTC's public
 * reporting Socrata API. Free; no key required for polite use.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/cftc.md:
 *  - GET the Socrata resource filtered by report date since the watermark
 *    ($where + $order + $limit/$offset paging).
 *  - One row per report-date + contract market code.
 */

export const CFTC_API_BASE = "https://publicreporting.cftc.gov";
/** Legacy futures-only combined report; confirm the resource id live. */
export const CFTC_COT_LEGACY_FUTURES_URL = `${CFTC_API_BASE}/resource/6dca-aqww.json`;

export const cftcSource = scaffoldSource({
  id: "cftc",
  title: "CFTC Commitments of Traders (legacy futures-only)",
  datasets: ["cot-reports"],
});
