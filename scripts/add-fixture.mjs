#!/usr/bin/env node
/**
 * Grow the golden corpus from a real EDGAR document — run this on a machine
 * WITH network access (CI runners, contributor laptops; sandboxes need --file):
 *
 *   MARKET_TRACKERS_CONTACT=you@example.com node scripts/add-fixture.mjs \
 *     --parser form-ownership \
 *     --url https://www.sec.gov/Archives/edgar/data/320193/000032019326000012/0000320193-26-000012.txt
 *
 *   node scripts/add-fixture.mjs --parser thirteenf --file ./local-submission.txt
 *
 * Fetches (or reads) a full-submission .txt, derives accession/filedAt from
 * the SEC header, runs the real parser from packages/core/dist, and writes a
 * new case directory (input.txt, expected.json from the parse, meta.json with
 * "synthetic": false, "verified": false). A human then checks expected.json
 * against the primary document and flips "verified" to true — the corpus
 * only grows hand-checked.
 *
 * Options:
 *   --parser form-ownership|thirteenf   which parser the document feeds (required)
 *   --url <edgar .txt url>              fetch from www.sec.gov (needs MARKET_TRACKERS_CONTACT)
 *   --file <path>                       use a local copy instead of fetching
 *   --out <dir>                         case directory (default: packages/core/fixtures/edgar-<parser>/case-<accession>)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARSERS = ["form-ownership", "thirteenf"];

function fail(message) {
  console.error(`add-fixture: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) fail(`unexpected argument '${flag}'`);
    const key = flag.slice(2);
    if (!["parser", "url", "file", "out"].includes(key)) fail(`unknown option '${flag}'`);
    const value = argv[++i];
    if (value === undefined) fail(`missing value for '${flag}'`);
    args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.parser || !PARSERS.includes(args.parser)) {
  fail(`--parser must be one of: ${PARSERS.join(", ")}`);
}
if ((args.url ? 1 : 0) + (args.file ? 1 : 0) !== 1) {
  fail("pass exactly one of --url <edgar .txt url> or --file <local .txt>");
}

// The real parsers, from the built package — never a reimplementation.
const distEntry = join(ROOT, "packages", "core", "dist", "index.js");
if (!existsSync(distEntry)) {
  fail("packages/core/dist is missing — run `pnpm build` first, then retry");
}
const core = await import(pathToFileURL(distEntry).href);

let text;
let txtUrl = null;

if (args.url) {
  const contact = process.env.MARKET_TRACKERS_CONTACT;
  if (!contact) {
    fail(
      "MARKET_TRACKERS_CONTACT is not set. SEC fair access requires a declared contact in the " +
        "User-Agent; refusing to fetch anonymously. Example: MARKET_TRACKERS_CONTACT=you@example.com",
    );
  }
  const url = new URL(args.url);
  if (url.hostname !== "www.sec.gov" || !url.pathname.endsWith(".txt")) {
    fail("--url must be a www.sec.gov full-submission .txt URL");
  }
  txtUrl = url.toString();
  const response = await fetch(txtUrl, {
    headers: {
      "user-agent": `market-trackers-add-fixture/${core.MARKET_TRACKERS_VERSION} (${contact})`,
      accept: "text/plain, */*",
    },
  });
  if (!response.ok) fail(`fetch failed: HTTP ${response.status} for ${txtUrl}`);
  text = await response.text();
} else {
  const file = resolve(args.file);
  if (!existsSync(file)) fail(`no such file: ${file}`);
  text = readFileSync(file, "utf8");
}

// Accession + filing date come from the SEC header, not from guesses.
const header = core.parseSecHeader(text);
if (!header.accessionNumber)
  fail("no ACCESSION NUMBER in the SEC header — is this a full-submission .txt?");
if (!header.filedAsOfDate) fail("no FILED AS OF DATE in the SEC header");

// Provenance deep link: the filing index page. Derived from the .txt URL when
// fetching; from the header CIK for local files (any involved CIK's archive
// folder serves the accession).
let sourceUrl;
if (txtUrl) {
  sourceUrl = txtUrl.replace(/\.txt$/, "-index.htm");
} else {
  if (!header.centralIndexKey)
    fail("no CENTRAL INDEX KEY in the SEC header to build the index URL");
  sourceUrl = `https://www.sec.gov/Archives/edgar/data/${Number(header.centralIndexKey)}/${header.accessionNumber}-index.htm`;
}

const parseInput = {
  accessionNumber: header.accessionNumber,
  filedAt: header.filedAsOfDate,
  sourceUrl,
  retrievedAt: new Date().toISOString(),
};

const parse = args.parser === "form-ownership" ? core.parseOwnershipForm : core.parseThirteenf;
let result;
try {
  result = JSON.parse(JSON.stringify(parse({ text, ...parseInput })));
} catch (error) {
  fail(`parser rejected the document: ${error instanceof Error ? error.message : error}`);
}

const caseDir = resolve(
  args.out ??
    join(
      ROOT,
      "packages",
      "core",
      "fixtures",
      `edgar-${args.parser}`,
      `case-${header.accessionNumber}`,
    ),
);
if (existsSync(join(caseDir, "meta.json"))) {
  fail(`case already exists: ${caseDir} — pick another --out or remove it first`);
}
mkdirSync(caseDir, { recursive: true });

const meta = {
  synthetic: false,
  verified: false,
  notes:
    "Added via scripts/add-fixture.mjs. Hand-verify expected.json against the primary document, then set verified: true.",
  sourceUrl: txtUrl,
  parser: args.parser === "form-ownership" ? core.FORM_OWNERSHIP_PARSER : core.THIRTEENF_PARSER,
  parseInput,
};

writeFileSync(join(caseDir, "input.txt"), text);
writeFileSync(join(caseDir, "expected.json"), JSON.stringify(result, null, 2) + "\n");
writeFileSync(join(caseDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`wrote ${caseDir}`);
console.log(`  accession: ${header.accessionNumber} (filed ${header.filedAsOfDate})`);
console.log(`  rows parsed: ${result.rows.length}`);
console.log(`  next: hand-verify expected.json, then set "verified": true in meta.json`);
