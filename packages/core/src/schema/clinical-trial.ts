import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One study registration from ClinicalTrials.gov (API v2, free, keyless).
 * These are registry facts as sponsors filed them — statuses, phases, and
 * dates come from the registry verbatim; LuxAlgo Alt Data adds no editorial calendar
 * on top (see the README's non-goals).
 */

/** ClinicalTrials.gov dates can be year, month, or day precision. */
const partialDate = z.string().regex(/^\d{4}(-\d{2})?(-\d{2})?$/);

export const clinicalTrialSchema = z.object({
  /** Natural key: the NCT id, e.g. "NCT01234567". */
  id: z.string().min(1),
  nctId: z.string().regex(/^NCT\d+$/),
  title: z.string().min(1),
  sponsor: z.object({
    /** Lead sponsor as registered. */
    name: z.string().min(1),
    tickers: z.array(z.string()),
  }),
  /** Raw registry phase (e.g. "PHASE3", "NA"); null when absent. */
  phase: z.string().nullable(),
  /** Raw registry status (e.g. "RECRUITING", "COMPLETED"). */
  overallStatus: z.string().min(1),
  /** Raw registry study type (e.g. "INTERVENTIONAL"); null when absent. */
  studyType: z.string().nullable(),
  conditions: z.array(z.string()),
  startDate: partialDate.nullable(),
  /** The registry's primary completion date — verbatim, sponsor-declared. */
  primaryCompletionDate: partialDate.nullable(),
  /** Last update posted by the registry (YYYY-MM-DD). */
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provenance: provenanceSchema,
});

export type ClinicalTrial = z.infer<typeof clinicalTrialSchema>;
