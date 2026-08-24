import { describe, expect, it } from "vitest";
import { legislatorToEntry, matchMember } from "./members.js";
import type { MemberMapEntry } from "../store/store.js";

const MEMBERS: MemberMapEntry[] = [
  {
    bioguideId: "W000802",
    fullName: "Sheldon Whitehouse",
    firstName: "Sheldon",
    lastName: "Whitehouse",
    chamber: "senate",
    party: "Democrat",
    state: "RI",
  },
  {
    bioguideId: "S000001",
    fullName: "Alex Smith",
    firstName: "Alex",
    lastName: "Smith",
    chamber: "house",
    party: "Republican",
    state: "MO",
  },
  {
    bioguideId: "S000002",
    fullName: "Jordan Smith",
    firstName: "Jordan",
    lastName: "Smith",
    chamber: "house",
    party: "Democrat",
    state: "WA",
  },
];

describe("matchMember", () => {
  it("matches 'First Last' and 'Last, First' forms", () => {
    expect(matchMember(MEMBERS, "Sheldon Whitehouse", "senate")?.bioguideId).toBe("W000802");
    expect(matchMember(MEMBERS, "Whitehouse, Sheldon", "senate")?.bioguideId).toBe("W000802");
  });

  it("uses first name to break last-name ties, and refuses ambiguity", () => {
    expect(matchMember(MEMBERS, "Alex Smith", "house")?.bioguideId).toBe("S000001");
    expect(matchMember(MEMBERS, "Smith, Jordan", "house")?.bioguideId).toBe("S000002");
    // Bare last name with two candidates → null, never a guess.
    expect(matchMember(MEMBERS, "Smith", "house")).toBeNull();
  });

  it("respects chamber", () => {
    expect(matchMember(MEMBERS, "Sheldon Whitehouse", "house")).toBeNull();
  });

  it("ignores honorifics and suffixes", () => {
    expect(matchMember(MEMBERS, "Hon. Sheldon Whitehouse Jr.", "senate")?.bioguideId).toBe(
      "W000802",
    );
  });
});

describe("legislatorToEntry", () => {
  it("takes chamber/party/state from the most recent term", () => {
    const entry = legislatorToEntry({
      id: { bioguide: "X000001" },
      name: { first: "Pat", last: "Example", official_full: "Pat Example" },
      terms: [
        { type: "rep", party: "Independent", state: "VT" },
        { type: "sen", party: "Independent", state: "VT" },
      ],
    });
    expect(entry?.chamber).toBe("senate");
    expect(entry?.state).toBe("VT");
  });

  it("returns null for records with no terms", () => {
    expect(
      legislatorToEntry({ id: { bioguide: "X0" }, name: { first: "A", last: "B" }, terms: [] }),
    ).toBeNull();
  });
});
