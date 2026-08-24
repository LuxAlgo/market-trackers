# Operations runbook

How the GitHub Actions machinery behaves, what configures it, and what to do when the board
goes red. The audience is the person operating a deployment of
[LuxAlgo/docket](https://github.com/LuxAlgo/docket) — including a fork with none of it
configured yet: every workflow is a safe no-op until its variables and secrets exist.

## Workflows at a glance

| Workflow            | Trigger                       | Needs                                                     | Without configuration                                                         |
| ------------------- | ----------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ci.yml`            | push to `main`, pull requests | nothing                                                   | fully functional (offline tests, no keys)                                     |
| `canaries.yml`      | daily cron, manual            | `DOCKET_CONTACT` (optional)                               | runs keyless; the EDGAR probe reports the gap and shows amber                 |
| `publish-dumps.yml` | daily cron, manual            | `DOCKET_DATA_REPO`, `DOCKET_DATA_TOKEN`, `DOCKET_CONTACT` | job skipped without the repo var; builds but does not push without the token  |
| `release.yml`       | manual (`workflow_dispatch`)  | `NPM_TOKEN`                                               | ends successfully after logging "NPM_TOKEN not configured; skipping publish." |

All workflows keep `permissions:` minimal, never print secrets, and pass secrets only through
env vars (`DOCKET_DATA_TOKEN` to checkout/push, `NPM_TOKEN` as `NODE_AUTH_TOKEN`).

## Repository variables and secrets

Set variables under **Settings → Secrets and variables → Actions → Variables**, secrets under
**… → Secrets**.

| Name                | Kind     | What it enables                                                                                                                       | What stays off without it                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DOCKET_CONTACT`    | variable | The contact email the SEC's fair-access policy requires in the EDGAR User-Agent. Enables EDGAR sync in canaries and publishing.       | EDGAR sync is skipped; the EDGAR canary soft-fails with "skipped: no contact email…" and shows amber.     |
| `DOCKET_DATA_REPO`  | variable | The target data repository, e.g. `LuxAlgo/docket-data`. Gates the whole publish job.                                                  | `publish-dumps.yml` is skipped entirely — no sync, no export, no health-board commit.                     |
| `DOCKET_DATA_TOKEN` | secret   | Push access to the data repo. Enables checkout of the data repo, the first-publish README/LICENSE bootstrap, and the daily data push. | Dumps are still built (and the store cache still accumulates), but nothing is pushed; a log line says so. |
| `NPM_TOKEN`         | secret   | Publishing `@luxalgo/docket-core`, `@luxalgo/docket-mcp`, `@luxalgo/docket-cli` to npm via `release.yml`.                             | The release run ends green after "NPM_TOKEN not configured; skipping publish." Nothing is published.      |

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
   - rsyncs the dumps (`--delete`, excluding `.git`, `README.md`, `LICENSE`) and pushes as
     `docket-publish[bot]`,
   - refreshes the health board in this repo's README (committed with `[skip ci]`).

Day-to-day, the only writer to the data repo is this workflow. Human PRs to data files there
are closed; fixes belong in this repo's parsers and fixtures.

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
