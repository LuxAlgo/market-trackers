import { z } from "zod";
import type { AltDataStore, MemberMapEntry } from "../store/store.js";
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

// The generated JSON lives on the upstream repo's gh-pages branch only; the
// main branch carries just the YAML sources (fetching JSON from main 404s).
export const LEGISLATORS_CURRENT_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json";
export const LEGISLATORS_HISTORICAL_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-historical.json";

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
  store: AltDataStore,
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

const HONORIFIC_TOKENS = new Set(["HON", "MR", "MRS", "MS", "DR"]);
const SUFFIX_TOKENS = new Set(["JR", "SR", "II", "III", "IV"]);

/**
 * Normalizes a name fragment into comparison tokens: uppercase, punctuation
 * and hyphens become separators (so "Ramirez-Ortega" ≡ "Ramirez Ortega"),
 * honorifics ("Hon.") and generational suffixes (Jr/Sr/II/III/IV) drop out.
 */
function nameTokens(part: string): string[] {
  return part
    .toUpperCase()
    .replace(/[.,'’-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFIC_TOKENS.has(t) && !SUFFIX_TOKENS.has(t));
}

/** Nickname tolerance is prefix-only ("Rob" ~ "Robert"); anything looser would guess. */
function firstNamesAgree(memberFirst: string, filedFirst: string): boolean {
  if (!memberFirst || !filedFirst) return false;
  return memberFirst.startsWith(filedFirst) || filedFirst.startsWith(memberFirst);
}

interface Candidate {
  member: MemberMapEntry;
  /** First name recovered from the filed string; "" when the filing only gave a last name. */
  filedFirst: string;
}

/** Ties are broken by first name; anything still ambiguous resolves to null. */
function pickCandidate(candidates: Candidate[]): MemberMapEntry | null {
  if (candidates.length === 1) return candidates[0]?.member ?? null;
  if (candidates.length > 1) {
    const narrowed = candidates.filter(
      (c) => c.filedFirst && firstNamesAgree(nameTokens(c.member.firstName)[0] ?? "", c.filedFirst),
    );
    if (narrowed.length === 1) return narrowed[0]?.member ?? null;
  }
  return null;
}

/**
 * Matches a filed member name ("Sheldon Whitehouse", "Whitehouse, Sheldon",
 * "Hon. James R. Comer Jr.", "Ramirez Ortega, Lucia") to a bioguide id.
 * Handles honorific prefixes, generational suffixes, middle names/initials,
 * hyphenated and multi-word last names. Returns null on no match or
 * ambiguity — never guesses.
 */
export function matchMember(
  members: MemberMapEntry[],
  filedName: string,
  chamber: "senate" | "house",
): MemberMapEntry | null {
  const inChamber = members.filter((m) => m.chamber === chamber);

  if (filedName.includes(",")) {
    // "Last, First [Middle …]" — everything before the comma is the last name.
    const [l, f] = filedName.split(",", 2);
    const lastTokens = nameTokens(l ?? "");
    const filedFirst = nameTokens(f ?? "")[0] ?? "";
    if (lastTokens.length === 0) return null;
    const lastKey = lastTokens.join(" ");
    const candidates = inChamber
      .filter((m) => nameTokens(m.lastName).join(" ") === lastKey)
      .map((member) => ({ member, filedFirst }));
    return pickCandidate(candidates);
  }

  // "First [Middle …] Last" — a member matches when their last-name tokens
  // are a suffix of the filed tokens (covers "Dana Winter Field").
  const tokens = nameTokens(filedName);
  if (tokens.length === 0) return null;
  const candidates: Candidate[] = [];
  for (const member of inChamber) {
    const lastTokens = nameTokens(member.lastName);
    if (lastTokens.length === 0 || lastTokens.length > tokens.length) continue;
    const tail = tokens.slice(tokens.length - lastTokens.length);
    if (tail.join(" ") !== lastTokens.join(" ")) continue;
    const remainder = tokens.slice(0, tokens.length - lastTokens.length);
    candidates.push({ member, filedFirst: remainder[0] ?? "" });
  }
  return pickCandidate(candidates);
}
