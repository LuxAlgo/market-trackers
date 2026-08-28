import { describe, expect, it } from "vitest";
import {
  federalreserveSource,
  FED_PRESS_FEED_URL,
  FED_SPEECHES_FEED_URL,
  FED_TESTIMONY_FEED_URL,
  FederalReserveFeedDriftError,
  classifyMonetaryPolicyTitle,
  fedDateToIso,
  fedItemIdFromLink,
  stripBom,
} from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { FedCommunication } from "../../schema/fed-communication.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network against the three-feed
 * fixture. The fixture files carry a real UTF-8 BOM (as the live feeds do),
 * so the happy path proves BOM stripping; the press feed mixes categories,
 * so it proves the Monetary Policy filter and the per-title type mapping.
 */

const NOW = "2026-08-27T12:00:00.000Z";
const CASE = ["federalreserve", "case-feeds"];

function mockFetch(captured: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    captured.push(url);
    if (url === FED_SPEECHES_FEED_URL) {
      return new Response(readFixture(...CASE, "ne-speeches.json"), { status: 200 });
    }
    if (url === FED_TESTIMONY_FEED_URL) {
      return new Response(readFixture(...CASE, "ne-testimony.json"), { status: 200 });
    }
    if (url === FED_PRESS_FEED_URL) {
      return new Response(readFixture(...CASE, "ne-press.json"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: TrackerStore; captured: string[] }> {
  const store = await TrackerStore.open(":memory:");
  const captured: string[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

const WATERMARK = "feeds.latestItemDate";

describe("federalreserveSource.sync", () => {
  it("ingests all three BOM-prefixed feeds, keeping only Monetary Policy press items", async () => {
    const { ctx, store, captured } = await makeCtx();

    // The fixtures genuinely start with a BOM — the happy path only works
    // if stripBom runs before JSON.parse.
    expect(readFixture(...CASE, "ne-press.json").charCodeAt(0)).toBe(0xfeff);

    const result = await federalreserveSource.sync(ctx);
    expect(result.rowsUpserted).toBe(6);
    expect(result.perDataset["fed-communications"]).toBe(6);
    // 2 speeches + 1 testimony + 5 press items all parse; the 2 items
    // outside Monetary Policy are out of scope, not failures.
    expect(result.parse).toEqual({ attempted: 8, succeeded: 8 });
    expect(captured).toEqual([FED_SPEECHES_FEED_URL, FED_TESTIMONY_FEED_URL, FED_PRESS_FEED_URL]);

    const rows: FedCommunication[] = [];
    for await (const row of store.iterate(DATASETS["fed-communications"])) rows.push(row);
    expect(rows).toEqual(readFixtureJson<FedCommunication[]>(...CASE, "expected.json"));

    // The out-of-scope categories never enter the store.
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("pressreleases/enforcement20260812a");
    expect(ids).not.toContain("pressreleases/orders20260818a");

    // Informational watermark: the newest communication date seen.
    expect(await store.getWatermark("federalreserve", WATERMARK)).toBe("2026-08-25");
    expect(await store.getFingerprint("federalreserve", "press.item-fields")).toBeTruthy();

    await store.close();
  });

  it("notes every feed that returns fewer than 50 entries so operators notice", async () => {
    const { ctx, store } = await makeCtx();
    const result = await federalreserveSource.sync(ctx);
    const shortNotes = result.notes.filter((n) => n.includes("feed may have shortened"));
    expect(shortNotes).toHaveLength(3);
    expect(shortNotes.join(" ")).toContain("ne-press.json: only 5 entries");
    await store.close();
  });

  it("re-running (and --full) is the same idempotent full pass", async () => {
    const { ctx, store } = await makeCtx();
    await federalreserveSource.sync(ctx);
    const second = await federalreserveSource.sync(ctx, { full: true });
    expect(second.rowsUpserted).toBe(6);
    expect(await store.count("fed-communications")).toBe(6);
    await store.close();
  });

  it("skip-and-counts a malformed item and holds the watermark back", async () => {
    const { ctx, store } = await makeCtx();
    const good = {
      d: "8/20/2026 2:00:00 PM",
      t: "Federal Reserve issues FOMC statement",
      pt: "Monetary Policy",
      l: "/newsevents/pressreleases/monetary20260820a.htm",
    };
    const bad = { d: "not a date", t: "Broken item", pt: "Monetary Policy", l: "/x.htm" };
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === FED_PRESS_FEED_URL) {
        return new Response(JSON.stringify([good, bad]), { status: 200 });
      }
      return new Response("﻿[]", { status: 200 });
    }) as typeof fetch;

    const result = await federalreserveSource.sync(ctx);
    expect(result.rowsUpserted).toBe(1);
    expect(result.parse).toEqual({ attempted: 2, succeeded: 1 });
    expect(await store.getWatermark("federalreserve", WATERMARK)).toBeNull();

    await store.close();
  });

  it("notes a transport failure on one feed and still ingests the others", async () => {
    const { ctx, store } = await makeCtx();
    const base = ctx.fetchImpl as typeof fetch;
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      // 400 is not a retry status, so the polite fetch surfaces it directly.
      if (url === FED_TESTIMONY_FEED_URL) return new Response("boom", { status: 400 });
      return base(input);
    }) as typeof fetch;

    const result = await federalreserveSource.sync(ctx);
    expect(result.notes.join(" ")).toContain("HTTP 400");
    expect(result.rowsUpserted).toBe(5); // 2 speeches + 3 monetary-policy press
    // An incomplete pass never advances the informational watermark.
    expect(await store.getWatermark("federalreserve", WATERMARK)).toBeNull();

    await store.close();
  });

  it("rejects loudly when a feed's 200 body is not a JSON array", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () =>
      new Response('﻿{"not":"an array"}', { status: 200 })) as typeof fetch;

    await expect(federalreserveSource.sync(ctx)).rejects.toThrow(FederalReserveFeedDriftError);
    await store.close();
  });

  it("honors --limit as a shared item cap and notes the stop", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await federalreserveSource.sync(ctx, { limit: 3 });

    // 2 speeches + 1 testimony spend the budget; the press feed is never fetched.
    expect(result.parse.attempted).toBe(3);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(captured).not.toContain(FED_PRESS_FEED_URL);
    expect(await store.getWatermark("federalreserve", WATERMARK)).toBeNull();

    await store.close();
  });

  it("respects the datasets filter as a full no-op", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await federalreserveSource.sync(ctx, { datasets: ["bills"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });
});

describe("federalreserveSource.canary", () => {
  it("goes green when the press feed parses and contains Monetary Policy items", async () => {
    const { ctx, store } = await makeCtx();

    const outcome = await federalreserveSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-press-feed"]?.ok).toBe(true);
    expect(byName["probe-press-feed"]?.note).toContain("3 in 'Monetary Policy'");
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-fed-communications"]?.ok).toBe(false);

    await store.close();
  });

  it("hard-fails the probe when the feed has no Monetary Policy items", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () =>
      new Response(
        '﻿[{"d":"1/1/2026 1:00:00 PM","t":"X","pt":"Enforcement Actions","l":"/newsevents/pressreleases/x.htm"}]',
        {
          status: 200,
        },
      )) as typeof fetch;

    const outcome = await federalreserveSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-press-feed");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");

    await store.close();
  });

  it("hard-fails the probe when the request errors", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("boom", { status: 400 })) as typeof fetch;

    const outcome = await federalreserveSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-press-feed");
    expect(probe?.ok).toBe(false);

    await store.close();
  });

  it("hard-fails the fingerprint check when item field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("federalreserve", "press.item-fields", "somethingelse");

    const outcome = await federalreserveSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");

    await store.close();
  });

  it("goes green on freshness once communications have been ingested", async () => {
    const { ctx, store } = await makeCtx();
    await federalreserveSource.sync(ctx);

    const outcome = await federalreserveSource.canary(ctx);
    const freshness = outcome.checks.find((c) => c.name === "freshness-fed-communications");
    expect(freshness?.ok).toBe(true);
    expect(freshness?.severity).toBe("soft");

    await store.close();
  });
});

describe("feed field helpers", () => {
  it("stripBom removes exactly one leading BOM", () => {
    expect(stripBom("﻿[]")).toBe("[]");
    expect(stripBom("[]")).toBe("[]");
  });

  it("fedDateToIso reads the DATE part of the US-Eastern timestamp verbatim", () => {
    expect(fedDateToIso("8/5/2026 4:05:00 PM")).toBe("2026-08-05");
    expect(fedDateToIso("12/31/2025 9:00:00 AM")).toBe("2025-12-31");
    expect(fedDateToIso("2/7/2026")).toBe("2026-02-07");
    expect(fedDateToIso("not a date")).toBeNull();
    expect(fedDateToIso("13/40/2026 1:00:00 PM")).toBeNull();
    expect(fedDateToIso(undefined)).toBeNull();
  });

  it("fedItemIdFromLink strips the /newsevents/ prefix and .htm suffix", () => {
    expect(fedItemIdFromLink("/newsevents/speech/cook20260805a.htm")).toBe("speech/cook20260805a");
    expect(fedItemIdFromLink("/newsevents/pressreleases/monetary20260825a.htm")).toBe(
      "pressreleases/monetary20260825a",
    );
    expect(
      fedItemIdFromLink("https://www.federalreserve.gov/newsevents/testimony/x20260101a.htm"),
    ).toBe("testimony/x20260101a");
    expect(fedItemIdFromLink("/other/page.htm")).toBe("other/page");
    expect(fedItemIdFromLink("")).toBeNull();
  });

  it("classifyMonetaryPolicyTitle maps FOMC minutes and statements, everything else pressRelease", () => {
    expect(
      classifyMonetaryPolicyTitle("Minutes of the Federal Open Market Committee, July 8-9, 2026"),
    ).toBe("minutes");
    expect(classifyMonetaryPolicyTitle("Federal Reserve issues FOMC statement")).toBe("statement");
    expect(classifyMonetaryPolicyTitle("Statement regarding the FOMC statement schedule")).toBe(
      "statement",
    );
    expect(
      classifyMonetaryPolicyTitle(
        "Minutes of the Board's discount rate meetings on July 20 and July 29, 2026",
      ),
    ).toBe("pressRelease");
    expect(classifyMonetaryPolicyTitle("Federal Reserve issues implementation note")).toBe(
      "pressRelease",
    );
  });
});
