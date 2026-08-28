import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One published congressional hearing transcript package from GPO GovInfo's
 * CHRG collection (keyless). A rich index row with deep links — the
 * transcript text/PDF stay at govinfo; this record is who/what/when plus
 * working URLs, verbatim from the package's MODS metadata. No summaries,
 * no editorial tagging.
 */

export const congressHearingCommitteeSchema = z.object({
  /** Committee display name, verbatim (authority-standard form preferred). */
  name: z.string().min(1),
  /** GPO/LOC committee authority id (e.g. "hsju00"), when the record carries one. */
  authorityId: z.string().nullable(),
});

export type CongressHearingCommittee = z.infer<typeof congressHearingCommitteeSchema>;

export const congressHearingSchema = z.object({
  /** Natural key: the GovInfo package id, e.g. "CHRG-118hhrg52977". */
  id: z.string().min(1),
  packageId: z.string().min(1),
  /** Hearing title, verbatim (GPO frequently publishes these in ALL CAPS). */
  title: z.string().min(1),
  /** Holding chamber; null for joint hearings (see `docClass` for the raw code). */
  chamber: z.enum(["house", "senate"]).nullable(),
  /** Raw GPO document class, verbatim (HHRG, SHRG, JHRG, …); null if the record omits it. */
  docClass: z.string().nullable(),
  congress: z.number().int().positive(),
  session: z.number().int().nullable(),
  /** Date the hearing was held (the dataset's event date); falls back to the package's dateIssued. */
  heldDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Preferred citation, verbatim (e.g. "Serial No. 118-32"); null when absent. */
  citation: z.string().nullable(),
  committees: z.array(congressHearingCommitteeSchema),
  /** Witness lines exactly as listed in the record (often name + title + affiliation). */
  witnesses: z.array(z.string()),
  /** Bioguide ids of members the record names — the join to congress-trades/committees. */
  memberBioguideIds: z.array(z.string()),
  /** GovInfo package details page. */
  detailUrl: z.string().url(),
  /** HTML rendition of the transcript, when published. */
  htmlUrl: z.string().url().nullable(),
  /** PDF rendition of the transcript, when published. */
  pdfUrl: z.string().url().nullable(),
  provenance: provenanceSchema,
});

export type CongressHearing = z.infer<typeof congressHearingSchema>;
