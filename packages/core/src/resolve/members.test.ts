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
  {
    bioguideId: "K000715",
    fullName: "Robert Kestrel",
    firstName: "Robert",
    lastName: "Kestrel",
    chamber: "house",
    party: "Republican",
    state: "OH",
  },
  {
    bioguideId: "K000716",
    fullName: "Michael Kestrel",
    firstName: "Michael",
    lastName: "Kestrel",
    chamber: "house",
    party: "Democrat",
    state: "NY",
  },
  {
    bioguideId: "R000901",
    fullName: "Lucia Ramirez-Ortega",
    firstName: "Lucia",
    lastName: "Ramirez-Ortega",
    chamber: "house",
    party: "Democrat",
    state: "TX",
  },
  {
    bioguideId: "W000123",
    fullName: "Dana Winter Field",
    firstName: "Dana",
    lastName: "Winter Field",
    chamber: "house",
    party: "Independent",
    state: "VT",
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

  it("handles middle names and initials in both forms", () => {
    expect(matchMember(MEMBERS, "Kestrel, Robert A.", "house")?.bioguideId).toBe("K000715");
    expect(matchMember(MEMBERS, "Robert Alan Kestrel", "house")?.bioguideId).toBe("K000715");
  });

  it("strips honorifics and suffixes wherever they appear", () => {
    expect(matchMember(MEMBERS, "Hon. Robert Kestrel Jr.", "house")?.bioguideId).toBe("K000715");
    expect(matchMember(MEMBERS, "Kestrel Jr., Robert", "house")?.bioguideId).toBe("K000715");
    expect(matchMember(MEMBERS, "Ramirez-Ortega, Hon. Lucia", "house")?.bioguideId).toBe("R000901");
  });

  it("treats hyphens and spaces in last names as equivalent", () => {
    expect(matchMember(MEMBERS, "Ramirez-Ortega, Lucia", "house")?.bioguideId).toBe("R000901");
    expect(matchMember(MEMBERS, "Ramirez Ortega, Lucia", "house")?.bioguideId).toBe("R000901");
    expect(matchMember(MEMBERS, "Lucia Ramirez Ortega", "house")?.bioguideId).toBe("R000901");
  });

  it("matches multi-word last names with and without a comma", () => {
    expect(matchMember(MEMBERS, "Winter Field, Dana", "house")?.bioguideId).toBe("W000123");
    expect(matchMember(MEMBERS, "Dana Winter Field", "house")?.bioguideId).toBe("W000123");
    // A bare fragment of a multi-word last name is not a match.
    expect(matchMember(MEMBERS, "Field, Dana", "house")).toBeNull();
  });

  it("tolerates nicknames only as first-name prefixes — never looser", () => {
    expect(matchMember(MEMBERS, "Rob Kestrel", "house")?.bioguideId).toBe("K000715");
    expect(matchMember(MEMBERS, "Kestrel, Mike", "house")).toBeNull();
    expect(matchMember(MEMBERS, "Kestrel", "house")).toBeNull();
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
