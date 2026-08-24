import { scaffoldSource } from "../scaffold.js";

/**
 * House Clerk financial disclosures — Periodic Transaction Reports filed by
 * representatives.
 *
 * Ingestor scaffold. Implementation notes live in docs/sources/house-clerk.md:
 *  - Yearly ZIP index ({YYYY}FD.zip) lists all filings; type "P" rows are
 *    PTRs with per-filing PDFs.
 *  - House PTR PDFs carry a text layer with a consistent table layout —
 *    layout-aware extraction at confidence 0.9, goldens mandatory.
 *  - Member identity resolves through resolve/members.ts (bioguide IDs).
 */

export const HOUSE_CLERK_BASE = "https://disclosures-clerk.house.gov";
/** Yearly filing index; confirm exact path live before relying on it. */
export function houseClerkYearIndexUrl(year: number): string {
  return `${HOUSE_CLERK_BASE}/public_disc/financial-pdfs/${year}FD.zip`;
}

export const houseClerkSource = scaffoldSource({
  id: "house-clerk",
  title: "House Clerk financial disclosures (PTRs)",
  datasets: ["congress-trades"],
});
