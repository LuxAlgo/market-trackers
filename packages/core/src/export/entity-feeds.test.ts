import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATASETS, type DatasetDefinition } from "../schema/datasets.js";
import { AltDataStore } from "../store/store.js";
import {
  makeCongressTrade,
  makeGovContractAward,
  makeCommitteeAssignment,
  makeProvenance,
  makeTmpDir,
} from "../test-helpers.js";
import { writeEntityFeeds } from "./entity-feeds.js";

/**
 * All dates below are fixed and explicit — `writeEntityFeeds` takes
 * `generatedAt` as a plain argument, so none of this depends on the real
 * wall-clock time the suite happens to run at.
 */
const GENERATED_AT = "2026-06-15T12:00:00.000Z"; // window: [2026-05-16, 2026-06-15]

// `DATASETS["x"]` is concretely typed (e.g. `DatasetDefinition<CongressTrade>`);
// `writeEntityFeeds` takes the erased `DatasetDefinition` writer.ts's own
// dataset loop already holds, same as `buildRssFeed`'s call sites. This
// mirrors that cast for test call sites that go straight to `DATASETS[...]`.
function erased<T>(dataset: DatasetDefinition<T>): DatasetDefinition {
  return dataset as unknown as DatasetDefinition;
}

let tmp: { dir: string; cleanup: () => void };

afterEach(() => {
  tmp?.cleanup();
});

describe("writeEntityFeeds", () => {
  it("writes zero feeds for an empty store, and creates no feeds/ directory", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-empty");
    const dir = join(tmp.dir, "congress", "trades");

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      GENERATED_AT,
    );

    expect(result).toEqual({
      byTicker: 0,
      byMember: 0,
      filesWritten: [],
      rejected: { byTicker: 0, byMember: 0 },
    });
    expect(existsSync(join(dir, "feeds"))).toBe(false);
    await store.close();
  });

  it("has no ticker or member concept for a dataset with neither, and touches nothing", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-no-concept");
    await store.upsert(DATASETS["committee-assignments"], [makeCommitteeAssignment()]);
    const dir = join(tmp.dir, "congress", "committees");

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["committee-assignments"]),
      dir,
      GENERATED_AT,
    );

    expect(result.byTicker).toBe(0);
    expect(result.byMember).toBe(0);
    expect(result.filesWritten).toHaveLength(0);
    expect(existsSync(join(dir, "feeds"))).toBe(false);
    await store.close();
  });

  it("builds an exact by-ticker/by-member file set from a seeded store, within the 30-day window only", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-seeded");
    const dir = join(tmp.dir, "congress", "trades");

    await store.upsert(DATASETS["congress-trades"], [
      // AAA: 2 rows, member E000001 — both in-window.
      makeCongressTrade({
        id: "senate:doc-1:0",
        ticker: "AAA",
        member: { name: "Jane Example", bioguideId: "E000001", party: "I", state: "VT" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-01T00:00:00.000Z" }),
      }),
      makeCongressTrade({
        id: "senate:doc-1:1",
        rowIndex: 1,
        ticker: "AAA",
        member: { name: "Jane Example", bioguideId: "E000001", party: "I", state: "VT" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-10T00:00:00.000Z" }),
      }),
      // BBB: 1 row, member E000002 — in-window.
      makeCongressTrade({
        id: "senate:doc-2:0",
        docId: "doc-2",
        ticker: "BBB",
        member: { name: "John Sample", bioguideId: "E000002", party: "R", state: "TX" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-05T00:00:00.000Z" }),
      }),
      // OLD: 1 row, well outside the 30-day window — must not appear at all.
      makeCongressTrade({
        id: "senate:doc-3:0",
        docId: "doc-3",
        ticker: "OLD",
        member: { name: "Ghost Member", bioguideId: "E000099", party: "D", state: "CA" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-01-01T00:00:00.000Z" }),
      }),
      // Unresolved ticker and unresolved member: must be silently excluded,
      // not counted as rejected (this is an ordinary coverage limit).
      makeCongressTrade({
        id: "senate:doc-4:0",
        docId: "doc-4",
        ticker: null,
        assetDescription: "Unresolvable Corp — private placement",
        member: { name: "No Bioguide", bioguideId: null, party: null, state: null },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-12T00:00:00.000Z" }),
      }),
    ]);

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      GENERATED_AT,
    );

    expect(result.byTicker).toBe(2); // AAA, BBB (not OLD, not the null-ticker row)
    expect(result.byMember).toBe(2); // E000001, E000002 (not E000099/OLD, not the null-bioguide row)
    expect(result.rejected).toEqual({ byTicker: 0, byMember: 0 });

    const byTickerFiles = readdirSync(join(dir, "feeds", "by-ticker")).sort();
    expect(byTickerFiles).toEqual(["AAA.xml", "BBB.xml"]);
    const byMemberFiles = readdirSync(join(dir, "feeds", "by-member")).sort();
    expect(byMemberFiles).toEqual(["E000001.xml", "E000002.xml"]);

    const aaaXml = readFileSync(join(dir, "feeds", "by-ticker", "AAA.xml"), "utf8");
    expect(aaaXml).toContain('<rss version="2.0">');
    expect(aaaXml).toContain("LuxAlgo Alt Data — Congressional trades — AAA");
    expect(aaaXml.match(/<item>/g)).toHaveLength(2); // both AAA rows, none of BBB/OLD/unresolved

    const memberXml = readFileSync(join(dir, "feeds", "by-member", "E000001.xml"), "utf8");
    expect(memberXml).toContain("LuxAlgo Alt Data — Congressional trades — Jane Example");

    expect(result.filesWritten.sort()).toEqual(
      [
        join(dir, "feeds", "by-ticker", "AAA.xml"),
        join(dir, "feeds", "by-ticker", "BBB.xml"),
        join(dir, "feeds", "by-member", "E000001.xml"),
        join(dir, "feeds", "by-member", "E000002.xml"),
      ].sort(),
    );
    await store.close();
  });

  it("duplicates a row across every ticker it resolves to (array-valued ticker fields)", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-multi-ticker");
    const dir = join(tmp.dir, "contracts", "awards");

    await store.upsert(DATASETS["gov-contracts"], [
      makeGovContractAward({
        id: "CONT_AWD_MULTI_0001",
        recipient: { name: "Multi Corp", uei: "MULTIUEI01", tickers: ["MULTI1", "MULTI2"] },
        provenance: makeProvenance("usaspending", { retrievedAt: "2026-06-01T00:00:00.000Z" }),
      }),
    ]);

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["gov-contracts"]),
      dir,
      GENERATED_AT,
    );

    expect(result.byTicker).toBe(2);
    expect(result.byMember).toBe(0); // gov-contracts has no member concept
    expect(existsSync(join(dir, "feeds", "by-member"))).toBe(false);

    const multi1 = readFileSync(join(dir, "feeds", "by-ticker", "MULTI1.xml"), "utf8");
    const multi2 = readFileSync(join(dir, "feeds", "by-ticker", "MULTI2.xml"), "utf8");
    expect(multi1).toContain("CONT_AWD_MULTI_0001");
    expect(multi2).toContain("CONT_AWD_MULTI_0001");
    await store.close();
  });

  it("rejects (skips + counts) filesystem-unsafe tickers and bioguideIds without crashing", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-unsafe");
    const dir = join(tmp.dir, "congress", "trades");

    await store.upsert(DATASETS["congress-trades"], [
      makeCongressTrade({
        id: "senate:doc-1:0",
        ticker: "AC/ME", // fails [A-Z0-9.-]+
        member: { name: "Bad Member", bioguideId: "e-0001", party: "I", state: "VT" }, // fails [A-Z0-9]+
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-01T00:00:00.000Z" }),
      }),
      makeCongressTrade({
        id: "senate:doc-2:0",
        docId: "doc-2",
        ticker: "GOOD",
        member: { name: "Good Member", bioguideId: "E000005", party: "I", state: "VT" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-02T00:00:00.000Z" }),
      }),
    ]);

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      GENERATED_AT,
    );

    expect(result.rejected).toEqual({ byTicker: 1, byMember: 1 });
    expect(result.byTicker).toBe(1);
    expect(result.byMember).toBe(1);
    expect(readdirSync(join(dir, "feeds", "by-ticker")).sort()).toEqual(["GOOD.xml"]);
    expect(readdirSync(join(dir, "feeds", "by-member")).sort()).toEqual(["E000005.xml"]);
    await store.close();
  });

  it("breaks a most-active tie alphabetically, deterministically", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-tie");
    const dir = join(tmp.dir, "congress", "trades");

    await store.upsert(DATASETS["congress-trades"], [
      makeCongressTrade({
        id: "senate:doc-1:0",
        ticker: "ZTIE",
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-01T00:00:00.000Z" }),
      }),
      makeCongressTrade({
        id: "senate:doc-2:0",
        docId: "doc-2",
        ticker: "ATIE",
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-02T00:00:00.000Z" }),
      }),
    ]);

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      GENERATED_AT,
      {
        cap: 1,
      },
    );

    expect(result.byTicker).toBe(1);
    expect(readdirSync(join(dir, "feeds", "by-ticker"))).toEqual(["ATIE.xml"]);
    await store.close();
  });

  it("caps at the injected `cap`, keeping only the most-active entities", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-cap");
    const dir = join(tmp.dir, "congress", "trades");

    const rows = [];
    const counts: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };
    let i = 0;
    for (const [ticker, count] of Object.entries(counts)) {
      for (let n = 0; n < count; n++) {
        rows.push(
          makeCongressTrade({
            id: `senate:doc-${i}:0`,
            docId: `doc-${i}`,
            ticker,
            provenance: makeProvenance("senate-efd", {
              retrievedAt: `2026-06-0${(i % 9) + 1}T00:00:00.000Z`,
            }),
          }),
        );
        i += 1;
      }
    }
    await store.upsert(DATASETS["congress-trades"], rows);

    const result = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      GENERATED_AT,
      {
        cap: 2,
      },
    );

    expect(result.byTicker).toBe(2);
    expect(readdirSync(join(dir, "feeds", "by-ticker")).sort()).toEqual(["A.xml", "B.xml"]);
    await store.close();
  });

  it("rewrites the entity set exactly on each call — stale files from a prior run are removed", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-stale");
    const dir = join(tmp.dir, "congress", "trades");

    await store.upsert(DATASETS["congress-trades"], [
      makeCongressTrade({
        id: "senate:doc-1:0",
        ticker: "AAA",
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-01-10T00:00:00.000Z" }),
      }),
      makeCongressTrade({
        id: "senate:doc-2:0",
        docId: "doc-2",
        ticker: "BBB",
        // 40 days after AAA's row — outside AAA's own eligibility window once
        // time has moved on to this row's day.
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-02-19T00:00:00.000Z" }),
      }),
    ]);

    const first = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      "2026-01-10T00:00:00.000Z",
    );
    expect(first.byTicker).toBe(1);
    expect(readdirSync(join(dir, "feeds", "by-ticker"))).toEqual(["AAA.xml"]);

    const second = await writeEntityFeeds(
      store,
      erased(DATASETS["congress-trades"]),
      dir,
      "2026-02-19T00:00:00.000Z",
    );
    expect(second.byTicker).toBe(1);
    // AAA has rolled out of the 30-day window as of the new generatedAt, and
    // its stale file must be gone — not just superseded by a new one sitting
    // alongside it.
    expect(readdirSync(join(dir, "feeds", "by-ticker"))).toEqual(["BBB.xml"]);
    await store.close();
  });

  it("titles a member feed from the most recently retrieved row's spelling of the member's name", async () => {
    const store = await AltDataStore.open(":memory:");
    tmp = makeTmpDir("entity-feeds-member-name");
    const dir = join(tmp.dir, "congress", "trades");

    await store.upsert(DATASETS["congress-trades"], [
      makeCongressTrade({
        id: "senate:doc-1:0",
        ticker: "AAA",
        member: { name: "Jane Q. Example", bioguideId: "E000001", party: "I", state: "VT" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-01T00:00:00.000Z" }),
      }),
      makeCongressTrade({
        id: "senate:doc-2:0",
        docId: "doc-2",
        ticker: "AAA",
        member: { name: "Jane Example", bioguideId: "E000001", party: "I", state: "VT" },
        provenance: makeProvenance("senate-efd", { retrievedAt: "2026-06-10T00:00:00.000Z" }),
      }),
    ]);

    await writeEntityFeeds(store, erased(DATASETS["congress-trades"]), dir, GENERATED_AT);

    const xml = readFileSync(join(dir, "feeds", "by-member", "E000001.xml"), "utf8");
    // The channel title takes the most-recently-retrieved spelling; each
    // item keeps its own row's spelling verbatim (both are real history).
    const channelTitleLine = xml.split("\n").find((line) => line.trim().startsWith("<title>"));
    expect(channelTitleLine).toBe(
      "    <title>LuxAlgo Alt Data — Congressional trades — Jane Example</title>",
    );
    expect(xml).toContain("Jane Q. Example (senate)"); // the older item, unaltered
    await store.close();
  });
});
