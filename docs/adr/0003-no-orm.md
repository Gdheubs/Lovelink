# ADR 0003 — Raw SQL and hand-written migrations, no ORM

**Status:** accepted · **Date:** 2026-08-21

## Context

The repositories need to read and write Postgres. The default choice is an ORM
(Prisma, TypeORM) or a query builder with schema generation.

## Decision

Raw SQL inside the Postgres adapter, mapping rows to domain entities at the
boundary. Migrations are hand-written numbered `.sql` files run by a small
in-repo runner.

## Rationale

1. **An ORM entangles with domain types.** Its generated model classes want to
   _be_ your entities. Once they are, the domain imports the ORM and ring 1 is
   gone — the exact failure ADR 0001 exists to prevent.
2. **The schema is the most durable artifact in the product.** It deserves
   deliberate SQL with comments explaining every index, not generated DDL nobody
   reviewed.
3. **Our queries are not generic.** `haveSharedRoomSession` is an interval
   overlap; the moderation queue is an urgent-first ordering; surprise
   redemption is a conditional `UPDATE ... WHERE opened_at IS NULL RETURNING`.
   Each is clearer as SQL than as an ORM incantation, and their performance is
   visible rather than emergent.
4. **A migration tool is about 180 lines.** "Run these files in order, once
   each, in a transaction, and remember which ran" is small enough to audit —
   and we add the parts tools often omit: a per-file checksum that refuses
   edited-after-apply migrations, and an advisory lock so concurrent instances
   cannot race.

## Consequences

- More typing per query, and no compile-time check that a column exists.
  Mitigated by the mapping being confined to the adapter and covered by
  integration tests.
- No automatic migration generation — schema changes are deliberate. This is a
  feature for a schema carrying safety-critical constraints.
- `pg` is still a dependency, but only inside `/src/adapters/postgres`.
