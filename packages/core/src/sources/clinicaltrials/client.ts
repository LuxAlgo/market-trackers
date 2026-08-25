import { createHash } from "node:crypto";
import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";

/**
 * ClinicalTrials.gov API v2 client — free, keyless JSON, `pageToken`-paged.
 *
 * Everything about the live payload this module assumes is listed under
 * `[verify-live]` in docs/sources/clinicaltrials.md; the canary fingerprints
 * a study row's module/field shape so drift fails loudly rather than
 * silently under-mapping.
 */

export const CLINICALTRIALS_API_BASE = "https://clinicaltrials.gov/api/v2";
export const CLINICALTRIALS_STUDIES_URL = `${CLINICALTRIALS_API_BASE}/studies`;

/** API ceiling is 1000; the source always requests the max to minimize page count. */
export const CLINICALTRIALS_PAGE_SIZE = 1000;

/**
 * Modules requested via `fields` — exactly what `clinicalTrialSchema` needs,
 * nothing else. [verify-live] whether the live API expects these dotted
 * `protocolSection.<module>` paths or bare PascalCase module names, and
 * whether `,` is an accepted separator (vs. `|`).
 */
export const CLINICALTRIALS_FIELDS = [
  "protocolSection.identificationModule",
  "protocolSection.sponsorCollaboratorsModule",
  "protocolSection.statusModule",
  "protocolSection.designModule",
  "protocolSection.conditionsModule",
] as const;

/** Keyless and shared by every caller of this API — stay well under any published ceiling. */
export const CLINICALTRIALS_RATE_LIMIT = { limit: 2, windowMs: 1_000 } as const;

/**
 * The v2 Essie idiom for a closed date range on an indexed area:
 * `AREA[LastUpdatePostDate]RANGE[start,end]`, both bounds inclusive YYYY-MM-DD.
 * [verify-live] confirm this exact syntax (vs. `MM/DD/YYYY` bounds, or an
 * open-ended `RANGE[start,MAX]` form) against the live API — the classic
 * (pre-v2) advanced-search box used the same AREA/RANGE grammar with
 * MM/DD/YYYY dates, and v2 elsewhere in the API uses ISO dates, so ISO is
 * the better-supported guess but is unconfirmed offline.
 */
export function lastUpdatePostedRangeTerm(start: string, end: string): string {
  return `AREA[LastUpdatePostDate]RANGE[${start},${end}]`;
}

/** A partial registry date struct: `{ date, type }`, `type` unused by the schema. */
const dateStructSchema = z.object({ date: z.string().optional() }).passthrough();

const leadSponsorSchema = z.object({ name: z.string().optional() }).passthrough();

/**
 * One study, validated loosely: every module is optional (studies can omit
 * whichever don't apply) and every object passes unknown fields through.
 * Only `identificationModule.nctId` is required to even parse — everything
 * else a real row needs is enforced by the normalizer, not the schema, so a
 * missing required field fails one row instead of the whole page.
 */
export const studySchema = z.object({
  protocolSection: z
    .object({
      identificationModule: z
        .object({
          nctId: z.string().min(1),
          briefTitle: z.string().optional(),
        })
        .passthrough(),
      statusModule: z
        .object({
          overallStatus: z.string().optional(),
          startDateStruct: dateStructSchema.optional(),
          primaryCompletionDateStruct: dateStructSchema.optional(),
          lastUpdatePostDateStruct: dateStructSchema.optional(),
        })
        .passthrough()
        .optional(),
      sponsorCollaboratorsModule: z
        .object({ leadSponsor: leadSponsorSchema.optional() })
        .passthrough()
        .optional(),
      designModule: z
        .object({
          studyType: z.string().optional(),
          phases: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
      conditionsModule: z
        .object({ conditions: z.array(z.string()).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

export type ClinicalTrialsStudy = z.infer<typeof studySchema>;

/** The list envelope; studies are validated individually for parse accounting. */
export const studiesResponseSchema = z
  .object({
    studies: z.array(z.record(z.string(), z.unknown())),
    /** Absent (or empty) on the final page — the API is expected to omit it, not null it. */
    nextPageToken: z.string().nullish(),
  })
  .passthrough();

export type StudiesResponse = z.infer<typeof studiesResponseSchema>;

export interface ClinicalTrialsFetchOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export function createClinicalTrialsFetch(options: ClinicalTrialsFetchOptions): PoliteFetch {
  return createPoliteFetch({
    userAgent: options.userAgent,
    limiter: new RateLimiter(CLINICALTRIALS_RATE_LIMIT),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    logger: options.logger,
  });
}

export interface StudiesPageRequest {
  /** Inclusive lower bound on LastUpdatePostDate, YYYY-MM-DD. */
  start: string;
  /** Inclusive upper bound on LastUpdatePostDate, YYYY-MM-DD. */
  end: string;
  pageToken?: string;
  pageSize?: number;
}

export function studiesPageUrl(request: StudiesPageRequest): string {
  const url = new URL(CLINICALTRIALS_STUDIES_URL);
  url.searchParams.set("query.term", lastUpdatePostedRangeTerm(request.start, request.end));
  url.searchParams.set("fields", CLINICALTRIALS_FIELDS.join(","));
  url.searchParams.set("pageSize", String(request.pageSize ?? CLINICALTRIALS_PAGE_SIZE));
  if (request.pageToken) url.searchParams.set("pageToken", request.pageToken);
  return url.toString();
}

export async function fetchStudiesPage(
  politeFetch: PoliteFetch,
  request: StudiesPageRequest,
): Promise<StudiesResponse> {
  const url = studiesPageUrl(request);
  const response = await politeFetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new HttpError(url, response.status);
  }
  return studiesResponseSchema.parse(await response.json());
}

/** The registry's own study page — the provenance URL for every row. */
export function studyDetailUrl(nctId: string): string {
  return `https://clinicaltrials.gov/study/${encodeURIComponent(nctId)}`;
}

const PARTIAL_DATE_RE = /^\d{4}(-\d{2})?(-\d{2})?$/;
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date struct's `date` field, verbatim at whatever precision the registry
 * sent (year / month / day) — never padded into a fake day. Malformed or
 * absent input is `null`, not a guess.
 */
export function extractPartialDate(struct: unknown): string | null {
  if (!struct || typeof struct !== "object") return null;
  const date = (struct as { date?: unknown }).date;
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  return PARTIAL_DATE_RE.test(trimmed) ? trimmed : null;
}

/** Same as `extractPartialDate`, but requires full YYYY-MM-DD precision. */
export function extractFullDate(struct: unknown): string | null {
  if (!struct || typeof struct !== "object") return null;
  const date = (struct as { date?: unknown }).date;
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  return FULL_DATE_RE.test(trimmed) ? trimmed : null;
}

/**
 * Structural fingerprint: sha256 of the sorted `module.field` paths present
 * under `protocolSection` for one study row. A live rename, addition, or
 * removal of a module or field changes this hash, which is exactly what the
 * canary's `fingerprint` check watches for.
 */
export function studyRowFingerprint(study: Record<string, unknown>): string {
  const protocolSection = (study.protocolSection ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const moduleName of Object.keys(protocolSection).sort()) {
    const moduleValue = protocolSection[moduleName];
    if (moduleValue && typeof moduleValue === "object" && !Array.isArray(moduleValue)) {
      for (const field of Object.keys(moduleValue as Record<string, unknown>).sort()) {
        paths.push(`${moduleName}.${field}`);
      }
    } else {
      paths.push(moduleName);
    }
  }
  return createHash("sha256").update(paths.join("|")).digest("hex").slice(0, 16);
}
