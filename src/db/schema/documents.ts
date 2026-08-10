import {
  bigint,
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
import {
  chapterStatusEnum,
  detectionSourceEnum,
  documentKindEnum,
  pageKindEnum,
  readingDirectionEnum,
  textBlockKindEnum,
  textSourceEnum,
} from './enums.ts'

/** Normalised bounding box, [0,1] relative to page dimensions. */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name'),
  theme: text('theme').notNull().default('system'),
  boundaryChapter: integer('boundary_chapter').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const works = pgTable(
  'works',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    defaultReadingDirection: readingDirectionEnum('default_reading_direction')
      .notNull()
      .default('rtl'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.userId, t.slug)],
)

export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    number: integer('number').notNull(),
    title: text('title'),
    volume: integer('volume'),
    language: text('language').notNull().default('fr'),
    readingDirection: readingDirectionEnum('reading_direction')
      .notNull()
      .default('rtl'),
    notes: text('notes'),
    status: chapterStatusEnum('status').notNull().default('draft'),
    /** Content fingerprint over ordered page hashes — makes re-import idempotent. */
    sourceFingerprint: text('source_fingerprint'),
    pageCount: integer('page_count').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.workId, t.number),
    index('chapters_work_number_idx').on(t.workId, t.number),
    index('chapters_user_status_idx').on(t.userId, t.status),
  ],
)

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    kind: documentKindEnum('kind').notNull(),
    originalFilename: text('original_filename').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    /** Key in the private bucket — never a URL. */
    storageKey: text('storage_key').notNull(),
    hasTextLayer: boolean('has_text_layer').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('documents_chapter_idx').on(t.chapterId),
    index('documents_sha_idx').on(t.userId, t.sha256),
  ],
)

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id').notNull(),
    /**
     * Denormalised from chapters.number, kept in step by a trigger. The RLS
     * predicate reads it, and a policy cannot afford a join.
     */
    chapterNumber: integer('chapter_number').notNull(),
    index: integer('index').notNull(),
    kind: pageKindEnum('kind').notNull().default('narrative'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    isDoubleSpread: boolean('is_double_spread').notNull().default(false),
    rotation: integer('rotation').notNull().default(0),
    excluded: boolean('excluded').notNull().default(false),
    storageKeyOriginal: text('storage_key_original').notNull(),
    storageKeyDisplay: text('storage_key_display'),
    storageKeyThumb: text('storage_key_thumb'),
    phash: text('phash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.chapterId, t.index),
    index('pages_chapter_index_idx').on(t.chapterId, t.index),
  ],
)

export const panels = pgTable(
  'panels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    index: integer('index').notNull(),
    bbox: jsonb('bbox').$type<BBox>().notNull(),
    readingOrder: integer('reading_order').notNull(),
    confidence: real('confidence').notNull().default(1),
    source: detectionSourceEnum('source').notNull().default('auto'),
    /** Factual visual description, itself anchored to this panel. */
    description: text('description'),
    descriptionModel: text('description_model'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.pageId, t.index),
    index('panels_page_order_idx').on(t.pageId, t.readingOrder),
    index('panels_chapter_idx').on(t.chapterId),
  ],
)

export const textBlocks = pgTable(
  'text_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    panelId: uuid('panel_id').references(() => panels.id, {
      onDelete: 'set null',
    }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    bbox: jsonb('bbox').$type<BBox>().notNull(),
    text: text('text').notNull(),
    /** What evidence anchoring matches against. See normalizeText(). */
    normalizedText: text('normalized_text').notNull(),
    lang: text('lang'),
    confidence: real('confidence').notNull().default(1),
    kind: textBlockKindEnum('kind').notNull().default('bubble'),
    source: textSourceEnum('source').notNull(),
    readingOrder: integer('reading_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('text_blocks_page_idx').on(t.pageId, t.readingOrder),
    index('text_blocks_panel_idx').on(t.panelId),
    index('text_blocks_chapter_idx').on(t.chapterId),
  ],
)
