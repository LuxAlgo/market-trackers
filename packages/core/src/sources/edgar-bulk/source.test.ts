import { describe, expect, it } from "vitest";
import { edgarBulkSource, expectedLatestQuarter } from "./source.js";
import {
  compareQuarters,
  normalizeSetDate,
  parseQuarterLabel,
  quarterEnd,
  quarterLabel,
  quarterOfDate,
  quarterStart,
  quarterZipUrl,
} from "./client.js";
import { DATASETS } from "../../schema/datasets.js";
import type { InsiderTransaction } from "../../schema/insider-transaction.js";
import { TrackerStore } from "../../store/store.js";
import { resolveConfig, type ConfigOverrides } from "../../config.js";
import { silentLogger } from "../../lib/logger.js";
import type { SourceContext } from "../types.js";

/**
 * End-to-end tests with a mocked network serving hand-built quarter ZIPs.
 * The load-bearing assertion is row-identity parity with the ownership-XML
 * walk: transactions-then-holdings per table, document (SK) order within
 * each — so the same filing yields the same natural keys from either path.
 */

const NOW = "2026-08-24T12:00:00.000Z";

/**
 * Minimal stored-method ZIP writer for fixtures. CRCs are zeroed — the
 * project's reader takes sizes from the central directory and never
 * validates CRC32, and these bytes exist only for these tests.
 */
function makeZip(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, eocd]));
}

function tsv(columns: string[], rows: (string | number | null)[][]): string {
  return [
    columns.join("\t"),
    ...rows.map((row) => row.map((v) => (v === null ? "" : String(v))).join("\t")),
  ].join("\n");
}

/** One quarter archive with the DERA form345 table shapes these tests assume. */
function quarterFixture(options: {
  submissions: (string | number | null)[][];
  owners: (string | number | null)[][];
  ndTrans?: (string | number | null)[][];
  ndHold?: (string | number | null)[][];
  dTrans?: (string | number | null)[][];
  submissionColumns?: string[];
}): Uint8Array {
  return makeZip({
    "SUBMISSION.tsv": tsv(
      options.submissionColumns ?? [
        "ACCESSION_NUMBER",
        "FILING_DATE",
        "DOCUMENT_TYPE",
        "ISSUERCIK",
        "ISSUERNAME",
        "ISSUERTRADINGSYMBOL",
      ],
      options.submissions,
    ),
    "REPORTINGOWNER.tsv": tsv(
      [
        "ACCESSION_NUMBER",
        "RPTOWNERCIK",
        "RPTOWNERNAME",
        "RPTOWNER_RELATIONSHIP",
        "RPTOWNER_OFFICERTITLE",
      ],
      options.owners,
    ),
    "NONDERIV_TRANS.tsv": tsv(
      [
        "ACCESSION_NUMBER",
        "NONDERIV_TRANS_SK",
        "SECURITY_TITLE",
        "TRANS_DATE",
        "TRANS_CODE",
        "TRANS_ACQUIRED_DISP_CD",
        "TRANS_SHARES",
        "TRANS_PRICEPERSHARE",
        "SHRS_OWND_FOLWNG_TRANS",
        "DIRECT_INDIRECT_OWNERSHIP",
      ],
      options.ndTrans ?? [],
    ),
    "NONDERIV_HOLDING.tsv": tsv(
      [
        "ACCESSION_NUMBER",
        "NONDERIV_HOLDING_SK",
        "SECURITY_TITLE",
        "SHRS_OWND_FOLWNG_TRANS",
        "DIRECT_INDIRECT_OWNERSHIP",
      ],
      options.ndHold ?? [],
    ),
    "DERIV_TRANS.tsv": tsv(
      [
        "ACCESSION_NUMBER",
        "DERIV_TRANS_SK",
        "SECURITY_TITLE",
        "TRANS_DATE",
        "TRANS_CODE",
        "TRANS_ACQUIRED_DISP_CD",
        "TRANS_SHARES",
        "TRANS_PRICEPERSHARE",
        "SHRS_OWND_FOLWNG_TRANS",
        "DIRECT_INDIRECT_OWNERSHIP",
      ],
      options.dTrans ?? [],
    ),
  });
}

function mockZipFetch(
  zips: Record<string, Uint8Array>,
  captured: string[],
  onFetch?: () => void,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    captured.push(`${init?.method ?? "GET"} ${url}`);
    onFetch?.();
    const bytes = zips[url];
    if (bytes === undefined) return new Response("not found", { status: 404 });
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    return new Response(Buffer.from(bytes), { status: 200 });
  }) as typeof fetch;
}

async function makeCtx(
  overrides: ConfigOverrides = {},
  nowIso = NOW,
): Promise<{ ctx: SourceContext; store: TrackerStore }> {
  const store = await TrackerStore.open(":memory:");
  const ctx: SourceContext = {
    store,
    config: resolveConfig(
      { logLevel: "silent", contactEmail: "test@example.com", ...overrides },
      { cwd: "/nonexistent", env: {} },
    ),
    logger: silentLogger,
    now: () => new Date(nowIso),
  };
  return { ctx, store };
}

const Q1_2006 = quarterZipUrl({ year: 2006, quarter: 1 });
const Q2_2006 = quarterZipUrl({ year: 2006, quarter: 2 });

describe("edgarBulkSource.sync (backfill)", () => {
  it("ingests a quarter with ownership-XML row identity: transactions then holdings, SK order", async () => {
    const { ctx, store } = await makeCtx();
    const captured: string[] = [];
    ctx.fetchImpl = mockZipFetch(
      {
        [Q1_2006]: quarterFixture({
          submissions: [
            ["0001-06-000001", "03-JAN-2006", "4", "320193", "Apple Computer Inc", "AAPL"],
            ["0002-06-000002", "2006-02-10", "3", "789019", "Microsoft Corp", "NONE"],
          ],
          owners: [
            ["0001-06-000001", "1214156", "DOE JANE", "Officer", "CFO"],
            ["0002-06-000002", "1111111", "ROE RICHARD", "Director", null],
            ["0002-06-000002", "2222222", "ROE TRUST", null, null],
          ],
          // Deliberately out of SK order in the file: document order is the
          // SK, so ids must come out sorted (12 after 7).
          ndTrans: [
            ["0001-06-000001", 12, "Common Stock", "05-JAN-2006", "S", "D", "2,000", "75.10", "8000", "I"],
            ["0001-06-000001", 7, "Common Stock", "04-JAN-2006", "P", "A", "1000", "74.25", "10000", "D"],
          ],
          ndHold: [
            ["0001-06-000001", 20, "Common Stock", "10000", "D"],
            ["0002-06-000002", 5, "Common Stock", "500", "D"],
          ],
          dTrans: [["0001-06-000001", 3, "Stock Option", "05-JAN-2006", "M", "A", "300", null, "300", "D"]],
        }),
      },
      captured,
    );

    const result = await edgarBulkSource.sync(ctx, { since: "2006-01-01", until: "2006-03-31" });

    expect(captured).toEqual([`GET ${Q1_2006}`]);
    expect(result.parse).toEqual({ attempted: 5, succeeded: 5 });
    expect(result.rowsUpserted).toBe(5);
    expect(result.stoppedEarly).toBeUndefined();
    expect(result.completedThrough).toBe("2006-03-31");

    const rows = new Map<string, InsiderTransaction>();
    for await (const row of store.iterate(DATASETS["insider-transactions"])) rows.set(row.id, row);

    // SK 7 lands at index 0, SK 12 at index 1, the holding after both.
    const first = rows.get("0001-06-000001:nd:0");
    expect(first?.code).toBe("P");
    expect(first?.shares).toBe(1000);
    expect(first?.transactedAt).toBe("2006-01-04");
    expect(first?.filedAt).toBe("2006-01-03");
    expect(first?.ticker).toBe("AAPL");
    expect(first?.issuerCik).toBe("0000320193");
    expect(first?.insider).toEqual({
      name: "DOE JANE",
      cik: "0001214156",
      title: "CFO",
      isDirector: false,
      isOfficer: true,
      isTenPctOwner: false,
    });
    expect(first?.ownership).toBe("direct");
    expect(first?.provenance.needsReview).toBe(false);
    expect(first?.provenance.sourceUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/0001-06-000001-index.htm",
    );

    const second = rows.get("0001-06-000001:nd:1");
    expect(second?.code).toBe("S");
    expect(second?.shares).toBe(2000);
    expect(second?.ownership).toBe("indirect");

    const holding = rows.get("0001-06-000001:nd:2");
    expect(holding?.code).toBeNull();
    expect(holding?.transactedAt).toBeNull();
    expect(holding?.sharesOwnedAfter).toBe(10000);

    expect(rows.get("0001-06-000001:d:0")?.isDerivative).toBe(true);

    // Form 3 with two reporting owners: NONE ticker nulls, first owner
    // attributed, flagged for review — exactly the XML walk's behavior.
    const form3 = rows.get("0002-06-000002:nd:0");
    expect(form3?.formType).toBe("3");
    expect(form3?.ticker).toBeNull();
    expect(form3?.insider.name).toBe("ROE RICHARD");
    expect(form3?.insider.isDirector).toBe(true);
    expect(form3?.provenance.needsReview).toBe(true);

    await store.close();
  });

  it("treats a not-yet-published recent quarter as the walk being complete", async () => {
    const { ctx } = await makeCtx(); // NOW is 2026-08-24
    const captured: string[] = [];
    const q1 = quarterZipUrl({ year: 2026, quarter: 1 });
    ctx.fetchImpl = mockZipFetch(
      {
        [q1]: quarterFixture({
          submissions: [["0003-26-000001", "2026-02-02", "4", "320193", "Apple Inc", "AAPL"]],
          owners: [["0003-26-000001", "1214156", "DOE JANE", "Officer", "CFO"]],
          ndTrans: [
            ["0003-26-000001", 1, "Common Stock", "2026-02-01", "P", "A", "10", "1.00", "10", "D"],
          ],
        }),
      },
      captured,
    );

    const result = await edgarBulkSource.sync(ctx, { since: "2026-01-01", until: "2026-08-24" });

    // 2026q2's 404 ends the walk cleanly: every published quarter is in.
    expect(captured).toEqual([
      `GET ${quarterZipUrl({ year: 2026, quarter: 1 })}`,
      `GET ${quarterZipUrl({ year: 2026, quarter: 2 })}`,
    ]);
    expect(result.stoppedEarly).toBeUndefined();
    expect(result.notes.join(" ")).toContain("not published yet");
    expect(result.completedThrough).toBe("2026-03-31");
    await ctx.store.close();
  });

  it("treats a 404 on an old quarter as drift, stopping upstream with progress banked", async () => {
    const { ctx } = await makeCtx();
    ctx.fetchImpl = mockZipFetch(
      {
        [Q1_2006]: quarterFixture({
          submissions: [["0001-06-000001", "03-JAN-2006", "4", "320193", "Apple", "AAPL"]],
          owners: [["0001-06-000001", "1214156", "DOE JANE", "Officer", "CFO"]],
          ndTrans: [
            ["0001-06-000001", 1, "Common Stock", "04-JAN-2006", "P", "A", "10", "1.0", "10", "D"],
          ],
        }),
      },
      [],
    );

    const result = await edgarBulkSource.sync(ctx, { since: "2006-01-01", until: "2006-12-31" });

    expect(result.stoppedEarly).toBe("upstream");
    expect(result.notes.join(" ")).toContain("URL drift");
    expect(result.completedThrough).toBe("2006-03-31");
    await ctx.store.close();
  });

  it("stops at the deadline between quarters, banking completed quarters", async () => {
    const { ctx } = await makeCtx();
    let nowMs = Date.parse(NOW);
    ctx.now = () => new Date(nowMs);
    const captured: string[] = [];
    ctx.fetchImpl = mockZipFetch(
      {
        [Q1_2006]: quarterFixture({
          submissions: [["0001-06-000001", "03-JAN-2006", "4", "320193", "Apple", "AAPL"]],
          owners: [["0001-06-000001", "1214156", "DOE JANE", "Officer", "CFO"]],
          ndTrans: [
            ["0001-06-000001", 1, "Common Stock", "04-JAN-2006", "P", "A", "10", "1.0", "10", "D"],
          ],
        }),
      },
      captured,
      () => {
        nowMs += 10 * 60_000;
      },
    );

    const result = await edgarBulkSource.sync(ctx, {
      since: "2006-01-01",
      until: "2006-12-31",
      deadlineMs: Date.parse(NOW) + 60_000,
    });

    expect(captured).toEqual([`GET ${Q1_2006}`]);
    expect(result.stoppedEarly).toBe("deadline");
    expect(result.completedThrough).toBe("2006-03-31");
    expect(result.notes.join(" ")).toContain("2006q2");
    await ctx.store.close();
  });

  it("fails loudly when a required column disappears", async () => {
    const { ctx } = await makeCtx();
    ctx.fetchImpl = mockZipFetch(
      {
        [Q1_2006]: quarterFixture({
          submissionColumns: ["ACCESSION_NUMBER", "FILING_DATE", "DOCUMENT_TYPE", "ISSUERNAME"],
          submissions: [["0001-06-000001", "03-JAN-2006", "4", "Apple"]],
          owners: [["0001-06-000001", "1214156", "DOE JANE", "Officer", "CFO"]],
          ndTrans: [
            ["0001-06-000001", 1, "Common Stock", "04-JAN-2006", "P", "A", "10", "1.0", "10", "D"],
          ],
        }),
      },
      [],
    );

    await expect(
      edgarBulkSource.sync(ctx, { since: "2006-01-01", until: "2006-03-31" }),
    ).rejects.toThrow(/required column ISSUERCIK/);
    await ctx.store.close();
  });
});

describe("edgarBulkSource.sync (daily top-up)", () => {
  it("cold store ingests only the newest published quarter, then no-ops", async () => {
    const { ctx, store } = await makeCtx(); // expected latest = 2026q2
    const captured: string[] = [];
    const q2 = quarterZipUrl({ year: 2026, quarter: 2 });
    ctx.fetchImpl = mockZipFetch(
      {
        [q2]: quarterFixture({
          submissions: [["0004-26-000009", "2026-05-05", "4", "320193", "Apple Inc", "AAPL"]],
          owners: [["0004-26-000009", "1214156", "DOE JANE", "Officer", "CFO"]],
          ndTrans: [
            ["0004-26-000009", 1, "Common Stock", "2026-05-04", "S", "D", "5", "2.0", "5", "D"],
          ],
        }),
      },
      captured,
    );

    const first = await edgarBulkSource.sync(ctx);
    expect(captured).toEqual([`GET ${q2}`]);
    expect(first.rowsUpserted).toBe(1);
    expect(await store.getWatermark("edgar-bulk", "edgar-bulk.lastQuarter")).toBe("2026q2");

    const second = await edgarBulkSource.sync(ctx);
    expect(second.rowsUpserted).toBe(0);
    expect(second.notes.join(" ")).toContain("current through 2026q2");
    expect(captured).toHaveLength(1);
    await store.close();
  });
});

describe("edgarBulkSource.canary", () => {
  it("probes the expected quarter ZIP with a HEAD request", async () => {
    const { ctx, store } = await makeCtx();
    const captured: string[] = [];
    const q2 = quarterZipUrl({ year: 2026, quarter: 2 });
    ctx.fetchImpl = mockZipFetch({ [q2]: new Uint8Array() }, captured);

    const outcome = await edgarBulkSource.canary(ctx);
    const probe = outcome.checks.find((c) => c.name === "probe-quarter-zip");
    expect(captured[0]).toBe(`HEAD ${q2}`);
    expect(probe?.ok).toBe(true);
    expect(probe?.note).toContain("2026q2");
    await store.close();
  });
});

describe("quarter math and set-date parsing", () => {
  it("maps dates to quarters and back", () => {
    expect(quarterOfDate("2006-01-01")).toEqual({ year: 2006, quarter: 1 });
    expect(quarterOfDate("2026-08-24")).toEqual({ year: 2026, quarter: 3 });
    expect(quarterStart({ year: 2026, quarter: 3 })).toBe("2026-07-01");
    expect(quarterEnd({ year: 2026, quarter: 3 })).toBe("2026-09-30");
    expect(quarterLabel({ year: 2006, quarter: 4 })).toBe("2006q4");
    expect(parseQuarterLabel("2006q4")).toEqual({ year: 2006, quarter: 4 });
    expect(parseQuarterLabel("nope")).toBeNull();
    expect(
      compareQuarters({ year: 2006, quarter: 4 }, { year: 2007, quarter: 1 }),
    ).toBeLessThan(0);
  });

  it("expects the newest quarter to lag its end by the publication window", () => {
    expect(expectedLatestQuarter("2026-08-24")).toEqual({ year: 2026, quarter: 2 });
    // Right after a quarter ends, the previous one is still the newest file.
    expect(expectedLatestQuarter("2026-07-02")).toEqual({ year: 2026, quarter: 1 });
    // Well past the lag, the just-ended quarter is expected.
    expect(expectedLatestQuarter("2026-11-20")).toEqual({ year: 2026, quarter: 3 });
  });

  it("normalizes the three date shapes the sets have shipped", () => {
    expect(normalizeSetDate("03-JAN-2006")).toBe("2006-01-03");
    expect(normalizeSetDate("3-jan-2006")).toBe("2006-01-03");
    expect(normalizeSetDate("2026-05-04")).toBe("2026-05-04");
    expect(normalizeSetDate("20260504")).toBe("2026-05-04");
    expect(normalizeSetDate("2026-05-04 00:00:00")).toBe("2026-05-04");
    expect(normalizeSetDate("May 4, 2026")).toBeNull();
    expect(normalizeSetDate(null)).toBeNull();
  });
});
