#!/usr/bin/env node
/**
 * Dependency license gate. Fails CI when any dependency in the pnpm workspace
 * resolves to a license outside the permissive allowlist.
 *
 * Dual/multi-licensed packages (SPDX `OR` expressions) pass when at least one
 * arm is allowlisted — that's the license we elect to receive them under.
 * Copyleft or unknown licenses are a build failure, not a judgement call:
 * replace the dependency or get an explicit LuxAlgo decision.
 *
 * Usage: node scripts/check-dep-licenses.mjs   (expects `pnpm licenses list
 * --json` output on stdin, or runs it itself when stdin is a TTY).
 */
import { execSync } from "node:child_process";

const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "0BSD",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

function expressionAllowed(expr) {
  if (ALLOW.has(expr)) return true;
  // SPDX OR expression: allowed when any arm is allowed.
  const bare = expr.replace(/^\(|\)$/g, "");
  if (bare.includes(" OR ")) return bare.split(" OR ").some((part) => ALLOW.has(part.trim()));
  // AND expressions require every arm to be allowed.
  if (bare.includes(" AND ")) return bare.split(" AND ").every((part) => ALLOW.has(part.trim()));
  return false;
}

const raw = execSync("pnpm licenses list --json", {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);

const violations = [];
for (const [license, packages] of Object.entries(byLicense)) {
  if (!expressionAllowed(license)) {
    for (const pkg of packages) violations.push(`${pkg.name} — ${license}`);
  }
}

if (violations.length > 0) {
  console.error("Dependency license gate FAILED. Outside the allowlist:\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nReplace the dependency or get an explicit LuxAlgo decision; do not widen the allowlist casually.",
  );
  process.exit(1);
}
console.log(
  `Dependency license gate passed (${Object.keys(byLicense).length} license groups, all allowlisted).`,
);
