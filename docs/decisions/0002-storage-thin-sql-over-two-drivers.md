# ADR 0002 — storage: one thin SQL layer over SQLite and Postgres

**Status:** accepted

Requirement: SQLite by default (zero-setup local files, `npx`-friendly), Postgres optional,
switched by **one flag** — with identical behavior.

Decision: no ORM. The store speaks one portable SQL dialect through a ~150-line `SqlDriver`
seam (`store/sql-driver.ts`):

- `?` placeholders, rewritten to `$n` for Postgres.
- `INSERT … ON CONFLICT (pk) DO UPDATE SET col = excluded.col` — identical upsert syntax on
  both engines; upserts are generated from the table specs.
- Case-insensitive matching via `lower(col) LIKE ?` (portable, unlike ILIKE).
- Type mapping handled at the seam (booleans ↔ 0/1 on SQLite; JSON as TEXT on both).
- Migrations are versioned, idempotent, and **generated from the table specs** for both dialects
  (`store/migrate.ts`), recorded in `schema_migrations`; opening a store always migrates, so a
  fresh `docket sync` needs zero setup.

Why not an ORM: every dual-dialect ORM route required either duplicated per-dialect table
definitions or dialect-generic type gymnastics — more code and more drift surface than the SQL
it would generate, for a store with a dozen tables and deliberately simple queries. The parity
tests (ADR 0001) give us the safety an ORM's types would have, anchored to the zod source of
truth instead.

Consequence for consumers: `@luxalgo/docket-core` exposes a typed query layer
(`store/queries.ts`) — callers never see SQL or the driver seam.
