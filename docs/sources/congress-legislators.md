# Source: congress-legislators committee assignments (`congress-legislators`)

**Datasets:** `committee-assignments`
**Status:** implemented (`sources/congress-legislators/`)
**Auth:** none. Public-domain dataset maintained by the unitedstates project.

## Endpoints

- `https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committees-current.yaml`
  — committee metadata: type (house/senate/joint), name, `thomas_id`, subcommittees.
- `…/committee-membership-current.yaml` — membership keyed by committee `thomas_id`
  ("SSAS") or committee+subcommittee id ("SSAS14"); entries carry name, rank, optional
  title, bioguide id, and — on joint committees — an explicit `chamber`.
- The same repository's legislators files already power `resolve/members.ts` — note those
  are the **generated JSON** files, which upstream publishes only on its `gh-pages` branch
  (fetching them from `main` 404s, verified live); the YAML endpoints above live on `main`.

## Semantics — a current-state dataset

This is the deliberate exception to append-only ingestion: each sync **replaces the table
wholesale** (`store.replaceDataset`, one transaction), so a member who leaves a committee
actually disappears. Daily dump deltas still record what was current on each ingestion day;
the snapshot reflects the present.

Member chamber resolution: the entry's own `chamber` field → the committee's type (house/
senate) → the cached member map (joint committees) → otherwise the entry is skipped and
counted against the parse rate, never guessed.

## Why this dataset exists

`congress-trades` rows carry bioguide ids. Joining them to committee seats is what turns
"a senator bought a defense stock" into "a member of the Armed Services Committee bought a
defense stock" — with both facts cited to their public records. The MCP tools
`alt_data_member_profile` and `alt_data_committees` serve exactly that join; interpretation is
left to the reader.

## Canary

Both YAML files fetch and parse with rows > 0 (hard) · parse rate ≥ 95% (hard; joint members
without chamber hints resolve via the member map during real syncs) · structural fingerprint
of both files' entry shapes (hard) · freshness within 45 days (soft — assignments change on
congressional timescales).

## Fixtures

`fixtures/congress-legislators/case-current/` — a **real** subset of both files (HSIF with two
subcommittees, SSAS with two subcommittees, and the JCSE joint commission), fetched from the
primary source and kept verbatim. `meta.json` marks it `synthetic: false`.
