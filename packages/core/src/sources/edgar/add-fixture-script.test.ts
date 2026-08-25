import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, makeTmpDir } from "../../test-helpers.js";

/**
 * Offline coverage of scripts/add-fixture.mjs via its --file path (the --url
 * path needs sec.gov and is exercised by contributors/CI with network). The
 * script runs the real parser from packages/core/dist, so the build is made
 * on demand exactly like the CLI black-box tests do.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "add-fixture.mjs");
const DIST = join(PKG_ROOT, "dist", "index.js");

function run(args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

beforeAll(() => {
  if (!existsSync(DIST)) {
    execFileSync(
      "node",
      [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", PKG_ROOT],
      { encoding: "utf8" },
    );
  }
});

describe("scripts/add-fixture.mjs --file", () => {
  it("derives the accession from the SEC header, runs the real parser, and writes an unverified case", () => {
    const { dir, cleanup } = makeTmpDir("add-fixture");
    try {
      const out = join(dir, "case-real-form4");
      const stdout = run([
        "--parser",
        "form-ownership",
        "--file",
        fixturePath("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
        "--out",
        out,
      ]);
      expect(stdout).toContain("0001127602-26-019876");
      expect(stdout).toContain("rows parsed: 3");

      const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
      expect(meta.synthetic).toBe(false);
      expect(meta.verified).toBe(false); // a human flips this after checking
      expect(meta.parser).toBe("form-ownership-xml@1");
      expect(meta.parseInput.accessionNumber).toBe("0001127602-26-019876");
      expect(meta.parseInput.filedAt).toBe("2026-08-20");

      const expected = JSON.parse(readFileSync(join(out, "expected.json"), "utf8"));
      expect(expected.rows).toHaveLength(3);
      expect(expected.issuerCik).toBe("0000123456");
      expect(expected.rows[0].provenance.sourceUrl).toBe(meta.parseInput.sourceUrl);

      // input.txt is byte-identical to what was read.
      expect(readFileSync(join(out, "input.txt"), "utf8")).toBe(
        readFileSync(
          fixturePath("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
          "utf8",
        ),
      );

      // Refuses to clobber an existing case.
      expect(() =>
        run([
          "--parser",
          "form-ownership",
          "--file",
          fixturePath("edgar-form-ownership", "case-form4-sale-and-exercise", "input.txt"),
          "--out",
          out,
        ]),
      ).toThrow();
    } finally {
      cleanup();
    }
  });

  it("refuses --url without ALT_DATA_CONTACT (fair access) and rejects bad parsers", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--parser", "form-ownership", "--url", "https://www.sec.gov/Archives/x.txt"],
        { encoding: "utf8", env: { ...process.env, ALT_DATA_CONTACT: "" } },
      ),
    ).toThrow(/ALT_DATA_CONTACT/);
    expect(() => run(["--parser", "form-13g", "--file", "whatever.txt"])).toThrow();
  });
});
