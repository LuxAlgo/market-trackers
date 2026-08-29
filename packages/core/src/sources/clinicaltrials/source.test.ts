import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clinicaltrialsSource, normalizeStudy } from "./source.js";
import {
  CLINICALTRIALS_FIELDS,
  CLINICALTRIALS_STUDIES_URL,
  extractFullDate,
  extractPartialDate,
  lastUpdatePostedRangeTerm,
  studyRowFingerprint,
} from "./client.js";
import { TrackerStore } from "../../store/store.js";
import { DATASETS } from "../../schema/datasets.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";
import type { ClinicalTrial } from "../../schema/clinical-trial.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end source test with a mocked network: the studies list pages
 * through two fixture responses (page 1 with `nextPageToken`, page 2 final)
 * for the `--since 2026-07-25 --until 2026-08-24` window. The sync must
 * normalize every study, keep registry date precision verbatim, resolve
 * sponsor tickers, set the `lastUpdatePosted` watermark, and be idempotent
 * on re-runs. A second fixture (`case-status-update`) represents the same
 * NCT id later, with an amended status — exercising the upsert-by-nctId
 * contract.
 */

const NOW = "2026-08-24T12:00:00.000Z";
const WATERMARK_KEY = "clinicaltrials.lastUpdatePosted";
const FINGERPRINT_KEY = "clinicaltrials.study-row-fields@2";
const EMPTY_PAGE = JSON.stringify({ studies: [] });

// The two terms this suite's fixtures are keyed to — computed with the same
// helper the source uses, so the test can never drift from the real syntax.
const FIRST_SYNC_TERM = lastUpdatePostedRangeTerm("2026-07-25", "2026-08-24");
const STATUS_UPDATE_TERM = lastUpdatePostedRangeTerm("2026-08-16", "2026-08-24");

interface CapturedRequest {
  term: string | null;
  fields: string | null;
  pageSize: string | null;
  pageToken: string | null;
}

function mockFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== CLINICALTRIALS_STUDIES_URL) {
      return new Response("not found", { status: 404 });
    }
    const term = url.searchParams.get("query.term");
    const pageToken = url.searchParams.get("pageToken");
    captured.push({
      term,
      fields: url.searchParams.get("fields"),
      pageSize: url.searchParams.get("pageSize"),
      pageToken,
    });

    if (pageToken === "page-2") {
      return new Response(readFixture("clinicaltrials", "case-studies-2026", "input-page-2.json"), {
        status: 200,
      });
    }
    if (term === FIRST_SYNC_TERM) {
      return new Response(readFixture("clinicaltrials", "case-studies-2026", "input-page-1.json"), {
        status: 200,
      });
    }
    if (term === STATUS_UPDATE_TERM) {
      return new Response(readFixture("clinicaltrials", "case-status-update", "input.json"), {
        status: 200,
      });
    }
    return new Response(EMPTY_PAGE, { status: 200 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: TrackerStore; captured: CapturedRequest[] }> {
  const store = await TrackerStore.open(":memory:");
  const captured: CapturedRequest[] = [];
  const ctx: SourceContext = {
    store,
    config: resolveConfig({ logLevel: "silent", ...overrides }, { cwd: "/nonexistent", env: {} }),
    logger: silentLogger,
    fetchImpl: mockFetch(captured),
    now: () => new Date(nowIso),
  };
  return { ctx, store, captured };
}

describe("clinicaltrialsSource.sync", () => {
  it("pages by pageToken, maps every module verbatim, sets the watermark, and re-runs idempotently", async () => {
    const { ctx, store, captured } = await makeCtx();

    const first = await clinicaltrialsSource.sync(ctx, { since: "2026-07-25" });
    expect(first.rowsUpserted).toBe(5);
    expect(first.perDataset["clinical-trials"]).toBe(5);
    expect(first.parse).toEqual({ attempted: 5, succeeded: 5 });
    expect(await store.count("clinical-trials")).toBe(5);

    // Two pages, `until` defaulted to "today" (NOW's date), full field list, max page size.
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      term: FIRST_SYNC_TERM,
      fields: CLINICALTRIALS_FIELDS.join(","),
      pageSize: "1000",
      pageToken: null,
    });
    expect(captured[1]?.pageToken).toBe("page-2");

    // Stored rows match the hand-verified expected output exactly — partial
    // dates verbatim, raw enums, resolved/unresolved sponsor tickers, nulls
    // (never guesses) for the studies missing optional fields/modules.
    const stored: ClinicalTrial[] = [];
    for await (const row of store.iterate(DATASETS["clinical-trials"])) stored.push(row);
    expect(stored).toEqual(
      readFixtureJson<ClinicalTrial[]>("clinicaltrials", "case-studies-2026", "expected.json"),
    );

    // Watermark lands on the max observed lastUpdatePostDate; fingerprint recorded.
    expect(await store.getWatermark("clinicaltrials", WATERMARK_KEY)).toBe("2026-08-10");
    expect(await store.getFingerprint("clinicaltrials", FINGERPRINT_KEY)).toBeTruthy();

    // Re-running the same window duplicates nothing.
    const second = await clinicaltrialsSource.sync(ctx, { since: "2026-07-25" });
    expect(second.rowsUpserted).toBe(5);
    expect(await store.count("clinical-trials")).toBe(5);

    await store.close();
  });

  it("re-syncing a later window returns the same nctId with an updated status, in place", async () => {
    const { ctx, store } = await makeCtx();

    await clinicaltrialsSource.sync(ctx, { since: "2026-07-25", until: "2026-08-24" });
    expect(await store.count("clinical-trials")).toBe(5);

    const second = await clinicaltrialsSource.sync(ctx, {
      since: "2026-08-16",
      until: "2026-08-24",
    });
    expect(second.rowsUpserted).toBe(1);
    // Still five rows total — the registry update overwrote the existing one.
    expect(await store.count("clinical-trials")).toBe(5);

    const stored: ClinicalTrial[] = [];
    for await (const row of store.iterate(DATASETS["clinical-trials"])) stored.push(row);
    const updated = stored.find((r) => r.nctId === "NCT05512345");
    expect(updated?.overallStatus).toBe("COMPLETED");
    expect(updated?.lastUpdated).toBe("2026-08-22");
    expect(updated?.primaryCompletionDate).toBe("2026-08-15");
    // Everything not touched by the amendment is unchanged.
    expect(updated?.sponsor).toEqual({ name: "Pfizer", tickers: ["PFE"] });
    expect(updated?.phase).toBe("PHASE3");

    await store.close();
  });

  it("honors --until by bounding the request range instead of walking to today", async () => {
    const { ctx, captured } = await makeCtx();
    const result = await clinicaltrialsSource.sync(ctx, {
      since: "2026-07-25",
      until: "2026-08-05",
    });
    // No fixture matches this exact bounded term, so it 200s empty — proving
    // the request (not the mock's routing) carries the real --until bound.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.term).toBe(lastUpdatePostedRangeTerm("2026-07-25", "2026-08-05"));
    expect(result.rowsUpserted).toBe(0);
    await ctx.store.close();
  });

  it("derives --since from the watermark minus the re-walk window, and never regresses it", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("clinicaltrials", WATERMARK_KEY, "2026-08-20");

    const result = await clinicaltrialsSource.sync(ctx, { until: "2026-08-24" });
    // 2026-08-20 minus the 7-day re-walk window.
    expect(captured[0]?.term).toBe(lastUpdatePostedRangeTerm("2026-08-13", "2026-08-24"));
    expect(result.rowsUpserted).toBe(0);
    // Nothing newer was observed; the pre-existing watermark stands.
    expect(await store.getWatermark("clinicaltrials", WATERMARK_KEY)).toBe("2026-08-20");

    await store.close();
  });

  it("never advances the watermark past --until even when a row's lastUpdated is later", async () => {
    const { ctx, store } = await makeCtx();
    const laterThanUntil = JSON.stringify({
      studies: [
        {
          protocolSection: {
            identificationModule: { nctId: "NCT09999999", briefTitle: "Edge Case Study" },
            statusModule: {
              overallStatus: "RECRUITING",
              lastUpdatePostDateStruct: { date: "2026-08-30", type: "ACTUAL" },
            },
            sponsorCollaboratorsModule: { leadSponsor: { name: "Example Sponsor" } },
            designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE1"] },
            conditionsModule: { conditions: ["Example Condition"] },
          },
          hasResults: false,
        },
      ],
    });
    ctx.fetchImpl = (async () => new Response(laterThanUntil, { status: 200 })) as typeof fetch;

    await clinicaltrialsSource.sync(ctx, { since: "2026-08-01", until: "2026-08-24" });
    expect(await store.getWatermark("clinicaltrials", WATERMARK_KEY)).toBe("2026-08-24");

    await store.close();
  });

  it("honors --limit, stopping before the watermark advances", async () => {
    const { ctx, store, captured } = await makeCtx();
    const result = await clinicaltrialsSource.sync(ctx, {
      since: "2026-07-25",
      until: "2026-08-24",
      limit: 3,
    });
    // Page 1 alone has exactly 3 studies, so the walk stops there.
    expect(result.rowsUpserted).toBe(3);
    expect(result.notes.join(" ")).toContain("--limit");
    expect(captured).toHaveLength(1);
    expect(await store.getWatermark("clinicaltrials", WATERMARK_KEY)).toBeNull();
    await store.close();
  });

  it("honors --full by ignoring the stored watermark", async () => {
    const { ctx, store, captured } = await makeCtx();
    await store.setWatermark("clinicaltrials", WATERMARK_KEY, "2026-08-20");
    await clinicaltrialsSource.sync(ctx, { until: "2026-08-24", full: true });
    // full clears the watermark, so --since falls back to today - backfillDays (3).
    expect(captured[0]?.term).toBe(lastUpdatePostedRangeTerm("2026-08-21", "2026-08-24"));
    await store.close();
  });

  it("respects the datasets filter", async () => {
    const { ctx, captured } = await makeCtx();
    const result = await clinicaltrialsSource.sync(ctx, { datasets: ["patents"] });
    expect(result.rowsUpserted).toBe(0);
    expect(captured).toHaveLength(0);
    await ctx.store.close();
  });

  it("resolves a sponsor through the SEC-name fallback, seeded in cik_tickers before the sync runs", async () => {
    const { ctx, store } = await makeCtx();
    // A name the curated map has no entry for at all — only the SEC tier,
    // seeded directly into this store, can resolve it.
    await store.replaceCikTickers([
      { cik: "0000000654", ticker: "HVBI", name: "Harborview Biotherapeutics Inc" },
    ]);
    const secFallbackPage = JSON.stringify({
      studies: [
        {
          protocolSection: {
            identificationModule: { nctId: "NCT09999001", briefTitle: "SEC-Fallback Probe Study" },
            statusModule: {
              overallStatus: "RECRUITING",
              lastUpdatePostDateStruct: { date: "2026-08-05", type: "ACTUAL" },
            },
            sponsorCollaboratorsModule: {
              leadSponsor: { name: "HARBORVIEW BIOTHERAPEUTICS, INC." },
            },
          },
          hasResults: false,
        },
      ],
    });
    ctx.fetchImpl = (async () => new Response(secFallbackPage, { status: 200 })) as typeof fetch;

    const result = await clinicaltrialsSource.sync(ctx, {
      since: "2026-08-01",
      until: "2026-08-24",
    });
    expect(result.rowsUpserted).toBe(1);
    const rows: ClinicalTrial[] = [];
    for await (const row of store.iterate(DATASETS["clinical-trials"])) rows.push(row);
    expect(rows[0]?.sponsor).toEqual({
      name: "HARBORVIEW BIOTHERAPEUTICS, INC.",
      tickers: ["HVBI"],
    });
    await store.close();
  });
});

describe("clinicaltrialsSource.canary", () => {
  it("goes green when the probe fetches, fingerprints, and parses cleanly", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () =>
      new Response(readFixture("clinicaltrials", "case-studies-2026", "input-page-1.json"), {
        status: 200,
      })) as typeof fetch;
    // limit:1 stops after page 1's three rows, so this never re-requests the
    // same fixture forever even though it always answers with a next token.
    await clinicaltrialsSource.sync(ctx, { since: "2026-07-25", until: "2026-08-24", limit: 1 });

    const outcome = await clinicaltrialsSource.canary(ctx);
    const byName = Object.fromEntries(outcome.checks.map((c) => [c.name, c]));
    expect(byName["probe-studies"]?.ok).toBe(true);
    expect(byName["fingerprint"]?.ok).toBe(true);
    expect(byName["parse-success-rate"]?.ok).toBe(true);
    expect(byName["freshness-clinical-trials"]?.ok).toBe(true);
    await store.close();
  });

  it("hard-fails the fingerprint check when a study's module/field shape drifts", async () => {
    const { ctx, store } = await makeCtx();
    ctx.fetchImpl = (async () =>
      new Response(readFixture("clinicaltrials", "case-studies-2026", "input-page-1.json"), {
        status: 200,
      })) as typeof fetch;
    await store.setFingerprint("clinicaltrials", FINGERPRINT_KEY, "somethingelse");
    const outcome = await clinicaltrialsSource.canary(ctx);
    const fingerprint = outcome.checks.find((c) => c.name === "fingerprint");
    expect(fingerprint?.ok).toBe(false);
    expect(fingerprint?.severity).toBe("hard");
    await store.close();
  });

  it("hard-fails the probe when the API rejects the request", async () => {
    const { ctx, store } = await makeCtx();
    // 400 is not a retry status, so the polite fetch surfaces it immediately.
    ctx.fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const outcome = await clinicaltrialsSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-studies");
    expect(probe?.ok).toBe(false);
    expect(probe?.severity).toBe("hard");
    await store.close();
  });
});

describe("lastUpdatePostedRangeTerm", () => {
  it("builds the documented AREA[LastUpdatePostDate]RANGE[...] essie expression", () => {
    expect(lastUpdatePostedRangeTerm("2026-07-25", "2026-08-24")).toBe(
      "AREA[LastUpdatePostDate]RANGE[2026-07-25,2026-08-24]",
    );
  });
});

describe("extractPartialDate / extractFullDate", () => {
  it("passes registry date precision through verbatim, and nulls anything unusable", () => {
    expect(extractPartialDate({ date: "2026" })).toBe("2026");
    expect(extractPartialDate({ date: "2026-05" })).toBe("2026-05");
    expect(extractPartialDate({ date: "2026-05-15" })).toBe("2026-05-15");
    expect(extractPartialDate({ date: "05/15/2026" })).toBeNull();
    expect(extractPartialDate(undefined)).toBeNull();
    expect(extractPartialDate(null)).toBeNull();
    expect(extractPartialDate({})).toBeNull();
    expect(extractPartialDate({ date: 20260515 })).toBeNull();
  });

  it("requires full YYYY-MM-DD precision", () => {
    expect(extractFullDate({ date: "2026-08-10" })).toBe("2026-08-10");
    expect(extractFullDate({ date: "2026-08" })).toBeNull();
    expect(extractFullDate({ date: "2026" })).toBeNull();
    expect(extractFullDate(undefined)).toBeNull();
  });
});

describe("normalizeStudy", () => {
  const RETRIEVED_AT = "2026-08-24T12:00:00.000Z";
  let store: TrackerStore;

  beforeAll(async () => {
    store = await TrackerStore.open(":memory:");
  });

  afterAll(async () => {
    await store.close();
  });

  it("throws rather than guessing when a required field is missing", async () => {
    const missingSponsor = {
      protocolSection: {
        identificationModule: { nctId: "NCT00000001", briefTitle: "Untitled" },
        statusModule: {
          overallStatus: "RECRUITING",
          lastUpdatePostDateStruct: { date: "2026-08-01" },
        },
      },
    };
    await expect(normalizeStudy(missingSponsor, RETRIEVED_AT, store)).rejects.toThrow(/sponsor/i);
  });

  it("joins multiple phases verbatim rather than picking one", async () => {
    const multiPhase = {
      protocolSection: {
        identificationModule: { nctId: "NCT00000002", briefTitle: "Two-Phase Study" },
        statusModule: {
          overallStatus: "RECRUITING",
          lastUpdatePostDateStruct: { date: "2026-08-01" },
        },
        sponsorCollaboratorsModule: { leadSponsor: { name: "Example Sponsor" } },
        designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE2", "PHASE3"] },
      },
    };
    const trial = await normalizeStudy(multiPhase, RETRIEVED_AT, store);
    expect(trial.phase).toBe("PHASE2/PHASE3");
  });

  it("defaults absent conditions to [] and absent phase/studyType/dates to null", async () => {
    const bareMinimum = {
      protocolSection: {
        identificationModule: { nctId: "NCT00000003", briefTitle: "Bare Minimum Study" },
        statusModule: {
          overallStatus: "UNKNOWN",
          lastUpdatePostDateStruct: { date: "2026-08-01" },
        },
        sponsorCollaboratorsModule: { leadSponsor: { name: "Example Sponsor" } },
      },
    };
    const trial = await normalizeStudy(bareMinimum, RETRIEVED_AT, store);
    expect(trial.conditions).toEqual([]);
    expect(trial.phase).toBeNull();
    expect(trial.studyType).toBeNull();
    expect(trial.startDate).toBeNull();
    expect(trial.primaryCompletionDate).toBeNull();
  });

  it("resolves a sponsor through the SEC-name fallback when only cik_tickers has it", async () => {
    const seeded = await TrackerStore.open(":memory:");
    await seeded.replaceCikTickers([
      { cik: "0000000654", ticker: "HVBI", name: "Harborview Biotherapeutics Inc" },
    ]);
    const study = {
      protocolSection: {
        identificationModule: { nctId: "NCT00000004", briefTitle: "SEC-Fallback Probe Study" },
        statusModule: {
          overallStatus: "RECRUITING",
          lastUpdatePostDateStruct: { date: "2026-08-01" },
        },
        sponsorCollaboratorsModule: {
          leadSponsor: { name: "HARBORVIEW BIOTHERAPEUTICS, INC." },
        },
      },
    };
    const trial = await normalizeStudy(study, RETRIEVED_AT, seeded);
    expect(trial.sponsor).toEqual({ name: "HARBORVIEW BIOTHERAPEUTICS, INC.", tickers: ["HVBI"] });
    await seeded.close();
  });
});

describe("studyRowFingerprint", () => {
  // Regression: hashing every module.field present on one probe study red'd
  // the canary on study variety — studies legitimately differ in which
  // optional modules they carry.
  it("is stable across studies that differ only in optional modules, but catches a required-path rename", () => {
    const required = {
      identificationModule: { nctId: "NCT00000001", briefTitle: "T" },
      statusModule: { overallStatus: "RECRUITING", lastUpdatePostDateStruct: { date: "2026-08-01" } },
      sponsorCollaboratorsModule: { leadSponsor: { name: "Example Bio" } },
    };
    const minimal = { protocolSection: { ...required } };
    const decorated = {
      protocolSection: {
        ...required,
        designModule: { phases: ["PHASE3"], studyType: "INTERVENTIONAL" },
        oversightModule: { oversightHasDmc: true },
        conditionsModule: { conditions: ["Example"] },
      },
    };
    expect(studyRowFingerprint(minimal)).toBe(studyRowFingerprint(decorated));

    const drifted = {
      protocolSection: {
        ...required,
        identificationModule: { nctIdentifier: "NCT00000001", briefTitle: "T" },
      },
    };
    expect(studyRowFingerprint(drifted)).not.toBe(studyRowFingerprint(minimal));
  });
});
