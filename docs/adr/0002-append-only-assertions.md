# ADR 0002 — Knowledge is append-only assertions, not columns

**Status:** accepted · **Date:** 2026-08-10

## Context

The tempting model is a normal domain schema: `characters.true_name`,
`characters.crew_id`, `characters.is_alive`. It is comfortable and completely
wrong for this product.

One Piece reveals information out of order. A name is a placeholder for two
hundred chapters, then becomes an alias when the true name lands. An affiliation
is hidden, then revealed to have been true all along. A character is believed
dead, then is not. A column can hold *one* of those states; the product needs
all of them, each stamped with when the reader could know it and what page
proves it.

Worse, a mutable column destroys the past. Updating `true_name` at chapter 50
makes the chapter-49 view unreproducible — the old value is simply gone.

## Decision

Knowledge is stored as **append-only assertions**. Nothing is ever updated in
place, nothing is ever deleted.

An assertion carries subject, predicate, object (entity or value), and:

| Field | Meaning |
|---|---|
| `knowledge_from_chapter` | first chapter at which the reader can know this |
| `knowledge_until_chapter` | chapter from which this belief is superseded (`NULL` = still held) |
| `story_valid_from` / `story_valid_until` | in-world validity, deliberately fuzzy (jsonb) |
| `observed_in_chapter` | the chapter whose pages provide the evidence |
| `confidence` | 0–1 |
| `epistemic_status` | explicit · inferred_strong · hypothetical · contradicted · refuted · user_validated |
| `review_status` | proposed · accepted · rejected · deferred · superseded |
| `proposed_by` | `ai` or `user` |
| `pipeline_version`, `model_id`, `prompt_version` | reproducibility of an AI proposal |
| `superseded_by` | the assertion that replaced this one |
| `locked` | user-authored; never superseded by the AI |

The two time axes are separate on purpose. `story_valid_*` answers "when was
this true in the world"; `knowledge_*` answers "when could the reader know".
A flashback in chapter 400 depicting an event before chapter 1 has an early
`story_valid_from` and a late `knowledge_from_chapter`. Collapsing them into
one column is the single most common way this product could fail.

A correction inserts a new row and points the old one's `superseded_by` at it.
The history is the audit trail; there is nothing else to keep.

**Identity merges are assertions too.** Discovering that two entities are the
same person is a `same_as` assertion with its own reveal chapter, not a
destructive merge. Projection runs a union-find over the `same_as` assertions
visible at the boundary — so chapter 20 sees two nodes and chapter 300 sees
one, from the same rows. Undoing a merge is rejecting an assertion.

## Consequences

**Good.** Any past view is reconstructible exactly. "Why are these two nodes
connected?" always has an answer: the assertions and their evidence. Merges are
reversible for free. Human corrections are durable because they are rows, not
overwrites.

**Cost.** Every read is a projection, not a `SELECT *`. Entity display names,
current affiliations and "is X alive" are all computed at the boundary rather
than read off a column.

**Cost.** The table grows monotonically. Expected order of magnitude is
hundreds of thousands of rows over the full work — comfortably within Postgres
with the right indexes, but it does mean the projection queries need care and
a per-`(user, boundary, graph_version)` cache.

**Cost.** Contributors used to CRUD schemas will reach for `UPDATE`. The
schema grants no `UPDATE` on `assertions` to the application role, so the
mistake fails loudly rather than corrupting history.
