#!/usr/bin/env node
/**
 * Builds `archives.json`, the index of the deep-history archive releases in
 * the data repository: for every dataset and event year, the release asset
 * holding the newest complete `snapshot-{YYYY}.json.gz` shard. Consumers
 * (the hosted LuxAlgo MCP server, the explorer, anyone with a URL) read this
 * one file instead of walking the GitHub Releases API themselves. Run by the
 * daily publish workflow once the export exists; safe to run locally.
 *
 *   node scripts/build-archives-index.mjs [manifest.json] [archives.json]
 *
 * Defaults: `dumps/manifest.json` in, `dumps/archives.json` out. Env:
 * DATA_REPO (owner/repo, default LuxAlgo/market-trackers-data) and, for
 * authenticated API calls, ALT_DATASETS_TOKEN or GITHUB_TOKEN (optional —
 * the anonymous limit is plenty for a one-off local run).
 *
 * Release layout (docs/backfill.md): tag `archive-{source}-{from}-{to}`,
 * assets `snapshot-{YYYY}.json.gz`, or `{dataset-id}--snapshot-{YYYY}.json.gz`
 * when a run's store held several datasets (see backfill.yml). Plain names
 * map to the source's dataset via the manifest's `implementedDatasets` when
 * it names exactly one, otherwise through ARCHIVE_PRIMARY_DATASET below.
 *
 * Per dataset and year the LARGEST asset wins (ties go to the newest): a
 * resumed backfill's cumulative store only ever grows a year's shard, and
 * across sources (the EDGAR daily-index walk vs the SEC bulk data sets) the
 * complete shard is the large one, while a later upload can be a small
 * stray-row shard. Years outside 1900..next year are garbage event dates in
 * source documents and are skipped.
 *
 * An API failure (network, rate limit) leaves the previous index in place:
 * the script warns and exits 0 without writing. Anything else fails loudly.
 */
/* global AbortSignal */
import { readFileSync, writeFileSync } from "node:fs";

const [manifestPath = "dumps/manifest.json", outPath = "dumps/archives.json"] =
  process.argv.slice(2);
const repo = process.env.DATA_REPO || "LuxAlgo/market-trackers-data";
const token = process.env.ALT_DATASETS_TOKEN || process.env.GITHUB_TOKEN || "";

/**
 * Sources whose backfill stores hold more than one dataset but whose
 * plain-named archive assets belong to one of them.
 */
const ARCHIVE_PRIMARY_DATASET = {
  // The daily-index backfill walks Forms 3/4/5 only; 13F rows come from the live sync.
  edgar: "insider-transactions",
  "edgar-bulk": "insider-transactions",
  // Contracts take the walk's budget first; runs since the prefixed naming
  // landed publish grants under their own dataset prefix.
  usaspending: "gov-contracts",
};

const TAG = /^archive-(.+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/;
const ASSET = /^(?:([a-z0-9-]+)--)?snapshot-(\d{4})\.json\.gz$/;

class ApiUnavailable extends Error {}

async function listReleases() {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "market-trackers-publish",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ApiUnavailable(`GitHub API unreachable: ${error.message ?? error}`);
    }
    if (!response.ok) {
      throw new ApiUnavailable(`GitHub API ${response.status} for ${url}`);
    }
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

function warn(message) {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const datasetOrder = Object.keys(manifest.datasets);
const maxYear = new Date().getUTCFullYear() + 1;

let releases;
try {
  releases = await listReleases();
} catch (error) {
  if (error instanceof ApiUnavailable) {
    warn(`${error.message}; leaving the existing archive index untouched.`);
    process.exit(0);
  }
  throw error;
}

const chosen = new Map(); // dataset -> Map<year, shard>
const indexed = [];
const unattributed = new Set();

for (const release of releases) {
  if (release.draft) continue;
  const tagMatch = TAG.exec(release.tag_name);
  if (!tagMatch) continue;
  const [, source, from, to] = tagMatch;
  indexed.push({
    tag: release.tag_name,
    source,
    from,
    to,
    publishedAt: release.published_at,
    assets: release.assets.length,
  });

  for (const asset of release.assets) {
    const assetMatch = ASSET.exec(asset.name);
    if (!assetMatch || asset.size === 0) continue;
    const [, prefixedDataset, yearText] = assetMatch;
    const year = Number(yearText);
    if (year < 1900 || year > maxYear) continue;

    let dataset = prefixedDataset ?? ARCHIVE_PRIMARY_DATASET[source];
    if (!dataset) {
      const implemented = manifest.sources?.[source]?.implementedDatasets ?? [];
      if (implemented.length === 1) dataset = implemented[0];
    }
    if (!dataset || !manifest.datasets[dataset]) {
      unattributed.add(`${release.tag_name}/${asset.name}`);
      continue;
    }

    const years = chosen.get(dataset) ?? new Map();
    const current = years.get(year);
    if (
      !current ||
      asset.size > current.bytes ||
      (asset.size === current.bytes && asset.updated_at > current.updatedAt)
    ) {
      years.set(year, {
        tag: release.tag_name,
        asset: asset.name,
        bytes: asset.size,
        updatedAt: asset.updated_at,
      });
    }
    chosen.set(dataset, years);
  }
}

if (unattributed.size > 0) {
  warn(
    `${unattributed.size} archive asset(s) could not be attributed to a dataset and were skipped: ` +
      [...unattributed].slice(0, 5).join(", ") +
      (unattributed.size > 5 ? ", …" : ""),
  );
}

const datasets = {};
for (const id of datasetOrder) {
  const years = chosen.get(id);
  if (!years) continue;
  datasets[id] = {
    years: Object.fromEntries([...years.entries()].sort(([a], [b]) => a - b)),
  };
}

const index = {
  generatedAt: new Date().toISOString(),
  repository: repo,
  datasets,
  releases: indexed.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)),
};

writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n");

const summary = Object.entries(datasets)
  .map(([id, entry]) => {
    const years = Object.keys(entry.years);
    return `${id}: ${years.length} year(s) ${years[0]}–${years[years.length - 1]}`;
  })
  .join("\n  ");
console.log(
  `archives.json: ${indexed.length} archive release(s), ${Object.keys(datasets).length} dataset(s) indexed` +
    (summary ? `\n  ${summary}` : ""),
);
