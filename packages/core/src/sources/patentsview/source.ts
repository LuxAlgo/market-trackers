import { scaffoldSource } from "../scaffold.js";

/**
 * PatentsView PatentSearch — granted US patents (USPTO data). Free API key
 * required by the provider (config `patentsviewApiKey` / DOCKET_PATENTSVIEW_KEY).
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/patentsview.md:
 *  - POST/GET the patent endpoint with a grant-date range since the
 *    watermark; page via the documented cursor; key in the X-Api-Key header.
 *  - Assignee→ticker via the curated map (resolve/recipients.ts).
 */

export const PATENTSVIEW_API_BASE = "https://search.patentsview.org/api/v1";
export const PATENTSVIEW_PATENT_URL = `${PATENTSVIEW_API_BASE}/patent/`;

export const patentsviewSource = scaffoldSource({
  id: "patentsview",
  title: "PatentsView (granted US patents)",
  datasets: ["patents"],
});
