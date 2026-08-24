import { existsSync, readFileSync } from "node:fs";
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
    expect(report.datasets).toHaveLength(6);
    expect(report.datasets.every((d: { rowCount: number }) => d.rowCount === 0)).toBe(true);
    expect(existsSync(join(tmp, "cli-test.db"))).toBe(true);
  });

  it("sync on a scaffolded source reports not-implemented and exits 0", () => {
    const out = docket(["sync", "--source", "house-clerk", "--json", "--db", "cli-test.db"]);
    const summary = JSON.parse(out);
    expect(summary.ok).toBe(true);
    expect(summary.results[0].implemented).toBe(false);
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
    expect(Object.keys(manifest.datasets)).toHaveLength(6);
  });

  it("rejects unknown sources and datasets by name", () => {
    expect(() => docket(["sync", "--source", "quiverquant", "--db", "cli-test.db"])).toThrow();
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
