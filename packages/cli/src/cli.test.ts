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

function docket(args: string[], env: Record<string, string> = {}): string {
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

describe("docket CLI", () => {
  it("--version prints the version", () => {
    expect(docket(["--version"]).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help lists all five commands", () => {
    const help = docket(["--help"]);
    for (const cmd of ["sync", "status", "export", "canary", "serve"]) {
      expect(help).toContain(cmd);
    }
  });

  it("status --json creates the store, migrates, and reports all datasets empty", () => {
    const out = docket(["status", "--json", "--db", "cli-test.db"]);
    const report = JSON.parse(out);
    expect(report.datasets).toHaveLength(12);
    expect(report.datasets.every((d: { rowCount: number }) => d.rowCount === 0)).toBe(true);
    expect(existsSync(join(tmp, "cli-test.db"))).toBe(true);
  });

  it("sync with a dataset filter a source doesn't produce is an offline no-op", () => {
    // finra only produces short-volume; the filter short-circuits before any
    // network access, so this exercises the CLI sync path fully offline.
    const out = docket([
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
    expect(summary.results[0].implemented).toBe(true);
    expect(summary.results[0].rowsUpserted).toBe(0);
  });

  it("sync --source edgar without a contact email fails with the fair-access explanation", () => {
    let failed = false;
    try {
      docket(["sync", "--source", "edgar", "--json", "--db", "cli-test.db"], {
        DOCKET_CONTACT: "",
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
    const out = docket(["export", "--json", "--db", "cli-test.db", "--out", join(tmp, "dumps")]);
    const summary = JSON.parse(out);
    expect(summary.filesWritten.some((f: string) => f.endsWith("manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(tmp, "dumps", "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.datasets)).toHaveLength(12);
  });

  it("rejects unknown sources and datasets by name", () => {
    expect(() => docket(["sync", "--source", "not-a-source", "--db", "cli-test.db"])).toThrow();
    expect(() => docket(["export", "--dataset", "nope", "--db", "cli-test.db"])).toThrow();
  });

  it("resolve cusips --json reports all zeros on a store with nothing unresolved", () => {
    // Fully offline: with no unresolved CUSIPs the command never calls OpenFIGI.
    const out = docket(["resolve", "cusips", "--json", "--db", "resolve-test.db"]);
    expect(JSON.parse(out)).toEqual({
      unresolvedCusips: 0,
      resolved: 0,
      stillUnresolved: 0,
      rowsUpdated: 0,
    });
  });

  it("resolve rejects unknown targets and bad limits", () => {
    expect(() => docket(["resolve", "tickers", "--db", "resolve-test.db"])).toThrow();
    expect(() =>
      docket(["resolve", "cusips", "--limit", "zero", "--db", "resolve-test.db"]),
    ).toThrow();
  });

  it("--help lists the resolve command", () => {
    expect(docket(["--help"])).toContain("resolve");
  });
});

describe("docket analyze", () => {
  it("rejects an unknown analyze target", () => {
    expect(() => docket(["analyze", "not-a-target", "--db", "analyze-validation.db"])).toThrow();
  });

  it("requires --prices and names the expected CSV shape", () => {
    let failed = false;
    try {
      docket(["analyze", "congress", "--db", "analyze-validation.db"]);
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
      docket([
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
    docket(["import", deltaPath, "--dataset", "congress-trades", "--db", "analyze-e2e.db"]);

    const pricesPath = join(tmp, "prices.csv");
    writeFileSync(
      pricesPath,
      ["date,ticker,close", "2026-08-18,ACME,40.00", "2026-09-17,ACME,44.00", ""].join("\n"),
    );

    const out = docket([
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

    const jsonOut = docket([
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
    docket([
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
    expect(docket(["--help"])).toContain("analyze");
  });
});
