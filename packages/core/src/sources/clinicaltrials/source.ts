import { scaffoldSource } from "../scaffold.js";

/**
 * ClinicalTrials.gov API v2 — study registrations and status changes.
 * Free, keyless.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/clinicaltrials.md:
 *  - GET /api/v2/studies filtered by last-update-post date since the
 *    watermark; page via pageToken; request only the modules needed.
 *  - Sponsor→ticker via the curated map (resolve/recipients.ts).
 */

export const CLINICALTRIALS_API_BASE = "https://clinicaltrials.gov/api/v2";
export const CLINICALTRIALS_STUDIES_URL = `${CLINICALTRIALS_API_BASE}/studies`;

export const clinicaltrialsSource = scaffoldSource({
  id: "clinicaltrials",
  title: "ClinicalTrials.gov (study registrations)",
  datasets: ["clinical-trials"],
});
