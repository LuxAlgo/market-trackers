import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Black-box CLI tests against the built binary (`pnpm build` runs first in
 * CI; locally these tests build on demand). Everything runs offline against
 * a temp store — no network, no keys.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const BIN = join(PKG_ROOT, "dist", "index.js");

let tmp: string;

function altData(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: tmp,
  });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    execFileSync(
      "node",
      [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", PKG_ROOT],
      {
        encoding: "utf8",
      },
    );
  }
  const base = join(PKG_ROOT, ".tmp-test");
  mkdirSync(base, { recursive: true });
  tmp = mkdtempSync(join(base, "cli-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("alt-data CLI", () => {
  it("--version prints the version", () => {
    expect(altData(["--version"]).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help lists all five commands", () => {
    const help = altData(["--help"]);
    for (const cmd of ["sync", "status", "export", "canary", "serve"]) {
      expect(help).toContain(cmd);
    }
  });

  it("status --json creates the store, migrates, and reports all datasets empty", () => {
    const out = altData(["status", "--json", "--db", "cli-test.db"]);
    const report = JSON.parse(out);
    expect(report.datasets).toHaveLength(16);
    expect(report.datasets.every((d: { rowCount: number }) => d.rowCount === 0)).toBe(true);
    expect(existsSync(join(tmp, "cli-test.db"))).toBe(true);
  });

  it("sync with a dataset filter a source doesn't produce is an offline no-op", () => {
    // finra only produces short-volume; the filter short-circuits before any
    // network access, so this exercises the CLI sync path fully offline.
    const out = altData([
      "sync",
      "--source",
      "finra",
      "--dataset",
      "congress-trades",
      "--json",
      "--db",
      "cli-test.db",
    ]);
    const summary = JSON.parse(out);
    expect(summary.ok).toBe(true);
    expect(summary.partialOk).toBe(true);
    expect(summary.results[0].implemented).toBe(true);
    expect(summary.results[0].rowsUpserted).toBe(0);
  });

  it("sync --allow-partial exits 0 on a partial success and still 1 when everything fails", () => {
    // Success side: the offline no-op filter counts as a succeeding source.
    const out = altData([
      "sync",
      "--source",
      "finra",
      "--dataset",
      "congress-trades",
      "--allow-partial",
      "--json",
      "--db",
      "cli-test.db",
    ]);
    expect(JSON.parse(out).partialOk).toBe(true);

    // Failure side: edgar (the only source) fails fast without a contact
    // email, so even --allow-partial exits 1.
    let failed = false;
    try {
      altData(["sync", "--source", "edgar", "--allow-partial", "--json", "--db", "cli-test.db"], {
        ALT_DATA_CONTACT: "",
      });
    } catch (error) {
      failed = true;
      const err = error as { status: number; stdout: string };
      expect(err.status).toBe(1);
      expect(JSON.parse(err.stdout).partialOk).toBe(false);
    }
    expect(failed).toBe(true);
  });

  it("sync --source edgar without a contact email fails with the fair-access explanation", () => {
    let failed = false;
    try {
      altData(["sync", "--source", "edgar", "--json", "--db", "cli-test.db"], {
        ALT_DATA_CONTACT: "",
      });
    } catch (error) {
      failed = true;
      const err = error as { status: number; stdout: string };
      expect(err.status).toBe(1);
      expect(err.stdout).toContain("User-Agent");
    }
    expect(failed).toBe(true);
  });

  it("export writes a manifest even for an empty store", () => {
    const out = altData(["export", "--json", "--db", "cli-test.db", "--out", join(tmp, "dumps")]);
    const summary = JSON.parse(out);
    expect(summary.filesWritten.some((f: string) => f.endsWith("manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(tmp, "dumps", "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(2);
    expect(Object.keys(manifest.datasets)).toHaveLength(16);
  });

  it("export --snapshots-only writes snapshots + manifest but skips deltas, latest.json, feed.xml, and entity feeds", () => {
    const delta = [
      {
        id: "senate:snapshots-only-doc:0",
        chamber: "senate",
        docId: "snapshots-only-doc",
        rowIndex: 0,
        member: { name: "Snap Shot", bioguideId: "S000001", party: "I", state: "ZZ" },
        filedAt: "2026-08-18",
        transactedAt: "2026-08-01",
        ticker: "ACME",
        assetDescription: "Acme Corp — Common Stock",
        assetType: "stock",
        side: "buy",
        amountRange: { min: 1_001, max: 15_000, text: "$1,001 - $15,000" },
        owner: "self",
        provenance: {
          source: "senate-efd",
          sourceUrl: "https://example.gov/primary/snapshots-only-doc",
          retrievedAt: "2026-08-18T12:00:00.000Z",
          parser: "test@1",
          confidence: 1,
          needsReview: false,
        },
      },
    ];
    const deltaPath = join(tmp, "snapshots-only-delta.json");
    writeFileSync(deltaPath, JSON.stringify(delta));
    altData(["import", deltaPath, "--dataset", "congress-trades", "--db", "snapshots-only.db"]);

    altData([
      "export",
      "--dataset",
      "congress-trades",
      "--snapshots-only",
      "--db",
      "snapshots-only.db",
      "--out",
      join(tmp, "dumps-snapshots-only"),
    ]);

    const dir = join(tmp, "dumps-snapshots-only", "congress", "trades");
    expect(existsSync(join(dir, "2026"))).toBe(false);
    expect(existsSync(join(dir, "latest.json"))).toBe(false);
    expect(existsSync(join(dir, "feed.xml"))).toBe(false);
    expect(existsSync(join(dir, "feeds"))).toBe(false);
    expect(existsSync(join(dir, "snapshot.json.gz"))).toBe(true);
    expect(existsSync(join(tmp, "dumps-snapshots-only", "manifest.json"))).toBe(true);
  });

  it("rejects unknown sources and datasets by name", () => {
    expect(() => altData(["sync", "--source", "not-a-source", "--db", "cli-test.db"])).toThrow();
    expect(() => altData(["export", "--dataset", "nope", "--db", "cli-test.db"])).toThrow();
  });

  it("resolve cusips --json reports all zeros on a store with nothing unresolved", () => {
    // Fully offline: with no unresolved CUSIPs the command never calls OpenFIGI.
    const out = altData(["resolve", "cusips", "--json", "--db", "resolve-test.db"]);
    expect(JSON.parse(out)).toEqual({
      unresolvedCusips: 0,
      resolved: 0,
      stillUnresolved: 0,
      rowsUpdated: 0,
    });
  });

  it("resolve rejects unknown targets and bad limits", () => {
    expect(() => altData(["resolve", "tickers", "--db", "resolve-test.db"])).toThrow();
    expect(() =>
      altData(["resolve", "cusips", "--limit", "zero", "--db", "resolve-test.db"]),
    ).toThrow();
  });

  it("--help lists the resolve command", () => {
    expect(altData(["--help"])).toContain("resolve");
  });

  // Backfill's chunking/resume/limit behavior is covered at the engine
  // level (packages/core/src/backfill/engine.test.ts) with an injected fake
  // sync function; these black-box CLI tests only cover the validation
  // paths that never reach the network.
  it("backfill requires --from", () => {
    let failed = false;
    try {
      altData(["backfill", "--source", "finra", "--db", "cli-test.db"]);
    } catch (error) {
      failed = true;
      const err = error as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("--from");
    }
    expect(failed).toBe(true);
  });

  it("backfill rejects an unknown source", () => {
    expect(() =>
      altData([
        "backfill",
        "--source",
        "not-a-source",
        "--from",
        "2024-01-01",
        "--db",
        "cli-test.db",
      ]),
    ).toThrow();
  });

  it("backfill rejects a malformed --from/--to date and a --to before --from", () => {
    expect(() =>
      altData(["backfill", "--source", "finra", "--from", "not-a-date", "--db", "cli-test.db"]),
    ).toThrow();
    expect(() =>
      altData([
        "backfill",
        "--source",
        "finra",
        "--from",
        "2024-06-01",
        "--to",
        "2024-01-01",
        "--db",
        "cli-test.db",
      ]),
    ).toThrow();
  });

  it("--help lists the backfill command", () => {
    expect(altData(["--help"])).toContain("backfill");
  });
});

describe("alt-data analyze", () => {
  it("rejects an unknown analyze target", () => {
    expect(() => altData(["analyze", "not-a-target", "--db", "analyze-validation.db"])).toThrow();
  });

  it("requires --prices and names the expected CSV shape", () => {
    let failed = false;
    try {
      altData(["analyze", "congress", "--db", "analyze-validation.db"]);
    } catch (error) {
      failed = true;
      const err = error as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("date,ticker,close");
    }
    expect(failed).toBe(true);
  });

  it("rejects a non-positive --window", () => {
    writeFileSync(join(tmp, "any-prices.csv"), "date,ticker,close\n2026-08-18,ACME,10\n");
    expect(() =>
      altData([
        "analyze",
        "congress",
        "--prices",
        "any-prices.csv",
        "--window",
        "0",
        "--db",
        "analyze-validation.db",
      ]),
    ).toThrow();
  });

  it("end-to-end: import a hand-written delta, join a tiny prices.csv, and report a priced changePct with the disclaimer", () => {
    // A minimal, hand-written congress-trades delta — one ticketed row.
    const delta = [
      {
        id: "senate:cli-test-doc:0",
        chamber: "senate",
        docId: "cli-test-doc",
        rowIndex: 0,
        member: { name: "Test Member", bioguideId: "T000001", party: "I", state: "ZZ" },
        filedAt: "2026-08-18",
        transactedAt: "2026-08-01",
        ticker: "ACME",
        assetDescription: "Acme Corp — Common Stock",
        assetType: "stock",
        side: "buy",
        amountRange: { min: 1_001, max: 15_000, text: "$1,001 - $15,000" },
        owner: "self",
        provenance: {
          source: "senate-efd",
          sourceUrl: "https://example.gov/primary/cli-test-doc",
          retrievedAt: "2026-08-18T12:00:00.000Z",
          parser: "test@1",
          confidence: 1,
          needsReview: false,
        },
      },
    ];
    const deltaPath = join(tmp, "congress-delta.json");
    writeFileSync(deltaPath, JSON.stringify(delta));
    altData(["import", deltaPath, "--dataset", "congress-trades", "--db", "analyze-e2e.db"]);

    const pricesPath = join(tmp, "prices.csv");
    writeFileSync(
      pricesPath,
      ["date,ticker,close", "2026-08-18,ACME,40.00", "2026-09-17,ACME,44.00", ""].join("\n"),
    );

    const out = altData([
      "analyze",
      "congress",
      "--prices",
      pricesPath,
      "--window",
      "30",
      "--db",
      "analyze-e2e.db",
    ]);
    expect(out).toContain("Descriptive arithmetic over public records");
    expect(out).toContain("10.00%");

    const jsonOut = altData([
      "analyze",
      "congress",
      "--prices",
      pricesPath,
      "--window",
      "30",
      "--json",
      "--db",
      "analyze-e2e.db",
    ]);
    const result = JSON.parse(jsonOut);
    expect(result.disclaimer).toContain("Not investment advice");
    expect(result.aggregate.eventsOk).toBe(1);
    expect(result.rows[0].changePct).toBeCloseTo(0.1, 10);
    expect(result.rows[0].event.citation).toBe("https://example.gov/primary/cli-test-doc");

    const outPath = join(tmp, "analyze-result.json");
    altData([
      "analyze",
      "congress",
      "--prices",
      pricesPath,
      "--window",
      "30",
      "--out",
      outPath,
      "--db",
      "analyze-e2e.db",
    ]);
    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    expect(written.disclaimer).toContain("Not investment advice");
    expect(written.aggregate.eventsOk).toBe(1);
  });

  it("--help lists the analyze command", () => {
    expect(altData(["--help"])).toContain("analyze");
  });
});

describe("alt-data backtest", () => {
  it("rejects an unknown backtest target", () => {
    expect(() => altData(["backtest", "not-a-target", "--db", "backtest-validation.db"])).toThrow();
  });

  it("requires --prices and names the expected CSV shape", () => {
    let failed = false;
    try {
      altData(["backtest", "congress", "--db", "backtest-validation.db"]);
    } catch (error) {
      failed = true;
      const err = error as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("date,ticker,close");
    }
    expect(failed).toBe(true);
  });

  it("fails (nonzero) on an empty prices file, with a helpful message", () => {
    const emptyPricesPath = join(tmp, "backtest-empty-prices.csv");
    writeFileSync(emptyPricesPath, "date,ticker,close\n");
    let failed = false;
    try {
      altData([
        "backtest",
        "congress",
        "--prices",
        emptyPricesPath,
        "--db",
        "backtest-validation.db",
      ]);
    } catch (error) {
      failed = true;
      const err = error as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("no usable price rows");
    }
    expect(failed).toBe(true);
  });

  it("fails (nonzero) when no events match, with a helpful message", () => {
    const pricesPath = join(tmp, "backtest-nomatch-prices.csv");
    writeFileSync(pricesPath, "date,ticker,close\n2026-08-18,ACME,10\n");
    let failed = false;
    try {
      altData([
        "backtest",
        "congress",
        "--prices",
        pricesPath,
        "--ticker",
        "NOPE",
        "--db",
        "backtest-validation.db",
      ]);
    } catch (error) {
      failed = true;
      const err = error as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("no congress trade events matched");
    }
    expect(failed).toBe(true);
  });

  it(
    "end-to-end: import a hand-written 3-event delta, join a hand-computable prices.csv, and " +
      "report winRate arithmetic plus the disclaimer in both human and --json output, with the " +
      "unpriceable event kept as a skipped row rather than dropped",
    () => {
      const provenanceFor = (n: number) => ({
        source: "senate-efd",
        sourceUrl: `https://example.gov/primary/backtest-doc-${n}`,
        retrievedAt: "2026-08-18T12:00:00.000Z",
        parser: "test@1",
        confidence: 1,
        needsReview: false,
      });
      const tradeFor = (rowIndex: number, ticker: string) => ({
        id: `senate:backtest-doc:${rowIndex}`,
        chamber: "senate",
        docId: "backtest-doc",
        rowIndex,
        member: { name: "Backtest Member", bioguideId: "B000001", party: "I", state: "ZZ" },
        filedAt: "2026-08-18",
        transactedAt: "2026-08-01",
        ticker,
        assetDescription: `${ticker} Corp — Common Stock`,
        assetType: "stock",
        side: "buy",
        amountRange: { min: 1_001, max: 15_000, text: "$1,001 - $15,000" },
        owner: "self",
        provenance: provenanceFor(rowIndex),
      });
      // ACME +10%, BETA -10%, GAMMA has no price data at all (must be
      // skipped, never dropped) — winRate over the 2 priced events is 1/2.
      const delta = [tradeFor(0, "ACME"), tradeFor(1, "BETA"), tradeFor(2, "GAMMA")];
      const deltaPath = join(tmp, "backtest-delta.json");
      writeFileSync(deltaPath, JSON.stringify(delta));
      altData(["import", deltaPath, "--dataset", "congress-trades", "--db", "backtest-e2e.db"]);

      const pricesPath = join(tmp, "backtest-prices.csv");
      writeFileSync(
        pricesPath,
        [
          "date,ticker,close",
          "2026-08-18,ACME,40.00",
          "2026-09-17,ACME,44.00", // +10%
          "2026-08-18,BETA,50.00",
          "2026-09-17,BETA,45.00", // -10%
          "",
        ].join("\n"),
      );

      const out = altData([
        "backtest",
        "congress",
        "--prices",
        pricesPath,
        "--window",
        "30",
        "--db",
        "backtest-e2e.db",
      ]);
      expect(out).toContain("Descriptive arithmetic over public records");
      expect(out).toContain("events: 3  priced: 2  skipped: 1");
      expect(out).toContain("winRate: 50.00%");
      expect(out).toContain("skipped: entry price unavailable");

      const jsonOut = altData([
        "backtest",
        "congress",
        "--prices",
        pricesPath,
        "--window",
        "30",
        "--json",
        "--db",
        "backtest-e2e.db",
      ]);
      const result = JSON.parse(jsonOut);
      expect(result.disclaimer).toContain("Not investment advice");
      expect(result.dataNotes.length).toBeGreaterThan(0);
      expect(result.aggregate).toMatchObject({ events: 3, priced: 2, skipped: 1, winRate: 0.5 });
      expect(result.aggregate.meanChangePct).toBeCloseTo(0, 10);
      expect(result.aggregate.bestChangePct).toBeCloseTo(0.1, 10);
      expect(result.aggregate.worstChangePct).toBeCloseTo(-0.1, 10);

      const statuses = (result.rows as { status: string }[]).map((r) => r.status).sort();
      expect(statuses).toEqual(["priced", "priced", "skipped"]);
      const skippedRow = (
        result.rows as { status: string; event: { ticker: string }; reason?: string }[]
      ).find((r) => r.status === "skipped");
      expect(skippedRow?.event.ticker).toBe("GAMMA");
      expect(skippedRow?.reason).toContain("entry price unavailable");
    },
  );

  it("--help lists the backtest command", () => {
    expect(altData(["--help"])).toContain("backtest");
  });
});
