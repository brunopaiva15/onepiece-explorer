import { z } from 'zod'

/**
 * What a model is allowed to return.
 *
 * Every schema here is closed — `additionalProperties: false` once converted —
 * and every identifier field is a plain string that the caller then checks
 * against a whitelist it built itself. That second step is the one that
 * matters: a JSON Schema can force the *shape* of an answer but not its
 * truthfulness, so a model can and will invent a panel id that is perfectly
 * well-formed. The enumeration lives in code (see anchoring.ts), not in the
 * schema, because the whitelist is per-request and a schema large enough to
 * enumerate a hundred panel ids would eat the prompt cache.
 *
 * Schemas are non-recursive on purpose: the API rejects recursive schemas, and
 * a nested structure would in any case be harder to anchor claim by claim.
 */

/** Text as it appears on the page, transcribed rather than interpreted. */
export const transcriptionSchema = z.object({
  blocks: z
    .array(
      z.object({
        /** Which detected panel this text sits in, or "hors_case". */
        panel_ref: z.string(),
        /** Verbatim. No translation, no correction, no completion. */
        text: z.string(),
        kind: z.enum(['bubble', 'caption', 'sfx', 'sign', 'thought', 'other']),
        /** The model's own confidence, used to decide on escalation. */
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(80),
})

export type Transcription = z.infer<typeof transcriptionSchema>

/**
 * A factual description of what is drawn in one panel.
 *
 * "Factual" is load-bearing and is why `characters_visible` takes free-text
 * visual descriptors rather than names. At chapter 3 the model must be able to
 * say "a tall figure in a striped scarf" without being able to say "Kaelo",
 * because the name has not been revealed yet — and if it could name them it
 * would name them from training data, not from the page.
 */
/**
 * Budgets, not validation rules — and the distinction cost a chapter.
 *
 * The Messages API does not enforce string length from a JSON Schema; the
 * lengths are checked here, after the answer arrives. So a `.max()` on a
 * free-text field is not a constraint on the model, it is a licence to throw at
 * one: a model that wrote two descriptions of 1 300 characters failed the parse,
 * which failed the batch, which failed the run — a hundred panels lost to
 * verbosity, in a field where verbosity is not even wrong.
 *
 * These are enforced by clamping instead. The prompt states them so the model
 * aims below, and anything over is cut. A truncated visual description loses a
 * clause; a rejected one loses the chapter.
 */
export const DESCRIPTION_BUDGET = {
  description: 1200,
  descriptor: 200,
  setting: 300,
  action: 300,
  descriptors: 12,
  actions: 10,
  panels: 40,
} as const

export const panelDescriptionSchema = z.object({
  panel_ref: z.string(),
  /** What is drawn. Present tense, no narrative interpretation. */
  description: z.string().min(1),
  /** Purely visual descriptors: clothing, silhouette, distinguishing features. */
  characters_visible: z.array(z.string()),
  /** Where it happens, if the art shows it. */
  setting: z.string().nullable(),
  /** Actions depicted, one per entry. */
  actions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

export type PanelDescription = z.infer<typeof panelDescriptionSchema>

export const panelDescriptionsSchema = z.object({
  panels: z.array(panelDescriptionSchema),
})

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
}

/** Bring a model's answer inside the budgets, rather than reject it for missing them. */
export function clampPanelDescriptions(panels: PanelDescription[]): PanelDescription[] {
  return panels.slice(0, DESCRIPTION_BUDGET.panels).map((panel) => ({
    ...panel,
    description: cut(panel.description, DESCRIPTION_BUDGET.description),
    characters_visible: panel.characters_visible
      .slice(0, DESCRIPTION_BUDGET.descriptors)
      .map((d) => cut(d, DESCRIPTION_BUDGET.descriptor)),
    setting: panel.setting === null ? null : cut(panel.setting, DESCRIPTION_BUDGET.setting),
    actions: panel.actions
      .slice(0, DESCRIPTION_BUDGET.actions)
      .map((a) => cut(a, DESCRIPTION_BUDGET.action)),
  }))
}

/**
 * Candidate entities and relations extracted from one chapter.
 *
 * `evidence` is mandatory on every item and is checked mechanically. An item
 * that cites a panel outside the whitelist, or whose excerpt is not a substring
 * of the cited block's real text, goes to quarantine — it never reaches the
 * review queue, let alone the graph. That check is what stops the model
 * answering from what it already knows about One Piece (ADR 0003).
 */
/**
 * Budgets for extraction, enforced the same way as the description ones: stated
 * in the prompt, clamped on arrival, never used to reject an answer.
 *
 * The excerpt budget is where the latency was. An excerpt is *copied* from the
 * source, so every character is an output token, and the ceiling was six
 * hundred. A slice proposing ninety items with quotes that long writes more
 * than the chapter it read — three or four minutes of generation for one call,
 * close enough to the token ceiling that a dense chapter truncates and pays for
 * a retry it did not need.
 *
 * A hundred and eighty characters is a full sentence, which is all an anchor
 * has to be, and shortening one costs nothing: the check is that the excerpt
 * occurs in the passage, and a prefix of a substring is still a substring.
 *
 * Two citations rather than six for the same reason, plus a better one:
 * `firstFailure` requires *every* citation to hold, so a fourth and fifth
 * citation add output length and quarantine risk and no evidential weight.
 */
export const EXTRACTION_BUDGET = {
  excerpt: 180,
  evidencePerItem: 2,
} as const

export const evidenceRefSchema = z.object({
  /** A panel_ref or block_ref from the whitelist supplied in the prompt. */
  ref: z.string(),
  kind: z.enum(['text', 'visual']),
  /**
   * For kind 'text': must occur verbatim in the cited block.
   * For kind 'visual': must match a description produced in this same run.
   *
   * Deliberately generous here, and tight in the prompt. The Messages API does
   * not enforce string length from a JSON Schema, so a snug `.max()` is not a
   * constraint on the model — it is a licence to throw at one, and a single
   * over-long quote would fail the parse and lose the whole slice. The real
   * budget is EXTRACTION_BUDGET.excerpt, stated in the prompt and clamped on
   * arrival.
   */
  excerpt: z.string().max(600),
})

export const candidateEntitySchema = z.object({
  /** Local id, referenced by the relations below. Scoped to this response. */
  local_id: z.string().min(1).max(60),
  node_type: z.string().min(1).max(60),
  /**
   * How the chapter names them *at this point in the story*. A placeholder
   * built from the art ("l'homme au foulard rayé") when no name is given.
   */
  label: z.string().min(1).max(200),
  label_kind: z.enum(['placeholder', 'alias', 'true_name', 'epithet', 'translation']),
  /**
   * The wording the source used, when it differs from `label`.
   *
   * Set when the source is English and the label had to be authored in French.
   * It is what makes a naming decision reusable: the answer is recorded against
   * this term, and the next chapter that contains the same wording gets the
   * settled form handed to it instead of asking again.
   */
  source_term: z.string().max(200).nullable(),
  /**
   * The English form of this entity's name, read off an English parallel text.
   *
   * Only set when the chapter carries a parallel text in English that names
   * this entity — the form is then a fact on screen, copied rather than
   * invented. Null everywhere else: when the source itself is English the
   * wording already sits in `source_term`, and when no English text was
   * supplied there is nothing to copy from. Feeds the English display layer
   * (entity_labels.lang = 'en', glossary english_term); never canonical.
   */
  english_term: z.string().max(200).nullable().optional(),
  /**
   * Whether the model is sure how this should be called in French.
   *
   * False sends the entity to explicit review with an editable name, however
   * high its confidence. The two are different questions: `confidence` is "is
   * this entity really there", this is "do I know what we call it". A model can
   * be certain a ship exists and have no idea whether its name is translated —
   * that is a convention held by the reader, not a fact in the text, and
   * guessing produces a different name each chapter and a graph that silently
   * splits in two.
   */
  naming_confident: z.boolean(),
  evidence: z.array(evidenceRefSchema).min(1).max(6),
  confidence: z.number().min(0).max(1),
})

export const candidateAssertionSchema = z.object({
  /** local_id of a candidate entity, or an existing entity id from the prompt. */
  subject: z.string().min(1).max(60),
  predicate: z.string().min(1).max(80),
  /** local_id, existing entity id, or null for a value-only assertion. */
  object: z.string().max(60).nullable(),
  /** For predicates whose object is a literal rather than an entity. */
  object_value: z.string().max(400).nullable(),
  /**
   * Explicit means stated or shown outright; inferred_strong means it follows
   * from the page without being said. Anything weaker than that belongs in
   * `hypothetical` and will require explicit review.
   */
  epistemic_status: z.enum(['explicit', 'inferred_strong', 'hypothetical']),
  evidence: z.array(evidenceRefSchema).min(1).max(6),
  confidence: z.number().min(0).max(1),
})

export const candidateEventSchema = z.object({
  local_id: z.string().min(1).max(60),
  summary: z.string().min(1).max(400),
  /** Participating entities by local_id or existing id. */
  participants: z.array(z.string().max(60)).max(20),
  /** True when the page presents this as a memory or a recounting. */
  is_flashback: z.boolean(),
  evidence: z.array(evidenceRefSchema).min(1).max(6),
  confidence: z.number().min(0).max(1),
})

export const candidateMysterySchema = z.object({
  /** Phrased as the question the chapter leaves open. */
  question: z.string().min(1).max(400),
  evidence: z.array(evidenceRefSchema).min(1).max(6),
  confidence: z.number().min(0).max(1),
})

export const extractionSchema = z.object({
  entities: z.array(candidateEntitySchema).max(40),
  assertions: z.array(candidateAssertionSchema).max(80),
  events: z.array(candidateEventSchema).max(20),
  mysteries: z.array(candidateMysterySchema).max(10),
})

/**
 * Bring an extraction inside its budgets rather than reject it for missing them.
 *
 * Truncation is safe precisely here and nowhere else in this file: an excerpt is
 * checked by asking whether it occurs inside the cited passage, and a prefix of
 * a substring is still a substring. Note the absence of an ellipsis — `cut()`
 * appends one, which would make the excerpt match nothing at all and quarantine
 * every item it touched.
 */
export function clampExtraction(extraction: Extraction): Extraction {
  const trim = <T extends { evidence: EvidenceRef[] }>(item: T): T => ({
    ...item,
    evidence: item.evidence
      .slice(0, EXTRACTION_BUDGET.evidencePerItem)
      .map((ref) => ({ ...ref, excerpt: ref.excerpt.slice(0, EXTRACTION_BUDGET.excerpt) })),
  })

  return {
    entities: extraction.entities.map(trim),
    assertions: extraction.assertions.map(trim),
    events: extraction.events.map(trim),
    mysteries: extraction.mysteries.map(trim),
  }
}

export type Extraction = z.infer<typeof extractionSchema>
export type CandidateEntity = z.infer<typeof candidateEntitySchema>
export type CandidateAssertion = z.infer<typeof candidateAssertionSchema>
export type CandidateEvent = z.infer<typeof candidateEventSchema>
export type CandidateMystery = z.infer<typeof candidateMysterySchema>
export type EvidenceRef = z.infer<typeof evidenceRefSchema>

/**
 * Whether a newly seen figure is the same as one already in the graph.
 *
 * The model scores and justifies; it never merges. A merge is an assertion
 * dated to the chapter that reveals it, and it always goes through explicit
 * review — the identity predicate is flagged `requiresExplicitReview` for
 * exactly this reason.
 */
export const resolutionSchema = z.object({
  candidates: z
    .array(
      z.object({
        existing_entity_id: z.string().min(1).max(60),
        /** Same person, or merely similar? */
        verdict: z.enum(['same', 'different', 'uncertain']),
        /** Why. Shown verbatim in the review centre. */
        reasoning: z.string().min(1).max(600),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(10),
})

export type Resolution = z.infer<typeof resolutionSchema>

/**
 * A chapter summary where every sentence points at its sources.
 *
 * The pairing is the point: a summary sentence with no assertion behind it is
 * the model narrating from memory, and it is rejected the same way an unanchored
 * assertion is.
 */
export const summarySchema = z.object({
  sentences: z
    .array(
      z.object({
        text: z.string().min(1).max(600),
        /** local_ids or assertion ids that support this sentence. */
        supported_by: z.array(z.string().max(60)).min(1).max(10),
      }),
    )
    .max(20),
})

export type Summary = z.infer<typeof summarySchema>

/**
 * An answer to a reader's question, or an admission that the data is short.
 *
 * `insufficient_data` is a first-class outcome, not a failure mode. A wrong
 * answer with a plausible citation is far more damaging here than "the
 * chapters you have read do not say" — the whole product is a claim about what
 * is verifiable.
 */
export const answerSchema = z.object({
  insufficient_data: z.boolean(),
  answer: z.string().max(4000),
  citations: z
    .array(
      z.object({
        assertion_id: z.string().max(60),
        chapter: z.number().int().min(0),
        excerpt: z.string().max(400),
      }),
    )
    .max(20),
})

export type Answer = z.infer<typeof answerSchema>
