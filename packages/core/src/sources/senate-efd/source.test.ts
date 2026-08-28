import { afterEach, describe, expect, it } from "vitest";
import { senateEfdSource } from "./source.js";
import {
  SENATE_EFD_BASE,
  SENATE_EFD_SEARCH_DATA,
  SENATE_EFD_SEARCH_HOME,
  senatePaperViewUrl,
  senatePtrViewUrl,
} from "./client.js";
import { setSenateEfdScanExtractor } from "./scan-extract.js";
import { LEGISLATORS_CURRENT_URL } from "../../resolve/members.js";
import { DATASETS } from "../../schema/datasets.js";
import type { CongressTrade } from "../../schema/congress-trade.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { makeCongressTrade, makeProvenance, readFixture } from "../../test-helpers.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked eFD: agreement handshake → search
 * grid (server-capped pages, so the paging loop is real) → web PTR pages,
 * member resolution against a mocked legislators file, a scanned paper
 * filing that must stay pending, and canary drift detection. Fully offline;
 * clock pinned. (The 302-redirect agreement variant is covered in
 * client.test.ts; here the mock agrees with a plain 200.)
 */

const CSRF = "fixture-csrf-token-0123456789abcdef";
const DOC_CLEAN = "3f9b1c2e-8a4d-4e5f-9b6a-7c8d9e0f1a2b"; // Whitehouse, filed 2026-08-12
const DOC_EDGE = "9d8c7b6a-5f4e-4d2c-8b0a-998877665544"; // Doe (unresolvable), filed 2026-08-13
const DOC_PAPER = "77aa88bb-99cc-4dde-8eff-001122334455"; // Example, paper scan, filed 2026-08-14

// Whitehouse sits in the senate; "Alexandra Doe" exists only as a house
// member, so senate-chamber resolution must leave her filings unmatched.
const LEGISLATORS = JSON.stringify([
  {
    id: { bioguide: "W000802" },
    name: { first: "Sheldon", last: "Whitehouse", official_full: "Sheldon Whitehouse" },
    terms: [{ type: "sen", party: "Democrat", state: "RI" }],
  },
  {
    id: { bioguide: "D000000" },
    name: { first: "Alexandra", last: "Doe" },
    terms: [{ type: "rep", party: "Independent", state: "VT" }],
  },
]);

interface RecordedRequest {
  url: string;
  method: string;
  body: string;
}

function mockEfdNetwork(options: { pageCap?: number } = {}): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const searchData = JSON.parse(readFixture("senate-efd", "search-data-page.json")) as {
    data: string[][];
    recordsTotal: number;
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, body });

    if (url === LEGISLATORS_CURRENT_URL) {
      return new Response(LEGISLATORS, { status: 200 });
    }
    if (url === SENATE_EFD_SEARCH_HOME && method === "GET") {
      const h = new Headers({ "content-type": "text/html" });
      h.append("set-cookie", `csrftoken=${CSRF}; Path=/; SameSite=Lax`);
      return new Response(readFixture("senate-efd", "search-home.html"), {
        status: 200,
        headers: h,
      });
    }
    if (url === SENATE_EFD_SEARCH_HOME && method === "POST") {
      const h = new Headers({ "content-type": "text/html" });
      h.append("set-cookie", "sessionid=fixture-session-id; Path=/; HttpOnly");
      return new Response(`<html>${SENATE_EFD_BASE}/search/</html>`, { status: 200, headers: h });
    }
    if (url === SENATE_EFD_SEARCH_DATA && method === "POST") {
      const form = new URLSearchParams(body);
      const start = Number(form.get("start") ?? "0");
      const length = Math.min(
        Number(form.get("length") ?? "25"),
        options.pageCap ?? Number.POSITIVE_INFINITY,
      );
      return new Response(
        JSON.stringify({
          data: searchData.data.slice(start, start + length),
          recordsTotal: searchData.recordsTotal,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === senatePtrViewUrl(DOC_CLEAN) && method === "GET") {
      return new Response(readFixture("senate-efd", "case-ptr-clean-multirow", "input.html"), {
        status: 200,
      });
    }
    if (url === senatePtrViewUrl(DOC_EDGE) && method === "GET") {
      return new Response(readFixture("senate-efd", "case-ptr-edge-ranges", "input.html"), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

async function makeCtx(options: { pageCap?: number } = {}): Promise<{
  ctx: SourceContext;
  store: TrackerStore;
  requests: RecordedRequest[];
}> {
  const store = await TrackerStore.open(":memory:");
  const { fetchImpl, requests } = mockEfdNetwork(options);
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl,
    // Pinned: backfill (3 days) reaches 2026-08-12, the oldest fixture filing.
    now: () => new Date("2026-08-15T12:00:00Z"),
  };
  return { ctx, store, requests };
}

async function allTrades(store: TrackerStore): Promise<CongressTrade[]> {
  const rows: CongressTrade[] = [];
  for await (const row of store.iterate(DATASETS["congress-trades"])) rows.push(row);
  return rows;
}

afterEach(() => setSenateEfdScanExtractor(null));

describe("senateEfdSource.sync", () => {
  it("pages the grid, ingests web PTRs, resolves members, keeps ranges, reports the scan, and re-runs idempotently", async () => {
    // Server caps grid pages at 2 rows, so ingesting all 3 filings proves paging.
    const { ctx, store, requests } = await makeCtx({ pageCap: 2 });

    const first = await senateEfdSource.sync(ctx);
    expect(first.implemented).toBe(true);
    expect(first.rowsUpserted).toBe(8);
    expect(first.perDataset["congress-trades"]).toBe(8);
    expect(first.parse).toEqual({ attempted: 2, succeeded: 2 });
    expect(first.notes).toContain("1 scanned filings pending (no scan extractor configured)");
    expect(await store.count("congress-trades")).toBe(8);
    const searchPosts = requests.filter((r) => r.url === SENATE_EFD_SEARCH_DATA);
    expect(searchPosts.length).toBe(2);

    const rows = await allTrades(store);
    const clean = rows.filter((r) => r.docId === DOC_CLEAN);
    const edge = rows.filter((r) => r.docId === DOC_EDGE);
    expect(clean).toHaveLength(3);
    expect(edge).toHaveLength(5);

    // Resolved member: bioguide, party, state filled from the member map.
    for (const row of clean) {
      expect(row.member).toEqual({
        name: "Sheldon Whitehouse",
        bioguideId: "W000802",
        party: "Democrat",
        state: "RI",
      });
    }
    // Unmatched in the senate (she is a house member): identity stays null.
    for (const row of edge) {
      expect(row.member).toEqual({
        name: "Alexandra Doe",
        bioguideId: null,
        party: null,
        state: null,
      });
    }
    // Provenance deep-links to the primary filing view.
    for (const row of rows) {
      expect(row.provenance.sourceUrl).toBe(senatePtrViewUrl(row.docId));
      expect(row.provenance.confidence).toBe(0.9);
    }
    // Ranges stay ranges, open tops and the sub-threshold bucket included.
    const overFifty = rows.find((r) => r.amountRange.text === "Over $50,000,000");
    expect(overFifty?.amountRange).toEqual({ min: 50000000, max: null, text: "Over $50,000,000" });
    const none = rows.find((r) => r.amountRange.text === "None (or less than $1,001)");
    expect(none?.amountRange).toEqual({ min: 0, max: 1000, text: "None (or less than $1,001)" });
    expect(rows.some((r) => r.side === "exchange")).toBe(true);

    // Watermark advanced to the max fully-processed filed date.
    expect(await store.getWatermark("senate-efd", "efd.lastFiledDate")).toBe("2026-08-14");

    // Re-running (now from the watermark minus the re-walk window) duplicates nothing.
    const second = await senateEfdSource.sync(ctx);
    expect(second.rowsUpserted).toBe(8);
    expect(await store.count("congress-trades")).toBe(8);
    expect(await store.getWatermark("senate-efd", "efd.lastFiledDate")).toBe("2026-08-14");

    await store.close();
  });

  it("honors --limit, stopping before incomplete filed dates reach the watermark", async () => {
    const { ctx, store } = await makeCtx();
    const result = await senateEfdSource.sync(ctx, { limit: 1 });
    expect(result.rowsUpserted).toBe(3);
    expect(result.notes).toContain("stopped at --limit 1");
    expect(await store.getWatermark("senate-efd", "efd.lastFiledDate")).toBe("2026-08-12");
    await store.close();
  });

  it("honors --since by pushing the exact date into the search filter", async () => {
    const { ctx, store, requests } = await makeCtx();
    await senateEfdSource.sync(ctx, { since: "2026-08-13" });
    const search = requests.find((r) => r.url === SENATE_EFD_SEARCH_DATA);
    expect(new URLSearchParams(search?.body).get("submitted_start_date")).toBe(
      "08/13/2026 00:00:00",
    );
    await store.close();
  });

  it("honors --full by ignoring the stored watermark and re-backfilling from today", async () => {
    const { ctx, store, requests } = await makeCtx();
    // First sync advances the watermark to 2026-08-14; its incremental re-walk
    // would otherwise start from 2026-08-07 (watermark minus 7 days).
    await senateEfdSource.sync(ctx);
    expect(await store.getWatermark("senate-efd", "efd.lastFiledDate")).toBe("2026-08-14");
    requests.length = 0;

    await senateEfdSource.sync(ctx, { full: true });
    const search = requests.find((r) => r.url === SENATE_EFD_SEARCH_DATA);
    // now (2026-08-15) minus the default 3-day backfill window, not the watermark re-walk.
    expect(new URLSearchParams(search?.body).get("submitted_start_date")).toBe(
      "08/12/2026 00:00:00",
    );
    await store.close();
  });

  it("respects the datasets filter without touching the network", async () => {
    const { ctx, store, requests } = await makeCtx();
    const result = await senateEfdSource.sync(ctx, { datasets: ["short-volume"] });
    expect(result.rowsUpserted).toBe(0);
    expect(requests).toHaveLength(0);
    await store.close();
  });

  it("routes scanned filings through a registered extractor and enforces its honesty contract", async () => {
    const { ctx, store } = await makeCtx();
    const seen: unknown[] = [];
    setSenateEfdScanExtractor({
      extract: async (input) => {
        seen.push(input);
        return [
          makeCongressTrade({
            id: `senate:${DOC_PAPER}:0`,
            docId: DOC_PAPER,
            member: { name: "Pat Example", bioguideId: null, party: null, state: null },
            filedAt: "2026-08-14",
            transactedAt: "2026-08-11",
            provenance: makeProvenance("senate-efd", {
              sourceUrl: senatePaperViewUrl(DOC_PAPER),
              parser: "test-scan@1",
              confidence: 0.7,
              needsReview: true,
            }),
          }),
        ];
      },
    });

    const result = await senateEfdSource.sync(ctx);
    expect(seen).toEqual([
      {
        docId: DOC_PAPER,
        url: senatePaperViewUrl(DOC_PAPER),
        memberName: "Pat Example",
        filedAt: "2026-08-14",
      },
    ]);
    expect(result.rowsUpserted).toBe(9);
    expect(result.parse).toEqual({ attempted: 3, succeeded: 3 });
    expect(result.notes.some((n) => n.includes("pending"))).toBe(false);
    const scanned = (await allTrades(store)).find((r) => r.docId === DOC_PAPER);
    expect(scanned?.provenance.confidence).toBe(0.7);
    expect(scanned?.provenance.needsReview).toBe(true);
    await store.close();
  });

  it("refuses extractor rows that break the confidence/needsReview contract", async () => {
    const { ctx, store } = await makeCtx();
    setSenateEfdScanExtractor({
      extract: async () => [
        makeCongressTrade({
          id: `senate:${DOC_PAPER}:0`,
          docId: DOC_PAPER,
          provenance: makeProvenance("senate-efd", {
            sourceUrl: senatePaperViewUrl(DOC_PAPER),
            parser: "test-scan@1",
            confidence: 0.9, // liar: scans are 0.7
            needsReview: true,
          }),
        }),
      ],
    });

    const result = await senateEfdSource.sync(ctx);
    // The two web PTRs land; the contract-breaking scan counts as a parse failure.
    expect(result.parse).toEqual({ attempted: 3, succeeded: 2 });
    expect(await store.count("congress-trades")).toBe(8);
    await store.close();
  });
});

describe("senateEfdSource.canary", () => {
  it("goes green: agreement+search probe, fingerprint baseline then match, fresh filings, healthy parse rate", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("senate-efd");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 8,
      parseAttempted: 2,
      parseSucceeded: 2,
    });

    const outcome = await senateEfdSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["agreement-and-search"]?.ok).toBe(true);
    expect(byName["agreement-and-search"]?.severity).toBe("hard");
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.note).toBe("baseline recorded");
    expect(byName["freshness-congress-trades"]?.ok).toBe(true);
    expect(byName["freshness-congress-trades"]?.severity).toBe("soft");
    expect(byName["parse-success-rate"]?.ok).toBe(true);

    // Second run compares against the recorded baseline and still matches.
    const again = await senateEfdSource.canary(ctx);
    const fingerprint = again.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(true);
    expect(fingerprint?.note).toBeUndefined();
    await store.close();
  });

  it("hard-fails the fingerprint check when the stored structure drifts", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("senate-efd", "efd.structure", "somethingelse");
    const outcome = await senateEfdSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe when the agreement flow breaks", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("gone", { status: 404 })) as typeof fetch;
    const outcome = await senateEfdSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "agreement-and-search");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the parse-success check when the last sync degraded", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("senate-efd");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 90,
      parseAttempted: 100,
      parseSucceeded: 90,
    });
    const outcome = await senateEfdSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(false);
    expect(rate?.severity).toBe("hard");
    await store.close();
  });
});
