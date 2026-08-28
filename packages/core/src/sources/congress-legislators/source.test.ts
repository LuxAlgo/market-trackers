import { describe, expect, it } from "vitest";
import {
  congressLegislatorsSource,
  parseCommitteeData,
  LEGISLATORS_COMMITTEES_URL,
  LEGISLATORS_COMMITTEE_MEMBERSHIP_URL,
} from "./source.js";
import { LEGISLATORS_CURRENT_URL } from "../../resolve/members.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

const COMMITTEES = readFixture("congress-legislators", "case-current", "committees.yaml");
const MEMBERSHIP = readFixture("congress-legislators", "case-current", "membership.yaml");

describe("parseCommitteeData (real-data fixture)", () => {
  const result = parseCommitteeData({
    committeesYaml: COMMITTEES,
    membershipYaml: MEMBERSHIP,
    retrievedAt: "2026-08-25T00:00:00.000Z",
    memberChamberByBioguide: new Map(),
  });

  it("parses every entry (joint members carry explicit chambers)", () => {
    expect(result.stats.attempted).toBe(24);
    expect(result.stats.succeeded).toBe(24);
    expect(result.rows).toHaveLength(24);
  });

  it("keeps full-committee and subcommittee assignments distinct", () => {
    const guthrie = result.rows.filter((r) => r.bioguideId === "G000558");
    const full = guthrie.find((r) => r.subcommittee === null);
    expect(full?.committee.thomasId).toBe("HSIF");
    expect(full?.committee.name).toBe("House Committee on Energy and Commerce");
    expect(full?.title).toBe("Chair");
    expect(full?.chamber).toBe("house");

    const sub = result.rows.find((r) => r.id === "B001257:HSIF:17");
    expect(sub?.subcommittee?.name).toBe("Commerce, Manufacturing, and Trade");
    expect(sub?.title).toBe("Chair");
  });

  it("resolves joint-committee member chambers from the entry itself", () => {
    const wicker = result.rows.find((r) => r.id === "W000437:JCSE");
    expect(wicker?.committee.type).toBe("joint");
    expect(wicker?.chamber).toBe("senate");
    expect(wicker?.title).toBe("Cochairman");
  });

  it("skips joint members with no chamber hint instead of guessing", () => {
    const noChamberMembership = `JCSE:\n- name: Test Person\n  rank: 1\n  bioguide: X000001\n`;
    const parsed = parseCommitteeData({
      committeesYaml: COMMITTEES,
      membershipYaml: noChamberMembership,
      retrievedAt: "2026-08-25T00:00:00.000Z",
      memberChamberByBioguide: new Map(),
    });
    expect(parsed.stats.attempted).toBe(1);
    expect(parsed.stats.succeeded).toBe(0);

    const resolved = parseCommitteeData({
      committeesYaml: COMMITTEES,
      membershipYaml: noChamberMembership,
      retrievedAt: "2026-08-25T00:00:00.000Z",
      memberChamberByBioguide: new Map([["X000001", "house"]]),
    });
    expect(resolved.stats.succeeded).toBe(1);
    expect(resolved.rows[0]?.chamber).toBe("house");
  });
});

describe("congressLegislatorsSource.sync", () => {
  function mockFetch(): typeof fetch {
    return (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u === LEGISLATORS_COMMITTEES_URL) return new Response(COMMITTEES, { status: 200 });
      if (u === LEGISLATORS_COMMITTEE_MEMBERSHIP_URL)
        return new Response(MEMBERSHIP, { status: 200 });
      if (u === LEGISLATORS_CURRENT_URL) return new Response("[]", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("replaces the current-state dataset wholesale — departures disappear", async () => {
    const store = await TrackerStore.open(":memory:");
    const ctx: SourceContext = {
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
      fetchImpl: mockFetch(),
    };

    const first = await congressLegislatorsSource.sync(ctx);
    expect(first.rowsUpserted).toBe(24);
    expect(await store.count("committee-assignments")).toBe(24);
    expect(await store.getFingerprint("congress-legislators", "committees.row-shape")).toBeTruthy();

    // Second sync serves a membership file with one committee removed: the
    // table reflects current state, not accumulated history.
    const trimmed = MEMBERSHIP.split("\nSSAS:")[0] as string;
    ctx.fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u === LEGISLATORS_COMMITTEES_URL) return new Response(COMMITTEES, { status: 200 });
      if (u === LEGISLATORS_COMMITTEE_MEMBERSHIP_URL) return new Response(trimmed, { status: 200 });
      if (u === LEGISLATORS_CURRENT_URL) return new Response("[]", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const second = await congressLegislatorsSource.sync(ctx);
    expect(second.rowsUpserted).toBeLessThan(24);
    expect(await store.count("committee-assignments")).toBe(second.rowsUpserted);
    await store.close();
  });

  it("canary goes green on healthy fetch+parse and red on shape drift", async () => {
    const store = await TrackerStore.open(":memory:");
    const ctx: SourceContext = {
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
      fetchImpl: mockFetch(),
    };
    const outcome = await congressLegislatorsSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fetch-and-parse"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);

    await store.setFingerprint("congress-legislators", "committees.row-shape", "drifted");
    const drifted = await congressLegislatorsSource.canary(ctx);
    const fingerprint = drifted.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });
});
