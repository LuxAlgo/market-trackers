#!/usr/bin/env node
/**
 * Rewrites the README health board between the HEALTH-BOARD markers from a
 * canary report (JSON produced by `docket canary --out`). Run by the daily
 * publish workflow; safe to run locally.
 *
 *   node scripts/update-health-board.mjs canary-report.json README.md
 */
import { readFileSync, writeFileSync } from "node:fs";

const [reportPath = "canary-report.json", readmePath = "README.md"] = process.argv.slice(2);

const TITLES = {
  edgar: "SEC EDGAR (Forms 3/4/5, 13F-HR)",
  "senate-efd": "Senate eFD (PTRs)",
  "house-clerk": "House Clerk (PTRs)",
  usaspending: "USAspending",
  lda: "Senate LDA",
  finra: "FINRA Reg SHO",
};

const BADGES = {
  green: "🟢 healthy",
  amber: "🟡 stale",
  red: "🔴 broken",
  skip: "🚧 ingestor in progress",
};

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const rows = report.sources
  .map((s) => {
    const title = TITLES[s.source] ?? s.source;
    const badge = BADGES[s.status] ?? s.status;
    const when = s.status === "skip" ? "—" : (s.ranAt ?? report.generatedAt);
    return `| ${title} | ${badge} | ${when} |`;
  })
  .join("\n");

const board = [
  "",
  "| Source | Status | Last checked |",
  "| ------ | ------ | ------------ |",
  rows,
  "",
].join("\n");

const readme = readFileSync(readmePath, "utf8");
const START = "<!-- HEALTH-BOARD:START -->";
const END = "<!-- HEALTH-BOARD:END -->";
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);
if (startIdx === -1 || endIdx === -1) {
  console.error(`Health-board markers not found in ${readmePath}`);
  process.exit(1);
}

const updated =
  readme.slice(0, startIdx + START.length) + "\n" + board + "\n" + readme.slice(endIdx);
writeFileSync(readmePath, updated);
console.log(`Health board updated from ${reportPath} (overall: ${report.overall}).`);
