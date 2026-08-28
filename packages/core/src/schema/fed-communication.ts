import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One Federal Reserve Board monetary-policy communication from the Board's
 * public news-events JSON feeds (keyless): FOMC statements and minutes
 * announcements (Monetary Policy press releases), governor/chair speeches,
 * and congressional testimony. An index row with deep links — the full text
 * stays at federalreserve.gov. Facts as the Board published them; no rate
 * expectations, no tone scoring, no interpretation.
 */

export const FED_COMMUNICATION_TYPES = [
  "statement",
  "minutes",
  "pressRelease",
  "speech",
  "testimony",
] as const;

export type FedCommunicationType = (typeof FED_COMMUNICATION_TYPES)[number];

export const fedCommunicationSchema = z.object({
  /** Natural key: the feed link path minus "/newsevents/" and ".htm", e.g. "speech/cook20260805a". */
  id: z.string().min(1),
  type: z.enum(FED_COMMUNICATION_TYPES),
  /** Publication date (YYYY-MM-DD) — the date part of the feed's US-Eastern timestamp. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Title, verbatim from the feed. */
  title: z.string().min(1),
  /** Speaker as listed (e.g. "Governor Lisa D. Cook"); null for press releases. */
  speaker: z.string().nullable(),
  /** Venue/location line, verbatim; null when the feed omits it. */
  venue: z.string().nullable(),
  /** Absolute federalreserve.gov page for the full text. */
  url: z.string().url(),
  videoUrl: z.string().url().nullable(),
  /** Addendum/correction note from the feed, verbatim; null when absent. */
  note: z.string().nullable(),
  provenance: provenanceSchema,
});

export type FedCommunication = z.infer<typeof fedCommunicationSchema>;
