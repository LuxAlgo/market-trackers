import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { DocketSource, SourceContext, SourceSyncResult, SyncOptions } from "../types.js";
import { emptySyncResult, type SourceCanaryCheck } from "../types.js";
import { DATASETS } from "../../schema/datasets.js";
import {
  committeeAssignmentId,
  committeeAssignmentSchema,
  type CommitteeAssignment,
} from "../../schema/committee-assignment.js";
import { createPoliteFetch, expectOk, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import { hoursSince, isoNow } from "../../lib/dates.js";
import { DOCKET_VERSION } from "../../config.js";
import { refreshMemberMapIfStale } from "../../resolve/members.js";

/**
 * Committee assignments from the public-domain unitedstates/congress-
 * legislators dataset — the join between who trades (congress-trades rows
 * keyed by bioguide) and what their committees oversee. This is a
 * CURRENT-STATE dataset: each sync replaces the table wholesale, so a
 * member who leaves a committee actually disappears.
 *
 * Parser id: congress-legislators-yaml@1
 */

const BASE = "https://raw.githubusercontent.com/unitedstates/congress-legislators/main";
export const LEGISLATORS_COMMITTEES_URL = `${BASE}/committees-current.yaml`;
export const LEGISLATORS_COMMITTEE_MEMBERSHIP_URL = `${BASE}/committee-membership-current.yaml`;

export const COMMITTEES_PARSER = "congress-legislators-yaml@1";

const FINGERPRINT_KEY = "committees.row-shape";

interface CommitteeYaml {
  type: "house" | "senate" | "joint";
  name: string;
  thomas_id: string;
  subcommittees?: { name: string; thomas_id: string }[];
}

interface MembershipEntryYaml {
  name: string;
  rank?: number;
  title?: string;
  bioguide: string;
  chamber?: "house" | "senate";
}

export interface CommitteeParseInput {
  committeesYaml: string;
  membershipYaml: string;
  retrievedAt: string;
  /** For members of joint committees whose entry omits `chamber`. */
  memberChamberByBioguide: Map<string, "senate" | "house">;
}

export interface CommitteeParseResult {
  rows: CommitteeAssignment[];
  stats: { attempted: number; succeeded: number };
  /** Structural signature of both files' entry shapes, for drift canaries. */
  shapeSignature: string;
}

export function parseCommitteeData(input: CommitteeParseInput): CommitteeParseResult {
  const committees = parseYaml(input.committeesYaml) as CommitteeYaml[];
  const membership = parseYaml(input.membershipYaml) as Record<string, MembershipEntryYaml[]>;

  const committeeById = new Map<string, CommitteeYaml>();
  const subNameByKey = new Map<string, string>();
  for (const committee of committees) {
    committeeById.set(committee.thomas_id, committee);
    for (const sub of committee.subcommittees ?? []) {
      subNameByKey.set(`${committee.thomas_id}${sub.thomas_id}`, sub.name);
    }
  }

  const rows: CommitteeAssignment[] = [];
  const stats = { attempted: 0, succeeded: 0 };

  for (const [key, entries] of Object.entries(membership)) {
    // Keys are either a committee thomas_id ("SSAS") or committee+sub ("SSAS14").
    const committee = committeeById.get(key) ?? committeeById.get(key.slice(0, 4));
    if (!committee) continue;
    const subThomasId = committeeById.has(key) ? null : key.slice(4);
    const subName = subThomasId ? (subNameByKey.get(key) ?? null) : null;

    for (const entry of entries) {
      stats.attempted += 1;
      const chamber =
        entry.chamber ??
        (committee.type !== "joint"
          ? committee.type
          : input.memberChamberByBioguide.get(entry.bioguide));
      if (!chamber || !entry.bioguide || !entry.name) continue;

      const row: CommitteeAssignment = {
        id: committeeAssignmentId(entry.bioguide, committee.thomas_id, subThomasId),
        bioguideId: entry.bioguide,
        memberName: entry.name,
        chamber,
        committee: {
          thomasId: committee.thomas_id,
          name: committee.name,
          type: committee.type,
        },
        subcommittee: subThomasId && subName ? { thomasId: subThomasId, name: subName } : null,
        rank: entry.rank ?? null,
        title: entry.title ?? null,
        provenance: {
          source: "congress-legislators",
          sourceUrl: LEGISLATORS_COMMITTEE_MEMBERSHIP_URL,
          retrievedAt: input.retrievedAt,
          parser: COMMITTEES_PARSER,
          confidence: 1,
          needsReview: false,
        },
      };
      rows.push(committeeAssignmentSchema.parse(row));
      stats.succeeded += 1;
    }
  }

  const firstCommittee = committees[0] ? Object.keys(committees[0]).sort().join(",") : "";
  const firstEntry = Object.values(membership)[0]?.[0];
  const entryShape = firstEntry ? Object.keys(firstEntry).sort().join(",") : "";
  const shapeSignature = createHash("sha256")
    .update(`${firstCommittee}\n${entryShape}`)
    .digest("hex")
    .slice(0, 16);

  return { rows, stats, shapeSignature };
}

function buildFetch(ctx: SourceContext): PoliteFetch {
  return createPoliteFetch({
    userAgent: ctx.config.userAgent ?? `docket/${DOCKET_VERSION}`,
    limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
    fetchImpl: ctx.fetchImpl,
    logger: ctx.logger.child("congress-legislators"),
  });
}

async function fetchBoth(
  politeFetch: PoliteFetch,
): Promise<{ committees: string; membership: string }> {
  const committeesRes = await expectOk(politeFetch, LEGISLATORS_COMMITTEES_URL);
  const membershipRes = await expectOk(politeFetch, LEGISLATORS_COMMITTEE_MEMBERSHIP_URL);
  return { committees: await committeesRes.text(), membership: await membershipRes.text() };
}

export const congressLegislatorsSource: DocketSource = {
  id: "congress-legislators",
  title: "Congressional committee assignments (unitedstates/congress-legislators)",
  datasets: ["committee-assignments"],
  implemented: true,

  async sync(ctx: SourceContext, opts: SyncOptions = {}): Promise<SourceSyncResult> {
    const logger = ctx.logger.child("congress-legislators");
    const result = emptySyncResult("congress-legislators", true);
    if (opts.datasets && !opts.datasets.includes("committee-assignments")) return result;

    await refreshMemberMapIfStale(ctx.store, ctx.fetchImpl ?? fetch, logger);
    const memberChamberByBioguide = new Map(
      (await ctx.store.allMembers()).map((m) => [m.bioguideId, m.chamber]),
    );

    const { committees, membership } = await fetchBoth(buildFetch(ctx));
    const parsed = parseCommitteeData({
      committeesYaml: committees,
      membershipYaml: membership,
      retrievedAt: isoNow(),
      memberChamberByBioguide,
    });
    result.parse = parsed.stats;
    await ctx.store.setFingerprint("congress-legislators", FINGERPRINT_KEY, parsed.shapeSignature);

    // Current-state dataset: replace wholesale so departures disappear.
    const { rows } = await ctx.store.replaceDataset(DATASETS["committee-assignments"], parsed.rows);
    result.rowsUpserted = rows;
    result.perDataset["committee-assignments"] = rows;
    logger.info(`committee assignments replaced: ${rows} rows`);
    return result;
  },

  async canary(ctx: SourceContext) {
    const checks: SourceCanaryCheck[] = [];
    const now = ctx.now?.() ?? new Date();

    try {
      const { committees, membership } = await fetchBoth(buildFetch(ctx));
      const parsed = parseCommitteeData({
        committeesYaml: committees,
        membershipYaml: membership,
        retrievedAt: isoNow(),
        memberChamberByBioguide: new Map(),
      });
      checks.push({
        name: "fetch-and-parse",
        ok: parsed.rows.length > 0,
        severity: "hard",
        note: `${parsed.rows.length} assignments parsed`,
      });
      const rate = parsed.stats.attempted > 0 ? parsed.stats.succeeded / parsed.stats.attempted : 1;
      checks.push({
        name: "parse-success-rate",
        ok: rate >= 0.95,
        severity: "hard",
        note: `${(rate * 100).toFixed(2)}% of ${parsed.stats.attempted} entries (joint members without chamber hints resolve via the member map during sync)`,
      });
      const stored = await ctx.store.getFingerprint("congress-legislators", FINGERPRINT_KEY);
      if (stored === null) {
        await ctx.store.setFingerprint(
          "congress-legislators",
          FINGERPRINT_KEY,
          parsed.shapeSignature,
        );
        checks.push({ name: "fingerprint", ok: true, severity: "hard", note: "baseline recorded" });
      } else {
        checks.push({
          name: "fingerprint",
          ok: stored === parsed.shapeSignature,
          severity: "hard",
          note: stored === parsed.shapeSignature ? undefined : "yaml entry shape changed",
        });
      }
    } catch (error) {
      checks.push({
        name: "fetch-and-parse",
        ok: false,
        severity: "hard",
        note: error instanceof Error ? error.message : String(error),
      });
    }

    const lastIngested = await ctx.store.maxRetrievedAt("committee-assignments");
    checks.push({
      name: "freshness-committee-assignments",
      ok:
        lastIngested !== null &&
        hoursSince(lastIngested, now) <= DATASETS["committee-assignments"].freshnessWindowHours,
      severity: "soft",
      note: lastIngested ? `last ingested ${lastIngested}` : "no rows ingested yet",
    });

    return { checks };
  },
};
