# ADR 0006 — Model routing, batching, and why tests never call the API

**Status:** accepted · **Date:** 2026-08-10

## Context

Anthropic is the production provider, chosen deliberately. Two things follow
that need deciding: how to keep ~1 100 chapters affordable, and what the test
suite runs against.

The second is not a detail. The eight anti-spoiler tests are **blocking** — CI
fails if any of them fails. A blocking test that calls a live, non-deterministic,
paid API is a test that will eventually fail for reasons unrelated to the code,
and will then be marked flaky and skipped. At which point the product's central
guarantee is unverified.

## Decision — one interface, three implementations

`ModelProvider` exposes `describePanels`, `extractEntities`, `extractEvents`,
`resolveCandidates`, `summarize`, `embed`, `answer`.

| Implementation | Used by | Notes |
|---|---|---|
| `AnthropicProvider` | **production default** | reads `ANTHROPIC_API_KEY` |
| `ReplayProvider` | **all of CI** | replays recorded responses keyed by `hash(model, system, messages, schema)`; hermetic, free, deterministic. Recorded with `RECORD=1` when a key is present. |
| `SyntheticProvider` | no-key fallback | derives extractions from the fixture generator's ground truth so the walkthrough runs without a key, behind an explicit UI banner |

Recorded fixtures are committed. When a prompt changes, its hash changes, the
replay misses, and CI fails loudly — which is the correct signal: a changed
prompt needs a re-record and a re-read of what the model now produces.

## Decision — cost

Model routing by task difficulty:

| Stage | Model | $/MTok in / out |
|---|---|---|
| Page-type, language, reading-order classification | `claude-haiku-4-5` | 1 / 5 |
| Panel description, transcription assist, entity/event/relation extraction | `claude-sonnet-5` | 3 / 15 (intro 2 / 10 until 2026-08-31) |
| Ambiguous panels, doubtful identity resolution, contradiction adjudication | `claude-opus-5` | 5 / 25 |

Four levers, all implemented in phase 2:

1. **Message Batches API — 50% off.** Import is asynchronous by design; nobody
   is watching the screen. Bulk panel extraction is therefore batched by
   default, with an "interactive priority" toggle for a single urgent chapter.
2. **Prompt caching, 1h TTL.** System prompt + ontology + already-validated
   entity shortlist is a stable prefix shared by ~100 panel calls per chapter.
   Writes cost 2×, reads 0.1×, so it pays from the third call.
   **Non-obvious trap:** parallel requests cannot read a cache entry that is
   still being written, and a batch is maximally parallel. The prefix is
   therefore pre-warmed with a `max_tokens: 0` request before the batch is
   submitted.
3. **Conditional escalation.** Opus 5 is called only for panels whose Sonnet
   confidence is below threshold — expected 5–15%.
4. **Step memoisation by `input_hash`.** Replaying an unchanged step is free.

**Estimation, not guesswork.** The import wizard shows a cost estimate produced
by a real `countTokens()` call (free) against the actual assembled prompts, never
a hard-coded constant. Actual observed cost is recorded per step in
`ingestion_steps.cost_cents`. Order of magnitude on ~18 pages / ~100 panels with
images downscaled to ~1568px: **≈ $0.08–0.25 per chapter** with batch + cache.

## API details this codebase must respect

- `output_config.format` with a JSON Schema — not the deprecated
  `output_format`. Schemas must be non-recursive with
  `additionalProperties: false`; length constraints are validated client-side
  with Zod because the API schema subset does not support them.
- No `temperature` / `top_p` / `top_k` on Opus 5 or Sonnet 5 — they 400.
- Thinking is **on by default** on Opus 5; `max_tokens` caps thinking plus
  response text together, so it must be sized generously.
- Check `stop_reason === 'refusal'` before reading `content`.
- `effort` is set per stage: `low` for classification, `high` for adjudication.

## Consequences

**Good.** CI is fast, free and deterministic, so the blocking tests stay
blocking. Production quality is not compromised to achieve that.

**Cost.** Recorded fixtures must be refreshed when prompts change, and a stale
recording is a CI failure rather than a silent divergence. This is the intended
trade.

**Cost.** Batching adds latency — minutes, occasionally up to an hour. Acceptable
because the import UX is notification-driven, and escapable via the toggle.
