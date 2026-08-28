import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  patentsviewSource,
  normalizePatentRow,
  OdpProductDriftError,
  ODP_PRODUCT_URL,
} from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { Patent } from "../../schema/patent.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { fixturePath, makeTmpDir, readFixture, readFixtureJson } from "../../test-helpers.js";
import { deriveCanaryStatus, type SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: one ODP quarterly release —
 * product metadata naming the three table zips (among decoy entries), the
 * zips themselves served as fixture bytes, streamed through the real
 * unzip/TSV/join/upsert pipeline into an in-memory store. The sync must
 * emit rows identical to the hand-verified golden file, watermark the
 * release stamp, no-op on an unchanged release, and stay loud on drift.
 */

const NOW = "2026-08-20T12:00:00.000Z";
const RELEASE = "2026-07-15 09:37:53";
const WATERMARK_KEY = "patentsview.odpRelease";
const FINGERPRINT_KEY = "patentsview.odp-file-entry-fields";
const FILES_BASE = "https://api.uspto.gov/api/v1/datasets/products/files/PVGPATDIS";

const CASE = ["patentsview", "case-odp-quarterly-2026"] as const;
const metadataJson = readFixture(...CASE, "product-metadata.json");
const fixtureZips: Record<string, Uint8Array> = Object.fromEntries(
  ["g_patent.tsv.zip", "g_assignee_disambiguated.tsv.zip", "g_cpc_current.tsv.zip"].map((name) => [
    name,
    new Uint8Array(readFileSync(fixturePath(...CASE, name))),
  ]),
);

// The source downloads into os.tmpdir(); point it at a package-local dir so
// sandboxed test environments allow the writes (see test-helpers.makeTmpDir).
const tmp = makeTmpDir("patentsview-odp");
const originalTmpdir = process.env.TMPDIR;
beforeAll(() => {
  process.env.TMPDIR = tmp.dir;
});
afterAll(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  tmp.cleanup();
});

interface CapturedRequest {
  url: string;
  apiKey: string | null;
}

interface MockOverrides {
  /** Replaces the product-metadata response body (JSON string). */
  metadataBody?: string;
  /** Non-200 status for the metadata endpoint (body from metadataBody). */
  metadataStatus?: number;
  /** Replaces the served zip bytes, keyed by file name. */
  files?: Record<string, Uint8Array>;
}

function mockFetch(captured: CapturedRequest[], overrides: MockOverrides = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({ url, apiKey: headers["x-api-key"] ?? null });

    if (url === ODP_PRODUCT_URL) {
      if (overrides.metadataStatus && overrides.metadataStatus !== 200) {
        return new Response(overrides.metadataBody ?? "", { status: overrides.metadataStatus });
      }
      return new Response(overrides.metadataBody ?? metadataJson, { status: 200 });
    }
    if (url.startsWith(`${FILES_BASE}/`)) {
      const fileName = url.slice(FILES_BASE.length + 1);
      const zip = (overrides.files ?? fixtureZips)[fileName];
      if (zip) return new Response(new Uint8Array(zip), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  mock: MockOverrides = {},
): Promise<{ ctx: SourceContext; store: TrackerStore; captured: CapturedRequest[] }> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig(
      { logLevel: "silent", patentsviewApiKey: "test-key-123", ...overrides },
      { cwd: "/nonexistent", env: {} },
    ),
    logger: silentLogger,
    fetchImpl: mockFetch(captured, mock),
    now: () => new Date(NOW),
  };
  return { ctx, store, captured };
}

async function makeCtxNoKey(): Promise<{
  ctx: SourceContext;
  store: TrackerStore;
  captured: CapturedRequest[];
}> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(NOW),
  };
  return { ctx, store, captured };
}

/** Minimal in-test release: metadata + three fflate-built table zips. */
function inlineRelease(tables: { patent: string; assignee: string; cpc: string }): MockOverrides {
  const fileNames = [
    "g_patent.tsv.zip",
    "g_assignee_disambiguated.tsv.zip",
    "g_cpc_current.tsv.zip",
  ];
  return {
    metadataBody: JSON.stringify({
      count: 1,
      bulkDataProductBag: [
        {
          productIdentifier: "PVGPATDIS",
          lastModifiedDateTime: "2026-08-01 00:00:00",
          productFileBag: {
            count: fileNames.length,
            fileDataBag: fileNames.map((fileName) => ({
              fileName,
              fileDownloadURI: `${FILES_BASE}/${fileName}`,
            })),
          },
        },
      ],
    }),
    files: {
      "g_patent.tsv.zip": zipSync({ "g_patent.tsv": strToU8(tables.patent) }),
      "g_assignee_disambiguated.tsv.zip": zipSync({
        "g_assignee_disambiguated.tsv": strToU8(tables.assignee),
      }),
      "g_cpc_current.tsv.zip": zipSync({ "g_cpc_current.tsv": strToU8(tables.cpc) }),
    },
  };
}

describe("patentsviewSource.sync", () => {
  it("downloads one release, joins the three tables, emits the golden rows, and no-ops on the unchanged release", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await patentsviewSource.sync(ctx);
    expect(first.rowsUpserted).toBe(5);
    expect(first.perDataset.patents).toBe(5);
    // 7 g_patent rows: 5 emitted, 1 withdrawn (parses, skipped), 1 bad date.
    expect(first.parse).toEqual({ attempted: 7, succeeded: 6 });
    expect(first.notes).toContain("skipped 1 withdrawn patent(s)");
    expect(first.notes).toContain("g_assignee_disambiguated.tsv: 1 unusable row(s) skipped");
    expect(await store.count("patents")).toBe(5);

    // One metadata request plus exactly the three table zips — the decoy
    // bag entries (pdf, clustering) are never downloaded; the key rides
    // every request.
    expect(captured.map((r) => r.url)).toEqual([
      ODP_PRODUCT_URL,
      `${FILES_BASE}/g_patent.tsv.zip`,
      `${FILES_BASE}/g_assignee_disambiguated.tsv.zip`,
      `${FILES_BASE}/g_cpc_current.tsv.zip`,
    ]);
    for (const request of captured) expect(request.apiKey).toBe("test-key-123");

    // Stored rows match the hand-verified golden file exactly (id order).
    const rows: Patent[] = [];
    for await (const row of store.iterate(DATASETS.patents)) rows.push(row);
    expect(rows).toEqual(readFixtureJson<Patent[]>(...CASE, "expected.json"));

    // Watermark carries the release stamp; the file-entry fingerprint is recorded.
    expect(await store.getWatermark("patentsview", WATERMARK_KEY)).toBe(RELEASE);
    expect(await store.getFingerprint("patentsview", FINGERPRINT_KEY)).toBeTruthy();

    // Re-running against the same release is a metadata-only no-op.
    const second = await patentsviewSource.sync(ctx);
    expect(second.rowsUpserted).toBe(0);
    expect(second.notes.join(" ")).toContain(`release ${RELEASE} already ingested`);
    expect(captured).toHaveLength(5);
    expect(await store.count("patents")).toBe(5);

    await store.close();
  });

  it("--full re-walks the release past the watermark, idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();
    await patentsviewSource.sync(ctx);

    const again = await patentsviewSource.sync(ctx, { full: true });
    expect(again.rowsUpserted).toBe(5);
    expect(await store.count("patents")).toBe(5); // upserts, never duplicates
    expect(captured).toHaveLength(8); // 4 requests per walk
    await store.close();
  });

  it("--limit caps patents upserted and leaves the watermark untouched", async () => {
    const { ctx, store } = await makeCtx();
    const result = await patentsviewSource.sync(ctx, { limit: 2 });
    expect(result.rowsUpserted).toBe(2);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(await store.count("patents")).toBe(2);
    // A partial ingest must never mask the rest of the release: with no
    // watermark recorded, the next plain sync ingests the whole thing.
    expect(await store.getWatermark("patentsview", WATERMARK_KEY)).toBeNull();
    const resumed = await patentsviewSource.sync(ctx);
    expect(await store.count("patents")).toBe(5);
    expect(resumed.rowsUpserted).toBe(5); // upserts: the 2 limited rows refresh, never duplicate
    expect(await store.getWatermark("patentsview", WATERMARK_KEY)).toBe(RELEASE);
    await store.close();
  });

  it("skips politely with a note when no key is configured — never a crash", async () => {
    const { ctx, store, captured } = await makeCtxNoKey();
    const result = await patentsviewSource.sync(ctx);
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes.join(" ")).toMatch(/no USPTO Open Data Portal API key configured/);
    expect(result.notes.join(" ")).toMatch(/MARKET_TRACKERS_PATENTSVIEW_KEY/);
    expect(captured).toHaveLength(0);
    await store.close();
  });

  it("fails loudly with operator guidance when the key is rejected (401)", async () => {
    const { ctx, store } = await makeCtx(
      {},
      { metadataStatus: 401, metadataBody: readFixture(...CASE, "error-401.json") },
    );
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/rejected the configured API key/);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/data\.uspto\.gov/);
    await store.close();
  });

  it("drift: a 200 product whose file bag yields no usable entries fails the sync loudly", async () => {
    const { ctx, store } = await makeCtx(
      {},
      { metadataBody: readFixture(...CASE, "product-metadata-drift.json") },
    );
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(OdpProductDriftError);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/none survived field extraction/);
    expect(await store.count("patents")).toBe(0);
    await store.close();
  });

  it("drift: a product bag missing a required table zip fails loudly before any download", async () => {
    const body = JSON.parse(metadataJson) as {
      bulkDataProductBag: { productFileBag: { fileDataBag: { fileName?: string }[] } }[];
    };
    const bag = body.bulkDataProductBag[0]?.productFileBag;
    if (!bag) throw new Error("fixture shape changed");
    bag.fileDataBag = bag.fileDataBag.filter((f) => f.fileName !== "g_cpc_current.tsv.zip");

    const { ctx, store, captured } = await makeCtx({}, { metadataBody: JSON.stringify(body) });
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(OdpProductDriftError);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/g_cpc_current\.tsv\.zip/);
    // Selection precedes downloads: two attempts, two metadata requests, zero zips.
    expect(captured.filter((r) => r.url !== ODP_PRODUCT_URL)).toHaveLength(0);
    await store.close();
  });

  it("drift: a vanished product id (404) fails loudly", async () => {
    const { ctx, store } = await makeCtx(
      {},
      { metadataStatus: 404, metadataBody: readFixture(...CASE, "error-404.json") },
    );
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(OdpProductDriftError);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/not found \(404\)/);
    await store.close();
  });

  it("drift: a table header missing a required column fails loudly", async () => {
    // grant date renamed out from under the parser — silently blanking a
    // field on every row is exactly what must NOT happen.
    const mock = inlineRelease({
      patent:
        "patent_id\tpatent_type\tgrant_date\tpatent_title\twipo_kind\tnum_claims\twithdrawn\n" +
        "1\tutility\t2026-08-01\tX\tB2\t1\t0\n",
      assignee:
        "patent_id\tassignee_sequence\tdisambig_assignee_organization\tdisambig_assignee_individual_name_first\tdisambig_assignee_individual_name_last\tassignee_type\n",
      cpc: "patent_id\tcpc_sequence\tcpc_section\tcpc_class\tcpc_subclass\tcpc_group\n",
    });
    const { ctx, store } = await makeCtx({}, mock);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(OdpProductDriftError);
    await expect(patentsviewSource.sync(ctx)).rejects.toThrow(/patent_date/);
    await store.close();
  });

  it("downgrades transient metadata HTTP trouble to a note, keeping the run alive", async () => {
    const { ctx, store } = await makeCtx({}, { metadataStatus: 400, metadataBody: "bad request" });
    const result = await patentsviewSource.sync(ctx);
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes.join(" ")).toContain("HTTP 400");
    expect(await store.getWatermark("patentsview", WATERMARK_KEY)).toBeNull();
    await store.close();
  });

  it("respects the datasets filter without touching the network", async () => {
    const { ctx, store, captured } = await makeCtxNoKey();
    const result = await patentsviewSource.sync(ctx, { datasets: ["gov-contracts"] });
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes).toHaveLength(0);
    expect(captured).toHaveLength(0);
    await store.close();
  });

  it("notes that since/until are ignored, then ingests the whole release anyway", async () => {
    const { ctx, store } = await makeCtx();
    const result = await patentsviewSource.sync(ctx, { since: "2026-01-01", until: "2026-06-30" });
    expect(result.notes.join(" ")).toMatch(/since\/until ignored/);
    expect(result.rowsUpserted).toBe(5);
    await store.close();
  });

  it("resolves an assignee through the SEC-name fallback, seeded in cik_tickers before the sync runs", async () => {
    const mock = inlineRelease({
      patent:
        "patent_id\tpatent_type\tpatent_date\tpatent_title\twipo_kind\tnum_claims\twithdrawn\n" +
        "99000001\tutility\t2026-08-01\tSEC-fallback probe patent\tB2\t5\t0\n",
      assignee:
        "patent_id\tassignee_sequence\tdisambig_assignee_organization\tdisambig_assignee_individual_name_first\tdisambig_assignee_individual_name_last\tassignee_type\n" +
        "99000001\t0\tTORCHLIGHT ROBOTICS CORP\t\t\t2\n",
      cpc: "patent_id\tcpc_sequence\tcpc_section\tcpc_class\tcpc_subclass\tcpc_group\n",
    });
    const { ctx, store } = await makeCtx({}, mock);
    // A name the curated map has no entry for at all — only the SEC tier,
    // seeded directly into this store, can resolve it.
    await store.replaceCikTickers([
      { cik: "0000000321", ticker: "TRFC", name: "Torchlight Robotics Corp" },
    ]);

    const result = await patentsviewSource.sync(ctx);
    expect(result.rowsUpserted).toBe(1);
    const rows: Patent[] = [];
    for await (const row of store.iterate(DATASETS.patents)) rows.push(row);
    expect(rows[0]?.assignee).toEqual({ name: "TORCHLIGHT ROBOTICS CORP", tickers: ["TRFC"] });
    await store.close();
  });
});

describe("patentsviewSource.canary", () => {
  it("goes green when the product probe fetches, names g_patent, and data is fresh", async () => {
    const { ctx, store } = await makeCtx();
    await patentsviewSource.sync(ctx);

    const outcome = await patentsviewSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-product"]?.ok).toBe(true);
    expect(byName["probe-product"]?.note).toContain(`release ${RELEASE}`);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["freshness-patents"]?.ok).toBe(true);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("green");
    await store.close();
  });

  it("soft-skips the probe when no key is configured, without turning the source red", async () => {
    const { ctx, store } = await makeCtxNoKey();
    const outcome = await patentsviewSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-product");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("soft");
    expect(probe?.note).toMatch(/no USPTO Open Data Portal API key configured/);
    // No hard check ran or failed: the source goes amber (missing config), never red.
    expect(outcome.checks.some((c) => c.severity === "hard")).toBe(false);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("amber");
    await store.close();
  });

  it("hard-fails the fingerprint check when file-entry field names drift", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("patentsview", FINGERPRINT_KEY, "somethingelse");
    const outcome = await patentsviewSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });

  it("hard-fails the probe when the product id 404s", async () => {
    const { ctx, store } = await makeCtx(
      {},
      { metadataStatus: 404, metadataBody: readFixture(...CASE, "error-404.json") },
    );
    const outcome = await patentsviewSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-product");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });

  it("hard-fails the probe when the bag no longer names a g_patent table", async () => {
    const { ctx, store } = await makeCtx(
      {},
      {
        metadataBody: JSON.stringify({
          count: 1,
          bulkDataProductBag: [
            {
              productIdentifier: "PVGPATDIS",
              lastModifiedDateTime: RELEASE,
              productFileBag: {
                count: 1,
                fileDataBag: [
                  {
                    fileName: "PV_grant_data_dictionary.pdf",
                    fileDownloadURI: `${FILES_BASE}/PV_grant_data_dictionary.pdf`,
                  },
                ],
              },
            },
          ],
        }),
      },
    );
    const outcome = await patentsviewSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-product");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    expect(probe?.note).toMatch(/no 'g_patent\.tsv\.zip'/);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });

  it("hard-fails parse-success-rate off the last recorded sync run's stats", async () => {
    const { ctx, store } = await makeCtx();
    const runId = await store.startSyncRun("patentsview");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 90,
      parseAttempted: 100,
      parseSucceeded: 90,
    });
    const outcome = await patentsviewSource.canary(ctx);
    const rate = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(rate?.ok).toBe(false);
    expect(rate?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");
    await store.close();
  });
});

describe("normalizePatentRow", () => {
  const RETRIEVED_AT = "2026-08-20T12:00:00.000Z";
  let store: TrackerStore;

  beforeAll(async () => {
    store = await TrackerStore.open(":memory:");
  });

  afterAll(async () => {
    await store.close();
  });

  it("keeps assignee.name null and tickers empty for an unassigned patent", async () => {
    const patent = await normalizePatentRow(
      { patentId: "1", grantDate: "2026-08-11", title: "Example", wipoKind: "" },
      { orgName: null, assigneeCount: 0, cpcClass: null },
      RETRIEVED_AT,
      store,
    );
    expect(patent.assignee).toEqual({ name: null, tickers: [] });
    expect(patent.assigneeCount).toBe(0);
    expect(patent.kind).toBeNull();
    expect(patent.cpcClass).toBeNull();
  });

  it("uppercases the joined CPC class and resolves curated-map tickers", async () => {
    const patent = await normalizePatentRow(
      { patentId: "2", grantDate: "2026-08-11", title: "Example", wipoKind: "B2" },
      { orgName: "Boeing", assigneeCount: 2, cpcClass: "g06" },
      RETRIEVED_AT,
      store,
    );
    expect(patent.cpcClass).toBe("G06");
    expect(patent.assignee).toEqual({ name: "Boeing", tickers: ["BA"] });
    expect(patent.assigneeCount).toBe(2);
  });

  it("builds provenance from the ODP patent page URL, with confidence 1", async () => {
    const patent = await normalizePatentRow(
      { patentId: "11900001", grantDate: "2026-05-12", title: "Example", wipoKind: "B2" },
      { orgName: null, assigneeCount: 0, cpcClass: null },
      RETRIEVED_AT,
      store,
    );
    expect(patent.provenance).toEqual({
      source: "patentsview",
      sourceUrl: "https://data.uspto.gov/patents/11900001",
      retrievedAt: RETRIEVED_AT,
      parser: "patentsview-odp@1",
      confidence: 1,
      needsReview: false,
    });
  });

  it("throws on a missing title or an unparseable grant date", async () => {
    const joined = { orgName: null, assigneeCount: 0, cpcClass: null };
    await expect(
      normalizePatentRow(
        { patentId: "5", grantDate: "2026-08-11", title: "  ", wipoKind: "" },
        joined,
        RETRIEVED_AT,
        store,
      ),
    ).rejects.toThrow(/missing title/);
    await expect(
      normalizePatentRow(
        { patentId: "6", grantDate: "not-a-date", title: "Example", wipoKind: "" },
        joined,
        RETRIEVED_AT,
        store,
      ),
    ).rejects.toThrow(/unparseable patent_date/);
  });

  it("reuses memoized ticker resolutions per organization name", async () => {
    const memo = new Map<string, string[]>();
    memo.set("Preresolved Org", ["ZZZZ"]);
    const patent = await normalizePatentRow(
      { patentId: "7", grantDate: "2026-08-11", title: "Example", wipoKind: "" },
      { orgName: "Preresolved Org", assigneeCount: 1, cpcClass: null },
      RETRIEVED_AT,
      store,
      memo,
    );
    expect(patent.assignee.tickers).toEqual(["ZZZZ"]);
  });
});
