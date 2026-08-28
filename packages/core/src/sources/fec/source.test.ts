import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fecCandidateMasterZipUrl,
  fecCommitteeMasterZipUrl,
  fecCurrentCycle,
  fecPas2ZipUrl,
  fecSource,
  fecWeballZipUrl,
} from "./source.js";
import { DATASETS } from "../../schema/datasets.js";
import type { FecCandidate } from "../../schema/fec-candidate.js";
import type { FecContribution } from "../../schema/fec-contribution.js";
import { AltDataStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { fixturePath, readFixtureJson } from "../../test-helpers.js";
import { runSync } from "../../sync/engine.js";
import { deriveCanaryStatus, type SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network serving the committed,
 * hand-built fixture ZIPs (see fixtures/fec/case-cycle-2026/README.md). The
 * mock behaves like the real static-file server: it recognizes the four
 * per-cycle bulk URLs and nothing else, and answers HEAD the same way a
 * plain static-file host would (an empty 200 body).
 */

const CYCLE = 2026;
const NOW = "2026-08-25T12:00:00.000Z";

function readZipFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath("fec", "case-cycle-2026", name)));
}

const ZIP_BYTES: Record<string, Uint8Array> = {
  [fecWeballZipUrl(CYCLE)]: readZipFixture("weball26.zip"),
  [fecPas2ZipUrl(CYCLE)]: readZipFixture("pas226.zip"),
  [fecCandidateMasterZipUrl(CYCLE)]: readZipFixture("cn26.zip"),
  [fecCommitteeMasterZipUrl(CYCLE)]: readZipFixture("cm26.zip"),
};

interface LoggedRequest {
  url: string;
  method: string;
}

function mockFetch(log: LoggedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    log.push({ url, method });
    if (method === "HEAD") {
      return url in ZIP_BYTES
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    }
    const bytes = ZIP_BYTES[url];
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{
  ctx: SourceContext;
  store: AltDataStore;
  log: LoggedRequest[];
}> {
  const store = await AltDataStore.open(":memory:");
  const log: LoggedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(log),
    now: () => new Date(NOW),
  };
  return { ctx, store, log };
}

describe("fecCurrentCycle", () => {
  it("maps an odd year to the next even cycle, and an even year to itself", () => {
    expect(fecCurrentCycle(new Date("2025-03-01T00:00:00Z"))).toBe(2026);
    expect(fecCurrentCycle(new Date("2026-03-01T00:00:00Z"))).toBe(2026);
    expect(fecCurrentCycle(new Date("2024-11-30T00:00:00Z"))).toBe(2024);
    expect(fecCurrentCycle(new Date("2027-01-01T00:00:00Z"))).toBe(2028);
  });
});

describe("fecSource.sync", () => {
  it("full sync matches the hand-verified goldens exactly, and records fingerprints + watermark", async () => {
    const { ctx, store, log } = await makeCtx();
    const result = await fecSource.sync(ctx);

    expect(result.parse).toEqual({ attempted: 16, succeeded: 13 });
    expect(result.rowsUpserted).toBe(13);
    expect(result.perDataset["fec-candidates"]).toBe(5);
    expect(result.perDataset["fec-contributions"]).toBe(8);
    expect(await store.count("fec-candidates")).toBe(5);
    expect(await store.count("fec-contributions")).toBe(8);

    const candidates: FecCandidate[] = [];
    for await (const row of store.iterate(DATASETS["fec-candidates"])) candidates.push(row);
    expect(candidates).toEqual(
      readFixtureJson<FecCandidate[]>("fec", "case-cycle-2026", "expected-candidates.json"),
    );

    const contributions: FecContribution[] = [];
    for await (const row of store.iterate(DATASETS["fec-contributions"])) contributions.push(row);
    expect(contributions).toEqual(
      readFixtureJson<FecContribution[]>("fec", "case-cycle-2026", "expected-contributions.json"),
    );

    // Fingerprints are the pipe count of each file's first line (30/22/15/15 columns → 29/21/14/14 pipes).
    expect(await store.getFingerprint("fec", "fec.weball.columns")).toBe("29");
    expect(await store.getFingerprint("fec", "fec.pas2.columns")).toBe("21");
    expect(await store.getFingerprint("fec", "fec.cn.columns")).toBe("14");
    expect(await store.getFingerprint("fec", "fec.cm.columns")).toBe("14");

    expect(await store.getWatermark("fec", "fec.2026.lastFetchedAt")).toBe(NOW);

    // One fetch per zip, in weball → cn → cm → pas2 order.
    expect(log.filter((r) => r.method === "GET").map((r) => r.url)).toEqual([
      fecWeballZipUrl(CYCLE),
      fecCandidateMasterZipUrl(CYCLE),
      fecCommitteeMasterZipUrl(CYCLE),
      fecPas2ZipUrl(CYCLE),
    ]);

    await store.close();
  });

  it("--full bypasses the freshness throttle and stays idempotent (no duplicate rows)", async () => {
    const { ctx, store } = await makeCtx();
    await fecSource.sync(ctx);
    expect(await store.count("fec-candidates")).toBe(5);
    expect(await store.count("fec-contributions")).toBe(8);

    const second = await fecSource.sync(ctx, { full: true });
    expect(second.rowsUpserted).toBe(13);
    expect(await store.count("fec-candidates")).toBe(5);
    expect(await store.count("fec-contributions")).toBe(8);

    await store.close();
  });

  it("skips a second sync inside the 20h freshness window with no override, making zero network calls", async () => {
    const { ctx, store, log } = await makeCtx();
    await fecSource.sync(ctx);
    log.length = 0;

    const second = await fecSource.sync(ctx);
    expect(second.rowsUpserted).toBe(0);
    expect(second.notes.join(" ")).toContain("skipped");
    expect(log).toHaveLength(0);
    expect(await store.count("fec-candidates")).toBe(5);

    await store.close();
  });

  it("--since also forces a refetch (its value isn't a date boundary for this source)", async () => {
    const { ctx, store } = await makeCtx();
    await fecSource.sync(ctx);
    const second = await fecSource.sync(ctx, { since: "2020-01-01" });
    expect(second.rowsUpserted).toBe(13);
    await store.close();
  });

  it("--limit caps parsed rows per file independently, and never advances the watermark", async () => {
    const { ctx, store } = await makeCtx();
    const result = await fecSource.sync(ctx, { limit: 3 });

    // The first 3 rows of both fixture files are all valid.
    expect(result.parse).toEqual({ attempted: 6, succeeded: 6 });
    expect(result.perDataset["fec-candidates"]).toBe(3);
    expect(result.perDataset["fec-contributions"]).toBe(3);
    expect(result.notes.some((n) => n.includes("--limit") && n.includes("weball"))).toBe(true);
    expect(result.notes.some((n) => n.includes("--limit") && n.includes("itpas2"))).toBe(true);
    expect(await store.getWatermark("fec", "fec.2026.lastFetchedAt")).toBeNull();

    await store.close();
  });

  it("datasets filter: fec-candidates only fetches weball, never touches masters or pas2", async () => {
    const { ctx, store, log } = await makeCtx();
    const result = await fecSource.sync(ctx, { datasets: ["fec-candidates"] });

    expect(result.perDataset["fec-candidates"]).toBe(5);
    expect(result.perDataset["fec-contributions"]).toBeUndefined();
    expect(await store.count("fec-candidates")).toBe(5);
    expect(await store.count("fec-contributions")).toBe(0);
    expect(log.filter((r) => r.method === "GET").map((r) => r.url)).toEqual([
      fecWeballZipUrl(CYCLE),
    ]);

    await store.close();
  });

  it("datasets filter: fec-contributions fetches the masters + pas2, never touches weball", async () => {
    const { ctx, store, log } = await makeCtx();
    const result = await fecSource.sync(ctx, { datasets: ["fec-contributions"] });

    expect(result.perDataset["fec-candidates"]).toBeUndefined();
    expect(result.perDataset["fec-contributions"]).toBe(8);
    expect(await store.count("fec-candidates")).toBe(0);
    expect(await store.count("fec-contributions")).toBe(8);
    expect(log.filter((r) => r.method === "GET").map((r) => r.url)).toEqual([
      fecCandidateMasterZipUrl(CYCLE),
      fecCommitteeMasterZipUrl(CYCLE),
      fecPas2ZipUrl(CYCLE),
    ]);

    await store.close();
  });

  it("an unrelated datasets filter is a pure no-op — no network calls, no rows", async () => {
    const { ctx, store, log } = await makeCtx();
    const result = await fecSource.sync(ctx, { datasets: ["cot-reports"] });
    expect(result.rowsUpserted).toBe(0);
    expect(log).toHaveLength(0);
    await store.close();
  });
});

describe("fecSource.canary", () => {
  it("reports every check from a real sync: fetch/fingerprints/freshness pass; parse-success-rate reflects the true rate", async () => {
    const { ctx, store } = await makeCtx();
    await runSync(ctx, { sources: ["fec"] }); // records the sync run for the parse-rate check

    const outcome = await fecSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fetch-weball"]?.ok).toBe(true);
    expect(byName["fetch-weball"]?.note).toBeUndefined();
    expect(byName["fingerprint-weball"]?.ok).toBe(true);
    expect(byName["fingerprint-pas2"]?.ok).toBe(true);
    expect(byName["freshness-fec-candidates"]?.ok).toBe(true);
    expect(byName["freshness-fec-contributions"]?.ok).toBe(true);

    // This fixture deliberately packs in 3 malformed rows (for the
    // parse-failure-accounting coverage above) out of 16 attempted, so the
    // *true* aggregate rate (13/16 ≈ 81%) is well under the 99% bar — this
    // is the canary correctly reading real numbers, not a fixture bug.
    expect(byName["parse-success-rate"]?.ok).toBe(false);
    expect(byName["parse-success-rate"]?.note).toBe("81.25% over 16 rows");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");

    await store.close();
  });

  it("goes green on parse-success-rate specifically when the last sync's rate clears the bar", async () => {
    const { ctx, store } = await makeCtx();
    // Seeds the sync-run bookkeeping directly (rather than a real sync) so
    // this check can be exercised in isolation from this fixture's
    // deliberately-imperfect real rate.
    const runId = await store.startSyncRun("fec");
    await store.finishSyncRun(runId, {
      ok: true,
      rowsUpserted: 100,
      parseAttempted: 100,
      parseSucceeded: 100,
    });

    const outcome = await fecSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "parse-success-rate");
    expect(check?.ok).toBe(true);

    await store.close();
  });

  it("soft-fails fingerprint-pas2 before any sync has recorded a baseline (fresh store = amber, not red)", async () => {
    const { ctx, store } = await makeCtx();
    const outcome = await fecSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "fingerprint-pas2");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("soft");
    await store.close();
  });

  it("hard-fails fingerprint-weball when the live column count no longer matches the stored baseline", async () => {
    const { ctx, store } = await makeCtx();
    await store.setFingerprint("fec", "fec.weball.columns", "999");
    const outcome = await fecSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "fingerprint-weball");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("hard");
    await store.close();
  });

  it("records a baseline fingerprint on the first canary run when none exists yet", async () => {
    const { ctx, store } = await makeCtx();
    expect(await store.getFingerprint("fec", "fec.weball.columns")).toBeNull();
    const outcome = await fecSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "fingerprint-weball");
    expect(check?.ok).toBe(true);
    expect(check?.note).toBe("baseline recorded");
    expect(await store.getFingerprint("fec", "fec.weball.columns")).toBe("29");
    await store.close();
  });

  it("falls back to a full GET (and still succeeds) when HEAD isn't supported, and notes it", async () => {
    const { ctx, store } = await makeCtx();
    const baseFetch = ctx.fetchImpl as typeof fetch;
    ctx.fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      return baseFetch(input, init);
    }) as typeof fetch;

    const outcome = await fecSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "fetch-weball");
    expect(check?.ok).toBe(true);
    expect(check?.note).toMatch(/HEAD/);

    await store.close();
  });

  it("hard-fails fetch-weball (and so fingerprint-weball is never reached) when the server rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;

    const outcome = await fecSource.canary(ctx);
    const fetchCheck = outcome.checks.find((c) => c.name === "fetch-weball");
    expect(fetchCheck?.ok).toBe(false);
    expect(fetchCheck?.severity).toBe("hard");
    expect(outcome.checks.some((c) => c.name === "fingerprint-weball")).toBe(false);

    await store.close();
  });

  it("soft-fails freshness when a dataset has never been ingested", async () => {
    const { ctx, store } = await makeCtx();
    const outcome = await fecSource.canary(ctx);
    const candidatesFreshness = outcome.checks.find((c) => c.name === "freshness-fec-candidates");
    expect(candidatesFreshness?.ok).toBe(false);
    expect(candidatesFreshness?.severity).toBe("soft");
    await store.close();
  });
});
