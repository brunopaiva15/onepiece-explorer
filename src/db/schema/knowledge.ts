import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { chapters, pages, panels, textBlocks, works } from './documents.ts'
import { ingestionRuns } from './ingestion.ts'
import {
  epistemicStatusEnum,
  evidenceKindEnum,
  labelKindEnum,
  mysteryStateEnum,
  occurrenceKindEnum,
  proposerEnum,
  reviewStatusEnum,
} from './enums.ts'

/**
 * In-world time. Deliberately a union of shapes rather than a timestamp:
 * most One Piece events have no date, only an order relative to others.
 * Fabricating precision here would be worse than admitting ignorance.
 */
export type StoryTime =
  | { kind: 'exact'; year: number; month?: number; day?: number }
  | { kind: 'approximate'; description: string; yearsAgo?: number }
  | { kind: 'relative'; note: string }
  | { kind: 'unknown' }

export const nodeTypes = pgTable('node_types', {
  key: text('key').primaryKey(),
  labelFr: text('label_fr').notNull(),
  description: text('description'),
  builtin: boolean('builtin').notNull().default(true),
})

export const predicates = pgTable('predicates', {
  key: text('key').primaryKey(),
  labelFr: text('label_fr').notNull(),
  isDirected: boolean('is_directed').notNull().default(true),
  isSymmetric: boolean('is_symmetric').notNull().default(false),
  inverseKey: text('inverse_key'),
  subjectTypes: text('subject_types').array().notNull(),
  objectTypes: text('object_types').array().notNull(),
  /** Drives the boundary-aware union-find over identities. */
  isIdentity: boolean('is_identity').notNull().default(false),
  /** Forces human review whatever the model's confidence. */
  requiresExplicitReview: boolean('requires_explicit_review')
    .notNull()
    .default(false),
  builtin: boolean('builtin').notNull().default(true),
  description: text('description'),
})

/**
 * A node. Carries no name on purpose: "what is this called" has a different
 * answer at chapter 20 and at chapter 300, so names are labels with their own
 * reveal chapters.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    nodeType: text('node_type')
      .notNull()
      .references(() => nodeTypes.key),
    firstSeenChapter: integer('first_seen_chapter').notNull(),
    reviewStatus: reviewStatusEnum('review_status').notNull().default('proposed'),
    /**
     * Which proposal produced this entity.
     *
     * Assertions have carried their provenance from the start; entities did
     * not, and it was free while a chapter was published in one transaction —
     * the map from the model's local id to the row it created lived in memory
     * for exactly that long. Publishing a chapter in two batches, which is what
     * holding back a naming question does, made a relation arrive with a
     * subject of « e1 » and no way to resolve it. See migration 0018.
     */
    runId: uuid('run_id'),
    proposalLocalId: text('proposal_local_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('entities_work_type_idx').on(t.workId, t.nodeType),
    index('entities_first_seen_idx').on(t.workId, t.firstSeenChapter),
  ],
)

export const entityLabels = pgTable(
  'entity_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    label: text('label').notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    kind: labelKindEnum('kind').notNull().default('alias'),
    revealedInChapter: integer('revealed_in_chapter').notNull(),
    precedence: integer('precedence').notNull().default(0),
    sourceAssertionId: uuid('source_assertion_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('entity_labels_entity_idx').on(
      t.entityId,
      t.revealedInChapter,
      t.precedence,
    ),
  ],
)

/**
 * Append-only. Only review_status and superseded_by may change after insert;
 * a database trigger refuses anything else, and DELETE requires an explicit
 * opt-in. See ADR 0002.
 */
export const assertions = pgTable(
  'assertions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),

    subjectEntityId: uuid('subject_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    predicate: text('predicate')
      .notNull()
      .references(() => predicates.key),
    objectEntityId: uuid('object_entity_id').references(() => entities.id, {
      onDelete: 'cascade',
    }),
    objectValue: jsonb('object_value'),

    /** Reader-knowledge axis — what the RLS policy filters on. */
    knowledgeFromChapter: integer('knowledge_from_chapter').notNull(),
    /** Set when a later chapter refutes this belief. Both rows survive. */
    knowledgeUntilChapter: integer('knowledge_until_chapter'),

    /** In-world validity axis. Independent of the two above. */
    storyValidFrom: jsonb('story_valid_from').$type<StoryTime>(),
    storyValidUntil: jsonb('story_valid_until').$type<StoryTime>(),

    /** Chapter whose pages provide the evidence. */
    observedInChapter: integer('observed_in_chapter').notNull(),

    confidence: real('confidence').notNull().default(0),
    epistemicStatus: epistemicStatusEnum('epistemic_status').notNull(),
    reviewStatus: reviewStatusEnum('review_status').notNull().default('proposed'),
    proposedBy: proposerEnum('proposed_by').notNull(),

    pipelineVersion: text('pipeline_version'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    runId: uuid('run_id').references(() => ingestionRuns.id, {
      onDelete: 'set null',
    }),

    proposalFingerprint: text('proposal_fingerprint'),
    superseded_by: uuid('superseded_by'),
    /** User-authored: never superseded by the AI on re-import. */
    locked: boolean('locked').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('assertions_boundary_idx').on(
      t.workId,
      t.reviewStatus,
      t.knowledgeFromChapter,
      t.knowledgeUntilChapter,
    ),
    index('assertions_subject_idx').on(t.subjectEntityId, t.predicate),
    index('assertions_object_idx').on(t.objectEntityId, t.predicate),
    index('assertions_run_idx').on(t.runId),
  ],
)

export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assertionId: uuid('assertion_id')
      .notNull()
      .references(() => assertions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'set null' }),
    panelId: uuid('panel_id').references(() => panels.id, {
      onDelete: 'set null',
    }),
    textBlockId: uuid('text_block_id').references(() => textBlocks.id, {
      onDelete: 'set null',
    }),
    bbox: jsonb('bbox'),
    kind: evidenceKindEnum('kind').notNull(),
    /** Must occur in the cited block. Enforced in code and by a trigger. */
    excerpt: text('excerpt'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('evidence_assertion_idx').on(t.assertionId),
    index('evidence_chapter_idx').on(t.chapterId),
    index('evidence_panel_idx').on(t.panelId),
  ],
)

export const events = pgTable(
  'events',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    summary: text('summary'),
    storyTime: jsonb('story_time').$type<StoryTime>(),
    durationEstimate: text('duration_estimate'),
    isFlashback: boolean('is_flashback').notNull().default(false),
    /** Shown late vs told early: both recorded, neither inferred. */
    shownInChapter: integer('shown_in_chapter'),
    toldInChapter: integer('told_in_chapter'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('events_work_idx').on(t.workId)],
)

export const mysteries = pgTable(
  'mysteries',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    openedInChapter: integer('opened_in_chapter').notNull(),
    state: mysteryStateEnum('state').notNull().default('open'),
    resolvedInChapter: integer('resolved_in_chapter'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('mysteries_work_state_idx').on(t.workId, t.state)],
)

/** A separate layer from validated canon. Never promoted to fact automatically. */
export const userTheories = pgTable(
  'user_theories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    relatedEntityIds: uuid('related_entity_ids').array().notNull().default([]),
    relatedMysteryId: uuid('related_mystery_id'),
    /** The boundary held when writing, so a theory is never shown as if
     *  informed by chapters read later. */
    writtenAtChapter: integer('written_at_chapter').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('user_theories_work_idx').on(t.workId)],
)

export const occurrences = pgTable(
  'occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    panelId: uuid('panel_id').references(() => panels.id, {
      onDelete: 'cascade',
    }),
    kind: occurrenceKindEnum('kind').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    confidence: real('confidence').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('occurrences_entity_idx').on(t.entityId, t.chapterNumber),
    index('occurrences_chapter_idx').on(t.chapterId),
  ],
)

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    modelId: text('model_id').notNull(),
    dimensions: integer('dimensions').notNull(),
    /** Storage of record: works with and without pgvector. */
    embedding: real('embedding').array().notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.subjectKind, t.subjectId, t.modelId),
    index('embeddings_work_idx').on(t.workId, t.subjectKind),
  ],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    action: text('action').notNull(),
    subjectKind: text('subject_kind'),
    subjectId: uuid('subject_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('audit_log_user_idx').on(t.userId, t.createdAt)],
)

/**
 * External illustrations, kept deliberately apart from knowledge.
 *
 * No assertion may cite one and no fact rests on one — see
 * drizzle/0012_entity_images.sql for why that separation is structural rather
 * than a convention. `revealedInChapter` is the revelation chapter of the
 * *label* that matched, not the entity's first appearance: a portrait found by
 * a true name must not appear before the reader learns that name.
 */
export const entityImages = pgTable(
  'entity_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceUrl: text('source_url').notNull(),
    attribution: text('attribution').notNull(),
    storageKey: text('storage_key').notNull(),
    thumbKey: text('thumb_key'),
    width: integer('width'),
    height: integer('height'),
    mime: text('mime').notNull().default('image/webp'),
    bytes: integer('bytes'),
    matchedLabel: text('matched_label').notNull(),
    matchMethod: text('match_method').notNull(),
    matchScore: real('match_score').notNull(),
    revealedInChapter: integer('revealed_in_chapter').notNull(),
    isPrimary: boolean('is_primary').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('entity_images_unique_source').on(t.entityId, t.source, t.sourceRef),
    index('entity_images_boundary_idx').on(t.userId, t.entityId, t.revealedInChapter),
  ],
)

/**
 * Terms whose French form you decided.
 *
 * The mechanism that stops the extraction step from re-inventing a name every
 * chapter. When a model cannot tell whether a term should be translated or kept
 * — the difference between «  the Red-Haired Pirates » and «  Going Merry » is a
 * convention, not a fact in the text — it says so, the item goes to explicit
 * review, and your answer lands here. Later chapters of the same work receive
 * it as settled vocabulary.
 *
 * Bounded by `decidedInChapter` like everything else that carries a revelation:
 * a glossary entry from chapter 500 handed to a chapter-3 extraction would be
 * the reveal itself, leaked into the prompt. See migration 0016.
 */
export const glossaryTerms = pgTable(
  'glossary_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** The wording as the source has it, quoted exactly. */
    sourceTerm: text('source_term').notNull(),
    normalizedSource: text('normalized_source').notNull(),
    /** What it is called in the graph. Your decision, not a proposal. */
    frenchTerm: text('french_term').notNull(),
    note: text('note'),
    decidedInChapter: integer('decided_in_chapter').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('glossary_terms_unique_source').on(t.workId, t.normalizedSource),
    index('glossary_terms_lookup').on(t.workId, t.decidedInChapter),
  ],
)
