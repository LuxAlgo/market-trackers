import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

/**
 * One member↔committee (or subcommittee) assignment, from the public-domain
 * unitedstates/congress-legislators dataset. This is the join that connects
 * a member's trades to the industries their committee oversees — kept as
 * plain facts (who sits where); any interpretation is the reader's.
 */

export const committeeAssignmentSchema = z.object({
  /** Natural key: `${bioguideId}:${committeeThomasId}[:${subcommitteeThomasId}]`. */
  id: z.string().min(1),
  bioguideId: z.string().min(1),
  memberName: z.string().min(1),
  /** The member's chamber. */
  chamber: z.enum(["senate", "house"]),
  committee: z.object({
    /** Canonical committee id (thomas_id), e.g. "SSAS" (Senate Armed Services). */
    thomasId: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["senate", "house", "joint"]),
  }),
  /** Null for full-committee assignments. */
  subcommittee: z
    .object({
      thomasId: z.string().min(1),
      name: z.string().min(1),
    })
    .nullable(),
  /** Party rank within the committee where published; null otherwise. */
  rank: z.number().int().nullable(),
  /** Leadership title where published (e.g. "Chair", "Ranking Member"). */
  title: z.string().nullable(),
  provenance: provenanceSchema,
});

export type CommitteeAssignment = z.infer<typeof committeeAssignmentSchema>;

export function committeeAssignmentId(
  bioguideId: string,
  committeeThomasId: string,
  subcommitteeThomasId?: string | null,
): string {
  return subcommitteeThomasId
    ? `${bioguideId}:${committeeThomasId}:${subcommitteeThomasId}`
    : `${bioguideId}:${committeeThomasId}`;
}
