# ADR 0001 — zod schemas are the source of truth

**Status:** accepted

Every dataset's record shape is defined once, as a zod schema in
`packages/core/src/schema/`. Storage rows, dump files, and MCP payloads all derive from it.

- Parsers construct records and validate them through the schema before returning.
- The store validates again on upsert (nothing enters the database the published schema doesn't
  describe) and mappers re-validate on the way out in tests.
- Table specs (`store/table-specs.ts`) and row mappers (`store/rows.ts`) flatten the schemas for
  SQL; the **parity tests** (`store/parity.test.ts`) fail the build if schema, mapper, spec, or
  generated DDL drift apart.
- Published record shapes are versioned by `SCHEMA_VERSION`, recorded in every dump manifest.

Consequence: adding a field is a four-file change (schema, mapper, spec, migration) and the test
suite enforces that all four happen. That friction is the feature — silent shape drift is how
data projects rot.

Also decided here: **provenance is part of every schema**, not an add-on. A record without a
working primary-source URL is invalid by construction, and disclosed ranges are modeled as
ranges (`min`/`max`/verbatim `text`) — the schema has no field a midpoint could live in.
