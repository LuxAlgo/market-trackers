# Operations runbook

How the GitHub Actions machinery behaves, what configures it, and what to do when the board
goes red. The audience is the person operating a deployment of
[LuxAlgo/docket](https://github.com/LuxAlgo/docket) — including a fork with none of it
configured yet: every workflow is a safe no-op until its variables and secrets exist.

## Workflows at a glance

| Workflow            | Trigger                           | Needs                                                                  | Without configuration                                                                                           |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ci.yml`            | push to `main`, pull requests     | nothing                                                                | fully functional (offline tests, no keys)                                                                       |
| `canaries.yml`      | daily cron, manual                | `DOCKET_CONTACT` (optional)                                            | runs keyless; the EDGAR probe reports the gap and shows amber                                                   |
| `publish-dumps.yml` | daily cron, manual                | `DOCKET_DATA_REPO`, `DOCKET_DATA_TOKEN`, `DOCKET_CONTACT`              | job skipped without the repo var; builds but does not push without the token                                    |
| `sync-fast.yml`     | ~2-hourly cron (weekdays), manual | same as `publish-dumps.yml`                                            | job skipped without `DOCKET_DATA_REPO`; syncs but does not push without the token                               |
| `mirror-hf.yml`     | weekly cron, manual               | `DOCKET_DATA_REPO`, `DOCKET_DATA_TOKEN`, `HF_DATASET_REPO`, `HF_TOKEN` | job skipped without `DOCKET_DATA_REPO`/`HF_DATASET_REPO`; skips the push (with a log line) without either token |
| `release.yml`       | manual (`workflow_dispatch`)      | `NPM_TOKEN`                                                            | ends successfully after logging "NPM_TOKEN not configured; skipping publish."                                   |
| `backfill.yml`      | manual (`workflow_dispatch`)      | `DOCKET_CONTACT` (EDGAR only), `DOCKET_DATA_REPO` + `DOCKET_DATA_TOKEN` | backfills and uploads the dumps as a run artifact either way; the archive-release publish step onto the data repo is skipped without the var/token |

All workflows keep `permissions:` minimal, never print secrets, and pass secrets only through
env vars (`DOCKET_DATA_TOKEN` to checkout/push, `HF_TOKEN` to authenticate the Hugging Face
mirror push, `NPM_TOKEN` as `NODE_AUTH_TOKEN`).

## Repository variables and secrets

Set variables under **Settings → Secrets and variables → Actions → Variables**, secrets under
**… → Secrets**.

| Name                | Kind     | What it enables                                                                                                                                                                                                               | What stays off without it                                                                                  |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DOCKET_CONTACT`    | variable | The contact email the SEC's fair-access policy requires in the EDGAR User-Agent. Enables EDGAR sync in canaries and publishing.                                                                                               | EDGAR sync is skipped; the EDGAR canary soft-fails with "skipped: no contact email…" and shows amber.      |
| `DOCKET_DATA_REPO`  | variable | The target data repository, e.g. `LuxAlgo/docket-data`. Gates the whole publish job.                                                                                                                                          | `publish-dumps.yml` is skipped entirely — no sync, no export, no health-board commit.                      |
| `DOCKET_DATA_TOKEN` | secret   | Push access to the data repo. Enables checkout of the data repo, the first-publish README/LICENSE bootstrap, and the daily data push — and also unlocks `sync-fast.yml`'s pushes and `mirror-hf.yml`'s read of the data repo. | Dumps are still built (and the store cache still accumulates), but nothing is pushed; a log line says so.  |
| `HF_DATASET_REPO`   | variable | The target Hugging Face dataset repo for `mirror-hf.yml`, e.g. `LuxAlgo/docket-data`. Gates the mirror job.                                                                                                                   | `mirror-hf.yml` is skipped entirely.                                                                       |
| `HF_TOKEN`          | secret   | A Hugging Face token with write access to `HF_DATASET_REPO`. Enables `mirror-hf.yml`'s weekly push.                                                                                                                           | `mirror-hf.yml`'s job is skipped entirely (both it and `HF_DATASET_REPO` are checked before the job runs). |
| `NPM_TOKEN`         | secret   | Publishing `@luxalgo/docket-core`, `@luxalgo/docket-mcp`, `@luxalgo/docket-cli` to npm via `release.yml`.                                                                                                                     | The release run ends green after "NPM_TOKEN not configured; skipping publish." Nothing is published.       |

The contact email is only ever sent inside the EDGAR User-Agent header — Docket has no
telemetry (see `buildUserAgent` in `packages/core/src/config.ts`, which refuses to sync EDGAR
without one).

## Bootstrapping the data repository

`publish-dumps.yml` installs everything the data repo needs on its first successful run; the
repo starts empty.

1. **Create an empty repository** (e.g. `LuxAlgo/docket-data`). Public, no README, no license —
   the workflow installs both.
2. **Grant a token push access.** A fine-grained personal access token scoped to only the data
   repository with **Contents: read and write** is enough. Store it as the
   `DOCKET_DATA_TOKEN` secret in the docket repo.
3. **Set `DOCKET_DATA_REPO`** to the `owner/name` of the data repo (and `DOCKET_CONTACT` if
   EDGAR data should flow).
4. **Run the workflow** (Actions → "Publish dumps" → Run workflow, or wait for the daily cron).
   The first run:
   - syncs into a fresh `publish.db` (cached across runs, so history accumulates),
   - exports the dump layout (daily deltas, `latest.json`, `snapshot.json.gz`, `manifest.json`),
   - installs `README.md` and `LICENSE` into the data repo from `templates/docket-data/` —
     **only when missing**, so later hand-edits in the data repo are never overwritten,
   - rsyncs the dumps (`--delete`, excluding `.git`, `README.md`, `LICENSE`, and `/explorer`)
     and pushes as `docket-publish[bot]`,
   - installs/refreshes the static data explorer (`templates/docket-data/explorer/` →
     `explorer/` in the data repo) as its own commit — the exclusion above is what keeps the
     daily `--delete` from wiping it between refreshes,
   - refreshes the health board in this repo's README (committed with `[skip ci]`).

Day-to-day, the only writer to the data repo is this workflow. Human PRs to data files there
are closed; fixes belong in this repo's parsers and fixtures.

## The intraday fast lane

`sync-fast.yml` tops up the two most time-sensitive datasets — `congress-trades` and
`insider-transactions` — between daily publishes, on the same accumulating store and the same
data repo `publish-dumps.yml` uses. It needs no configuration beyond what `publish-dumps.yml`
already needs (`DOCKET_DATA_REPO`, `DOCKET_DATA_TOKEN`, `DOCKET_CONTACT`); it is a safe no-op
under the same conditions.

**Schedule.** SEC EDGAR accepts filings roughly 6am-10pm ET on business days, and Senate eFD /
House Clerk PTRs post on the same business-day rhythm. ET is UTC-4 (EDT) or UTC-5 (EST), so that
window falls somewhere across 10:00 UTC through 03:00 UTC the _next_ calendar day depending on
the time of year — the same reason `publish-dumps.yml` and `canaries.yml` both run through
Saturday in UTC terms rather than stopping at Friday. `sync-fast.yml` covers that ground with two
cron entries at roughly a 2-hour cadence: daytime UTC hours on Mon-Fri, plus the post-midnight UTC
hours (Tue-Sat) that are still evening-ET on the previous US business day.

**Why it never races or wipes the daily publish.** Two mechanisms, both load-bearing:

- **Concurrency.** `sync-fast.yml` shares `publish-dumps.yml`'s exact concurrency group
  (`publish-dumps`, `cancel-in-progress: false`). At most one of the two workflows ever runs at a
  time on this repo; whichever fires while the other is in flight queues instead of overlapping,
  so there is never a second writer touching the store cache or the data repo concurrently.
- **The rsync.** `sync-fast.yml`'s push step rsyncs **without** `--delete`, so a fast-lane run can
  only add or update files, never remove one — unlike `publish-dumps.yml`'s daily rsync, which
  intentionally does use `--delete` to retire files the export layout no longer produces. It also
  excludes `manifest.json` outright: `docket export --dataset ... --no-snapshot` still writes a
  manifest (it's built from a whole-store freshness report regardless of `--dataset`, see
  `buildManifest` in `packages/core/src/export/writer.ts`), but with `--no-snapshot` that
  manifest's `snapshots` listing comes back empty for _every_ dataset, not just the two the fast
  lane touches. Pushing it would clobber the accurate listing the daily publish just wrote for
  every other dataset, so the fast lane leaves `manifest.json` alone entirely and lets
  `publish-dumps.yml` keep owning it.

The store cache family (`docket-store-v1-`) is shared too: both workflows restore by the same
key prefix, so whichever ran most recently is what the other picks up next, and watermarks
advance continuously across both instead of drifting apart in two separate stores.

## Parquet siblings

`publish-dumps.yml` writes a `.parquet` sibling next to every `snapshot*.json.gz` file (the
per-year shards and, for small datasets, the combined `snapshot.json.gz`) via
`scripts/make-parquet.mjs`, run right after the `Export` step. The conversion uses DuckDB's
`read_json` reader piped into `COPY ... TO ... (FORMAT PARQUET)`.

DuckDB is never a project dependency — nothing changes in `package.json` or `pnpm-lock.yaml`. The
workflow installs the `duckdb` npm package ephemerally, immediately before the one script that
needs it (`npm i --no-save duckdb`). That package ships no CLI (`npm view duckdb bin` prints
nothing; `main` is `./lib/duckdb.js`), so the script drives it programmatically through its Node
API rather than shelling out to a nonexistent `npx duckdb` shell.

This step can never break a publish. `make-parquet.mjs` degrades gracefully at two levels: if the
`duckdb` package isn't importable — the `npm i` above was skipped, failed, or the runner's
platform has no matching prebuilt binary — it logs a clear line and exits 0 without attempting
any conversion; if one particular file fails to convert, that file is logged and skipped while
the rest still proceed. `ci.yml` smoke-tests both the empty-directory and the
duckdb-not-installed cases directly (duckdb is never installed in CI).

Column types in the Parquet files come from DuckDB's own JSON type inference, not from the zod
schemas in `packages/core/src/schema/`. The JSON stays the canonical, exact representation of a
dataset; the Parquet files are a best-effort, schema-inferred convenience mirror of it for
columnar tooling (DuckDB, pandas, polars, ...).

## Mirroring to Hugging Face (and Kaggle)

`mirror-hf.yml` runs weekly and pushes a full copy of the data repo onto a Hugging Face dataset
repo, for consumers who prefer `datasets.load_dataset(...)` or browsing the HF Hub over cloning
GitHub. GitHub (`LuxAlgo/docket-data`) stays the source of truth; the mirror is a convenience
copy, not a second writer to anything in this repo.

Needs `DOCKET_DATA_REPO` + `DOCKET_DATA_TOKEN` (to read the data repo, same as
`publish-dumps.yml`) and the new `HF_DATASET_REPO` + `HF_TOKEN` (to push it onward). Without
either the data-repo or the HF-repo variable the job is skipped entirely; without either token it
logs that it's skipping the push and ends green.

**Bootstrapping:** create the target dataset repo on Hugging Face first
(`huggingface.co/new-dataset`) and grant a token write access — this workflow only ever pushes
commits to an existing repo, it never creates one.

**Keeping the token out of logs.** Hugging Face documents git-over-https access as
`https://user:$HF_TOKEN@huggingface.co/datasets/{repo}`. That form works, but embeds the token in
a URL that git repeats verbatim in its own error/verbose output and that would get written into
the mirror checkout's `.git/config` on disk for the rest of the job. `mirror-hf.yml` instead
passes the same credential as a one-shot `-c http.extraHeader="Authorization: Basic ..."` on each
git invocation — wire-equivalent (HTTP Basic Auth either way; the URL form is just client-side
sugar for the same header), but the token is never written to disk, never part of a URL git might
echo back, and only ever lives in an env var populated straight from the secret.

**Kaggle** is not mirrored automatically — Kaggle dataset versions are managed through the
`kaggle` CLI/API rather than plain git, which doesn't fit this repo's git-only mirroring approach
without a new dependency. To publish a Kaggle mirror by hand:

1. `pip install kaggle` and place an API token at `~/.kaggle/kaggle.json` (from Kaggle account
   settings).
2. Clone `LuxAlgo/docket-data` (or download a release of it).
3. Create the dataset once with `kaggle datasets create -p <path>` (needs a `dataset-metadata.json`
   describing title/license/id — CC0, matching the data repo's `LICENSE`), then push updates with
   `kaggle datasets version -p <path> -m "<message>"`.

## Canary statuses and the response playbook

`docket canary` probes every source and derives a status per source
(`deriveCanaryStatus` in `packages/core/src/sources/types.ts`):

| Status  | Meaning                                                                                                                                                      | Health-board badge      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `green` | Every check passed: fetch probe, parse-success rate (≥ 99%), format fingerprint, freshness.                                                                  | 🟢 healthy              |
| `amber` | Only **soft** checks failed — typically freshness (data older than its window) or a skipped probe (e.g. EDGAR without `DOCKET_CONTACT`). Working, but stale. | 🟡 stale                |
| `red`   | A **hard** check failed: fetch broke, parse rate collapsed, the format fingerprint changed, or the canary itself threw.                                      | 🔴 broken               |
| `skip`  | The source's ingestor is not implemented yet; it canaries as skip on purpose.                                                                                | 🚧 ingestor in progress |

The overall report status is the worst source status; the CLI exits 1 **only on red** (amber
and skip exit 0), so CI pages on breakage, not on quiet news days.

Responses:

- **Red, `fetch-*` check** — the endpoint moved, errored, or nothing was published for days.
  Check the source's own status page/URL by hand; if the URL scheme changed, fix the client and
  the notes in `docs/sources/`.
- **Red, `parse-success-rate`** — documents are arriving that the parser can't handle. Pull a
  failing document (the canary issue links the run and report), add it as a golden fixture with
  hand-verified expected output, fix the parser, keep every existing golden passing.
- **Red, `fingerprint`** — the source changed its format. See the next section; do not silence
  the canary.
- **Amber, `freshness-*`** — the dataset is older than its freshness window. Often self-heals
  (quarterly filing lulls are why 13F/lobbying windows are long); investigate if the sync logs
  show errors or watermarks stopped advancing.
- **Skip** — nothing to do; that's an unimplemented ingestor being honest.

### Fingerprint failures, precisely

The mechanism, as implemented:

- A fingerprint is a 16-hex-character SHA-256 prefix of a **structural** feature of the source's
  format, stored in the `fingerprints` table of the store DB, keyed by `(source, key)`:
  - `edgar` / `daily-index.header` — hash of the first two header lines of the daily master
    index (`parseMasterIndex`).
  - `finra` / `shortvol.header` — hash of the daily file's header line
    (`parseShortVolumeFile`).
- **Baselines record on first sight.** When the canary finds no stored fingerprint, it stores
  the currently observed hash and the check passes with the note "baseline recorded".
- On later runs the canary compares the live hash against the stored one; a mismatch is a
  **hard** failure (red) with a note like "daily-index header format changed".
- **Sync also rewrites fingerprints.** Every successful EDGAR index parse and every FINRA daily
  file whose header line is recognized calls `setFingerprint` with the fresh hash. So a
  mismatch that persists means the parser can no longer recognize the format (or sync isn't
  running against that store) — exactly the situation that deserves a red.

The fix, in order:

1. **Fix the parser first.** Capture the changed document as a golden fixture with
   hand-verified expected output; make the parser handle it (and everything it already
   handled).
2. **Refresh the stored baseline.** There is no CLI command for this; the options that exist:
   - Run a sync against the same store with the fixed parser — when it parses the new format,
     it rewrites the fingerprint row itself (this is what normally heals the cached publish
     store after a fix ships).
   - Clear the stored row directly, so the next canary re-baselines ("baseline recorded"):
     `sqlite3 publish.db "DELETE FROM fingerprints WHERE source='finra' AND key='shortvol.header';"`
   - Reset the store DB entirely (delete the file / evict the cache) — the next run
     re-baselines everything, at the cost of watermarks and canary history in that store, so
     prefer the narrower options.

Where those stores live in CI:

- `canaries.yml` builds a throwaway `canary.db` fresh every run (the shallow sync seeds it), so
  its fingerprints re-baseline within each run.
- `publish-dumps.yml` persists `publish.db` in the Actions cache under keys prefixed
  `docket-store-v1-` (restored by prefix, saved per run — even when a later step fails). To
  reset it, delete those entries under **Actions → Caches** or bump the key prefix in the
  workflow; the next sync then re-backfills from scratch.

## How `docket canary` integrates with CI

- `docket canary --db <store> --out canary-report.json --json` writes the full JSON report to
  a file **and** prints it; the process exit code is `1` when the overall status is red,
  `0` otherwise (green, amber, skip).
- `canaries.yml` runs it with `set +e`, captures the exit code into a step output, and always
  uploads `canary-report.json` as the `canary-report` artifact (30-day retention).
- On a non-zero exit it opens an issue labeled `canary` — or comments on the open one — with a
  per-source list of every check (❌/✅, each with its note) plus a footnote naming sources
  that are amber at the same time. The run then fails so the breakage is visible in the Actions
  tab too.
- Closing the `canary` issue is the operator's acknowledgment; the next red run opens a fresh
  one. The `source-drift` issue template is for humans reporting the same class of problem.

## The health board

The README's board between the `HEALTH-BOARD` markers is generated, never hand-edited:
`scripts/update-health-board.mjs <report> <readme> [out]` rewrites the marked block from a
canary report. With two arguments it rewrites the file in place — that's what
`publish-dumps.yml` does daily before committing README.md with `[skip ci]`. The optional third
argument writes the result to a different path; CI's smoke test uses it (plus a copy of the
README as input) so the real README is never touched by CI.

## Releasing to npm

`release.yml` is manual only. It takes a `dist_tag` input (default `latest`), runs the full
gate (frozen-lockfile install, build, lint, test) and then
`pnpm publish -r --access public --no-git-checks --provenance --tag <dist_tag>` with
`NODE_AUTH_TOKEN`. The workflow requests `id-token: write` so npm records provenance
attestations linking the packages to the exact commit and run that built them. Version bumps
happen in the package.json files before dispatching; without `NPM_TOKEN` the run is a green
no-op.
