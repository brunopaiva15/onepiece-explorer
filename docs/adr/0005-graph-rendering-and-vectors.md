# ADR 0005 — Sigma.js for the graph, and an abstracted vector store

**Status:** accepted · **Date:** 2026-08-10

## Two related infrastructure choices, recorded together.

---

## Graph rendering: Sigma.js v3 + graphology

**Context.** The target is the full work: on the order of 20 000 nodes and
150 000 edges after ~1 100 chapters. The realistic candidates were Cytoscape.js,
React Flow (`@xyflow/react`) and Sigma.js.

**Decision.** Sigma.js v3 with graphology.

Cytoscape has the richer styling model and nicer built-in interactions, but its
default renderer is Canvas-2D and it starts dropping frames in the low
thousands of nodes. React Flow is excellent for curated node-editor UIs and
wrong for this: it renders DOM nodes, which is a non-starter at this scale.

Sigma renders through WebGL, and graphology brings the algorithms this product
actually needs already implemented and tested — ForceAtlas2 for layout, Louvain
for community detection (used for arc/faction grouping), and Dijkstra for the
"shortest path between two entities" feature. Layout and community detection
both run in a Web Worker so the main thread stays responsive.

**Consequences.** Styling is more constrained than Cytoscape: node rendering is
shader-based, so custom node shapes need a custom renderer program. Accepted —
the art direction is deliberately restrained. The performance budget is
measured from phase 3 against a synthetic 8 000-node / 60 000-edge graph rather
than discovered at the end.

An accessible table view at `/graph/table` is a first-class requirement, not a
fallback: it applies the identical boundary filtering, and it is the only way
to use the graph without WebGL or a pointing device.

---

## Vector store: an adapter, with pgvector as the real implementation

**Context.** Supabase ships pgvector. The local PostgreSQL 16 used by CI does
not have it packaged, and Docker is unavailable in the target dev container, so
`supabase start` cannot provide one either.

**Decision.** A `VectorStore` interface with two implementations:

- `PgVectorStore` — pgvector, used on Supabase in development and production.
- `PgArrayVectorStore` — `real[]` with cosine similarity computed in SQL, used
  by the local test database.

`embeddings` rows carry `model_id` and `dimensions`, so a change of embedding
model is a new row set rather than a silent corruption of an existing index.

**Consequences.** The abstraction is genuinely load-bearing rather than
speculative: both implementations run on every CI run and every dev session
respectively, so neither can rot.

The array fallback is O(n) per query with no index. At test-fixture scale
(hundreds of rows) this is irrelevant; it would not be acceptable in
production, which is why production is pgvector and why the semantic-search
performance budget is only ever measured against pgvector.
