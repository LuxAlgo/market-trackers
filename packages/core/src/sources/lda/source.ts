import { scaffoldSource } from "../scaffold.js";

/**
 * Senate LDA — lobbying disclosure filings. Free REST API; an optional free
 * API key raises rate limits.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/lda.md:
 *  - GET /api/v1/filings/ paginated by filing year since the watermark;
 *    natural key is filing_uuid.
 *  - Client→ticker mapping via the curated map, same approach as contracts.
 */

export const LDA_API_BASE = "https://lda.senate.gov/api/v1";
export const LDA_FILINGS_URL = `${LDA_API_BASE}/filings/`;

export const ldaSource = scaffoldSource({
  id: "lda",
  title: "Senate LDA (lobbying filings)",
  datasets: ["lobbying-filings"],
});
