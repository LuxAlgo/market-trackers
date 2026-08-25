import { scaffoldSource } from "../scaffold.js";

/**
 * openFDA Drugs@FDA — drug-application submission events (originals and
 * supplements) with FDA status codes. Free; an optional free key raises
 * rate limits (config `openfdaApiKey` / DOCKET_OPENFDA_KEY).
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/openfda.md:
 *  - GET /drug/drugsfda.json searched by submission status date since the
 *    watermark; page via limit/skip; one row per application+submission.
 *  - Sponsor→ticker via the curated map (resolve/recipients.ts).
 */

export const OPENFDA_API_BASE = "https://api.fda.gov";
export const OPENFDA_DRUGSFDA_URL = `${OPENFDA_API_BASE}/drug/drugsfda.json`;

export const openfdaSource = scaffoldSource({
  id: "openfda",
  title: "openFDA (drug application events)",
  datasets: ["fda-approvals"],
});
