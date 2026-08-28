import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  houseClerkDeps,
  houseClerkSource,
  houseClerkYearIndexUrl,
  housePtrPdfUrl,
} from "./source.js";
import { extractPositionedText } from "./pdf-text.js";
import type { PositionedTextItem } from "./pdf-text.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import { LEGISLATORS_CURRENT_URL } from "../../resolve/members.js";
import { DATASETS } from "../../schema/datasets.js";
import { deriveCanaryStatus, type SourceContext } from "../types.js";
import { runSync } from "../../sync/engine.js";
import type { CongressTrade } from "../../schema/congress-trade.js";

/**
 * End-to-end source test, fully offline: the mocked network serves the
 * legislators map, the 2026 index ZIP (built in-test with fflate from the
 * XML fixture, so the unzip path is exercised), and PDF bytes for the one
 * electronic filing; the PDF-bytes → text step is stubbed at the
 * houseClerkDeps seam with the positioned-items fixture. The paper-style
 * PTR's PDF 404s, like it does live under ptr-pdfs.
 */

const INDEX_URL = houseClerkYearIndexUrl(2026);
const CLEAN_PDF_URL = housePtrPdfUrl(2026, "20031234");
const INDEX_ETAG = 'W/"idx-1"';
const INDEX_LAST_MODIFIED = "Tue, 18 Aug 2026 20:00:00 GMT";

const cleanPtrItems = readFixtureJson<PositionedTextItem[]>(
  "house-clerk",
  "case-ptr-clean-single-page",
  "input.json",
);

afterEach(() => {
  houseClerkDeps.extractPositionedText = extractPositionedText;
});

function stubExtraction(items: PositionedTextItem[]): void {
  houseClerkDeps.extractPositionedText = async () => items;
}

function mockFetch(counters: { index: number; pdf: number }): typeof fetch {
  const zipBytes = zipSync({
    "2026FD.xml": strToU8(readFixture("house-clerk", "case-index-2026", "input.xml")),
    "2026FD.txt": strToU8("tab-delimited variant, ignored"),
  });
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    if (target === LEGISLATORS_CURRENT_URL) {
      return new Response(readFixture("house-clerk", "legislators-current.json"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target === INDEX_URL) {
      counters.index += 1;
      const headers = new Headers(init?.headers);
      if (headers.get("if-none-match") === INDEX_ETAG) {
        return new Response(null, { status: 304 });
      }
      return new Response(zipBytes, {
        status: 200,
        headers: { etag: INDEX_ETAG, "last-modified": INDEX_LAST_MODIFIED },
      });
    }
    if (target === CLEAN_PDF_URL) {
      counters.pdf += 1;
      return new Response(strToU8("%PDF-1.7 synthetic bytes; extraction is stubbed"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(): Promise<{
  ctx: SourceContext;
  store: TrackerStore;
  counters: { index: number; pdf: number };
}> {
  const store = await TrackerStore.open(":memory:");
  const counters = { index: 0, pdf: 0 };
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(counters),
    // The day after the newest filing: both PTRs are inside the 3-day backfill.
    now: () => new Date("2026-08-19T12:00:00Z"),
  };
  return { ctx, store, counters };
}

describe("houseClerkSource.sync", () => {
  it("ingests PTR rows with resolved members, provenance deep links, watermark, and fingerprints", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction(cleanPtrItems);

    const result = await houseClerkSource.sync(ctx);
    expect(result.implemented).toBe(true);
    expect(result.rowsUpserted).toBe(3);
    expect(result.perDataset["congress-trades"]).toBe(3);
    expect(result.parse).toEqual({ attempted: 3, succeeded: 3 });
    expect(await store.count("congress-trades")).toBe(3);

    // The paper-style filing whose PDF is absent is skipped with a note.
    expect(result.notes.some((n) => n.includes("8221100"))).toBe(true);

    const rows: CongressTrade[] = [];
    for await (const row of store.iterate(DATASETS["congress-trades"])) rows.push(row);
    expect(rows.map((r) => r.id).sort()).toEqual([
      "house:20031234:0",
      "house:20031234:1",
      "house:20031234:2",
    ]);
    for (const row of rows) {
      expect(row.member.bioguideId).toBe("K000715");
      expect(row.member.name).toBe("Hon. Robert Kestrel");
      expect(row.chamber).toBe("house");
      expect(row.filedAt).toBe("2026-08-18");
      expect(row.provenance.sourceUrl).toBe(CLEAN_PDF_URL);
      expect(row.provenance.parser).toBe("house-ptr-pdf@1");
      expect(row.provenance.confidence).toBe(0.9);
    }

    expect(await store.getWatermark("house-clerk", "clerk.lastFiledDate")).toBe("2026-08-18");
    expect(await store.getFingerprint("house-clerk", "clerk.index-fields")).toBeTruthy();
    expect(await store.getFingerprint("house-clerk", "clerk.ptr-header")).toBeTruthy();
    expect((await store.getFetchCache(INDEX_URL))?.etag).toBe(INDEX_ETAG);

    await store.close();
  });

  it("304-skips an unchanged index, and a --full re-walk upserts without duplicating", async () => {
    const { ctx, store, counters } = await makeCtx();
    stubExtraction(cleanPtrItems);

    await houseClerkSource.sync(ctx);
    expect(counters.pdf).toBe(1);

    const second = await houseClerkSource.sync(ctx);
    expect(second.rowsUpserted).toBe(0);
    expect(second.notes.some((n) => n.includes("unchanged"))).toBe(true);
    expect(counters.pdf).toBe(1); // no PDFs re-fetched behind a 304
    expect(await store.count("congress-trades")).toBe(3);

    const full = await houseClerkSource.sync(ctx, { full: true });
    expect(full.rowsUpserted).toBe(3); // idempotent upsert by natural key
    expect(counters.pdf).toBe(2);
    expect(await store.count("congress-trades")).toBe(3);

    await store.close();
  });

  it("respects the datasets filter and --limit without advancing the watermark", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction(cleanPtrItems);

    const filtered = await houseClerkSource.sync(ctx, { datasets: ["short-volume"] });
    expect(filtered.rowsUpserted).toBe(0);

    // Limit 1 spends the budget on the older (paper, 404) filing and stops.
    const limited = await houseClerkSource.sync(ctx, { limit: 1 });
    expect(limited.rowsUpserted).toBe(0);
    expect(limited.notes.some((n) => n.includes("--limit"))).toBe(true);
    expect(await store.getWatermark("house-clerk", "clerk.lastFiledDate")).toBeNull();
    // A partial walk must not persist validators, or the next run would 304 past it.
    expect(await store.getFetchCache(INDEX_URL)).toBeNull();

    await store.close();
  });

  it("records scanned filings (no text layer) as pending instead of inventing rows", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction([]);

    const result = await houseClerkSource.sync(ctx);
    expect(result.rowsUpserted).toBe(0);
    expect(result.parse).toEqual({ attempted: 0, succeeded: 0 });
    expect(result.notes.some((n) => n.includes("no text layer"))).toBe(true);
    expect(await store.count("congress-trades")).toBe(0);

    await store.close();
  });
});

describe("houseClerkSource.canary", () => {
  it("goes green when the index fetches, fingerprints match, and a PTR is fresh", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction(cleanPtrItems);
    await runSync(ctx, { sources: ["house-clerk"] }); // records parse stats for the rate check

    const outcome = await houseClerkSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["fetch-year-index"]?.ok).toBe(true);
    expect(byName["index-fingerprint"]?.ok).toBe(true);
    expect(byName["ptr-header-fingerprint"]?.ok).toBe(true);
    expect(byName["ptr-freshness"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("green");

    await store.close();
  });

  it("hard-fails when the PTR table header layout drifts", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction(cleanPtrItems);
    await store.setFingerprint("house-clerk", "clerk.ptr-header", "somethingelse");

    const outcome = await houseClerkSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "ptr-header-fingerprint");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");

    await store.close();
  });

  it("hard-fails when the index XML field set drifts", async () => {
    const { ctx, store } = await makeCtx();
    stubExtraction(cleanPtrItems);
    await store.setFingerprint("house-clerk", "clerk.index-fields", "somethingelse");

    const outcome = await houseClerkSource.canary(ctx);
    const check = outcome.checks.find((c) => c.name === "index-fingerprint");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("hard");
    expect(deriveCanaryStatus(true, outcome.checks)).toBe("red");

    await store.close();
  });
});
