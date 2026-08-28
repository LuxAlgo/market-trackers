# Contributing to LuxAlgo Market Trackers

## Setup

```bash
pnpm install
pnpm build          # tsc project references: core → mcp → cli
pnpm test           # vitest, fully offline — no network, no keys
pnpm lint
pnpm check          # everything CI runs
```

Node ≥ 20.9, pnpm 10. Tests must run **offline**: every parser test is fixture-driven and every
source test mocks `fetchImpl`. Nothing in the test suite may touch a live endpoint.

## The rules that don't bend

1. **Primary sources only.** Never scrape a commercial data product.
2. **Ranges stay ranges.** Parsers never fabricate precision that isn't in the document.
3. **No signals, scores, or predictions.** Data with receipts, full stop.
4. **Every row carries provenance** with a working primary-source URL.
5. **EDGAR ≤ 10 req/s with a declared User-Agent** — enforced by `RateLimiter`, proven by a unit
   test, never bypassed.
6. **No telemetry.** Nothing in this codebase may phone home.

## Golden files (the crown jewels)

Parsers are tested against `packages/core/fixtures/`: each case is a raw primary document
(`input.*`), the exact expected output (`expected.json`), and a `meta.json` with the document's
source URL and verification status.

- Parser changes must keep every golden passing.
- Found a document that breaks a parser? That's a gift: add it as a new case **with hand-verified
  expected output**, then fix the parser. The corpus only grows.
- Real primary-source documents are preferred; synthetic cases (marked `"synthetic": true`) exist
  so the suite bootstraps offline and should be augmented with real ones over time.
- Rows produced with `confidence < 1` (layout parsing, OCR/LLM-assisted extraction) must set
  honest confidence tiers and `needsReview` where warranted.

## Adding or extending a source

Each source lives in `packages/core/src/sources/<source-id>/` and implements the `TrackerSource`
contract (`sync` + `canary`) from `sources/types.ts`. The registry, CLI, sync engine, canaries,
status output, and health board pick it up automatically. A complete source ships:

1. A client that is **polite by construction** — shared `RateLimiter`, declared User-Agent,
   backoff on 403/429 (see `sources/edgar/client.ts`).
2. Parsers with golden-file coverage, including the ugliest documents you can find.
3. Idempotent ingestion by natural key + a per-source watermark (incremental by default,
   `--full` re-walks).
4. A canary: fetch probe, parse-success-rate assertion (≥ 99%), a structural fingerprint of the
   format, and dataset freshness.
5. Implementation notes in `docs/sources/<source-id>.md` — including quirks you learned the hard
   way.

Schema changes start in `packages/core/src/schema/` (zod is the source of truth), then flatten
through `store/rows.ts` and `store/table-specs.ts`. The parity tests in `store/parity.test.ts`
fail until all three agree — that's them doing their job. A changed published record shape bumps
`SCHEMA_VERSION`.

## Style

- TypeScript strict; kebab-case file names; ESM throughout.
- zod validation at every boundary — data enters and leaves the store validated.
- Comments explain constraints ("values are in thousands before 2023"), not narration.
- Keep changes scoped; prefer small local edits over sweeping rewrites.

## Sign your commits (DCO)

Every commit on a pull request must carry a
[Developer Certificate of Origin](https://developercertificate.org/) sign-off — pass `-s` to
`git commit`, which appends `Signed-off-by: Your Name <you@example.com>`. It certifies you have
the right to contribute the change under this repository's MIT license. CI rejects PRs with
unsigned commits; `git rebase --signoff` fixes a branch retroactively.

## Operations

CI, the daily canaries, dump publishing, and releases are documented in
[`docs/operations.md`](docs/operations.md) — including every repository variable/secret and
what stays off without it. The contract of the published dumps (layout, delta semantics,
manifest, `SCHEMA_VERSION` policy) is in [`docs/market-trackers-data.md`](docs/market-trackers-data.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.
