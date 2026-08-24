import { z } from "zod";
import type { DocketStore, MemberMapEntry } from "../store/store.js";
import type { Logger } from "../lib/logger.js";
import { hoursSince } from "../lib/dates.js";

/**
 * Congress member identity resolution against the public-domain
 * unitedstates/congress-legislators dataset — bioguide IDs, party, state,
 * chamber. The mapping is cached in the store and refreshed weekly.
 *
 * Matching is conservative (normalized last name + first-name prefix +
 * chamber); ambiguous names resolve to null rather than to a guess.
 */

export const LEGISLATORS_CURRENT_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.json";
export const LEGISLATORS_HISTORICAL_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-historical.json";

const legislatorSchema = z.object({
  id: z.object({ bioguide: z.string() }),
  name: z.object({
    first: z.string(),
    last: z.string(),
    official_full: z.string().optional(),
  }),
  terms: z.array(
    z.object({
      type: z.enum(["sen", "rep"]),
      party: z.string().optional(),
      state: z.string().optional(),
    }),
  ),
});

const legislatorsFileSchema = z.array(legislatorSchema);

export function legislatorToEntry(raw: z.infer<typeof legislatorSchema>): MemberMapEntry | null {
  const lastTerm = raw.terms[raw.terms.length - 1];
  if (!lastTerm) return null;
  return {
    bioguideId: raw.id.bioguide,
    fullName: raw.name.official_full ?? `${raw.name.first} ${raw.name.last}`,
    firstName: raw.name.first,
    lastName: raw.name.last,
    chamber: lastTerm.type === "sen" ? "senate" : "house",
    party: lastTerm.party ?? null,
    state: lastTerm.state ?? null,
  };
}

export async function refreshMemberMapIfStale(
  store: DocketStore,
  fetchImpl: typeof fetch,
  logger: Logger,
  options: { maxAgeDays?: number; includeHistorical?: boolean } = {},
): Promise<{ refreshed: boolean; entries: number }> {
  const existing = await store.allMembers();
  if (existing.length > 0) {
    // refreshed_at rides on every row; check staleness cheaply via one row read.
    const row = await store.driver.get<{ refreshed_at: string }>(
      `SELECT "refreshed_at" FROM "member_map" LIMIT 1`,
    );
    if (row && hoursSince(row.refreshed_at) < (options.maxAgeDays ?? 7) * 24) {
      return { refreshed: false, entries: existing.length };
    }
  }

  logger.info("refreshing congress member map (unitedstates/congress-legislators)");
  const urls = [LEGISLATORS_CURRENT_URL];
  if (options.includeHistorical) urls.push(LEGISLATORS_HISTORICAL_URL);

  const entries: MemberMapEntry[] = [];
  for (const url of urls) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    const parsed = legislatorsFileSchema.parse(await response.json());
    for (const legislator of parsed) {
      const entry = legislatorToEntry(legislator);
      if (entry) entries.push(entry);
    }
  }
  await store.replaceMemberMap(entries);
  logger.info(`member map refreshed: ${entries.length} entries`);
  return { refreshed: true, entries: entries.length };
}

function normalizeNamePart(part: string): string {
  return part.toUpperCase().replace(/[.,']/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Matches a filed member name ("Sheldon Whitehouse", "Whitehouse, Sheldon")
 * to a bioguide id. Returns null on no match or ambiguity — never guesses.
 */
export function matchMember(
  members: MemberMapEntry[],
  filedName: string,
  chamber: "senate" | "house",
): MemberMapEntry | null {
  const cleaned = normalizeNamePart(filedName);
  let first = "";
  let last = "";
  if (filedName.includes(",")) {
    const [l, f] = filedName.split(",", 2);
    last = normalizeNamePart(l ?? "");
    first = normalizeNamePart(f ?? "").split(" ")[0] ?? "";
  } else {
    const parts = cleaned.split(" ").filter((p) => !/^(HON|MR|MRS|MS|DR|JR|SR|II|III|IV)$/.test(p));
    first = parts[0] ?? "";
    last = parts[parts.length - 1] ?? "";
  }
  if (!last) return null;

  const candidates = members.filter(
    (m) => m.chamber === chamber && normalizeNamePart(m.lastName) === last,
  );
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1 && first) {
    const narrowed = candidates.filter((m) => {
      const memberFirst = normalizeNamePart(m.firstName);
      return memberFirst.startsWith(first) || first.startsWith(memberFirst);
    });
    if (narrowed.length === 1) return narrowed[0] ?? null;
  }
  return null;
}
