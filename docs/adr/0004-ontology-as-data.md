# ADR 0004 — The ontology lives in data, not in the schema

**Status:** accepted · **Date:** 2026-08-10

## Context

The obvious modelling of "character belongs to crew" is a foreign key, and of
"relation types" is a PostgreSQL enum. Both bake the ontology into DDL.

One Piece will not hold still for that. New relation kinds appear constantly —
`is_bound_by_oath_to`, `inherits_will_of`, `is_a_manifestation_of` — and the
user is explicitly allowed to invent predicates. If every new predicate is a
migration, the ontology stops growing at the speed of the reading and starts
growing at the speed of deployments.

Postgres enums are also awkward to evolve: adding a value is easy, removing or
renaming one is not, and `ALTER TYPE ... ADD VALUE` cannot run inside a
transaction block alongside the rest of a migration.

## Decision

Node types and predicates are **rows**, in `node_types` and `predicates`,
seeded from a TypeScript definition that stays the source of truth for the
built-in set.

`predicates` carries the semantics the engine needs:

| Column | Purpose |
|---|---|
| `key` | stable identifier, e.g. `member_of` |
| `label_fr` | French display label |
| `directed` | whether direction is meaningful |
| `symmetric` | whether A→B implies B→A |
| `inverse_key` | the reciprocal predicate, when one exists |
| `subject_types` / `object_types` | allowed node types, for validation and for constraining model output |
| `is_identity` | `same_as` / `maybe_same_as` drive the union-find |
| `requires_explicit_review` | forces human review regardless of confidence |
| `builtin` | distinguishes seeded predicates from user-created ones |

`assertions.predicate` is a text column with a foreign key to `predicates.key`.
Adding a predicate is an `INSERT`.

`requires_explicit_review` is where the anti-spoiler policy meets the ontology:
identity claims, reveals, deaths, hidden affiliations, contradictions and
mystery resolutions carry the flag, so they can never be swept up by a bulk
"accept all high-confidence proposals" action.

## Consequences

**Good.** A custom predicate needs no migration and no deploy. The set of legal
predicates can be injected into the extraction JSON Schema at runtime, which
keeps model output aligned with the ontology automatically.

**Good.** Ontology changes are user data, so they are covered by the same
export, backup and audit-log machinery as everything else.

**Cost.** The database cannot enforce predicate validity with an enum, so a
trigger validates `subject_types` / `object_types` on insert. That is a little
slower and a little more code than a type check.

**Cost.** No compile-time exhaustiveness over predicates in TypeScript. The
built-in set is mirrored as a const object so the common cases keep their
types; genuinely dynamic predicates are handled as strings.
