import { scaffoldSource } from "../scaffold.js";

/**
 * USAspending — federal contract awards. Free JSON API, no key.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/usaspending.md:
 *  - POST /api/v2/search/spending_by_award/ with time_period filters since
 *    the watermark; natural key is the generated internal award id.
 *  - Recipient→ticker mapping via the curated map in
 *    resolve/data/recipient-tickers.json; unmatched recipients still stored.
 */

export const USASPENDING_API_BASE = "https://api.usaspending.gov/api/v2";
export const USASPENDING_AWARD_SEARCH_URL = `${USASPENDING_API_BASE}/search/spending_by_award/`;

export const usaspendingSource = scaffoldSource({
  id: "usaspending",
  title: "USAspending (federal contract awards)",
  datasets: ["gov-contracts"],
});
