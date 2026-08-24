import { scaffoldSource } from "../scaffold.js";

/**
 * Senate eFD — Periodic Transaction Reports filed by senators.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/senate-efd.md:
 *  - Accept the eFD agreement (session cookie), then POST the search
 *    endpoint for PTR filings since the watermark.
 *  - Web-table PTRs parse directly (confidence 0.9); scanned-image PTRs go
 *    through the pluggable scan extractor (confidence 0.7, needsReview).
 *  - Amounts stay ranges; tickers are heuristic and nullable.
 */

export const SENATE_EFD_BASE = "https://efdsearch.senate.gov";
export const SENATE_EFD_SEARCH_HOME = `${SENATE_EFD_BASE}/search/home/`;
/** Historically the JSON grid endpoint; confirm live before relying on it. */
export const SENATE_EFD_SEARCH_DATA = `${SENATE_EFD_BASE}/search/report/data/`;

export const senateEfdSource = scaffoldSource({
  id: "senate-efd",
  title: "Senate eFD (Periodic Transaction Reports)",
  datasets: ["congress-trades"],
});
