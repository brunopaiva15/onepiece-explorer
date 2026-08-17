import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import type { StoryTime } from '@/db/schema/knowledge.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'

/**
 * Raw connection to the local test database, used to seed fixtures and to
 * assert what is really stored — deliberately bypassing withBoundary() so a
 * test can compare "what exists" with "what the reader can see".
 */
export const raw = postgres(
  process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test',
  { max: 2, onnotice: () => {} },
)

const ALL_TABLES = [
  'profiles',
  'works',
  'chapters',
  'documents',
  'pages',
  'panels',
  'text_blocks',
  'entities',
  'entity_labels',
  'entity_images',
  'assertions',
  'evidence',
  'events',
  'mysteries',
  'user_theories',
  'occurrences',
  'embeddings',
  'audit_log',
  'ingestion_runs',
  'ingestion_steps',
  'review_items',
  'review_decisions',
  'quarantine',
] as const

export async function resetDatabase(): Promise<void> {
  await raw.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_destructive', 'on', true)`
    await tx.unsafe(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`)
  })
}

export interface SeededWorld {
  userId: string
  workId: string
  chapterIds: Map<number, string>
}

/**
 * A minimal library: one user, one work, and the given chapter numbers, all
 * published. Chapters are ownership-scoped rather than boundary-scoped —
 * knowing you imported chapter 700 is not a spoiler about its contents.
 */
export async function seedWorld(chapterNumbers: number[]): Promise<SeededWorld> {
  const userId = randomUUID()
  const workId = randomUUID()

  await raw`INSERT INTO profiles (id) VALUES (${userId})`
  await raw`
    INSERT INTO works (id, user_id, slug, title)
    VALUES (${workId}, ${userId}, 'one-piece', 'One Piece')
  `

  const chapterIds = new Map<number, string>()
  for (const number of chapterNumbers) {
    const id = randomUUID()
    await raw`
      INSERT INTO chapters (id, work_id, user_id, number, status, published_at)
      VALUES (${id}, ${workId}, ${userId}, ${number}, 'published', now())
    `
    chapterIds.set(number, id)
  }

  return { userId, workId, chapterIds }
}

/**
 * Un chapitre de plus dans une bibliothèque déjà semée, publié.
 *
 * Ce que `seedWorld` fait d'un coup, fait après coup — parce que « la
 * bibliothèque a grandi » est un événement que certains comportements
 * attendent, et non un état de départ. Le balayage des mystères en dépend :
 * c'est la seule chose qui remet à poser une question déjà examinée.
 */
export async function publishChapter(world: SeededWorld, number: number): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO chapters (id, work_id, user_id, number, status, published_at)
    VALUES (${id}, ${world.workId}, ${world.userId}, ${number}, 'published', now())
  `
  world.chapterIds.set(number, id)
  return id
}

export async function createEntity(
  world: SeededWorld,
  nodeType: string,
  firstSeenChapter: number,
): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
    VALUES (${id}, ${world.workId}, ${world.userId}, ${nodeType}, ${firstSeenChapter}, 'accepted')
  `
  return id
}

/**
 * A name, with the chapter that gives it.
 *
 * `revealedInChapter` may be null: a name no chapter gives — a SBS answer, a
 * databook entry — which the boundary policy withholds at every chapter. The
 * schema then requires `revealSource`, so the helper takes it too rather than
 * letting a fixture hit a constraint error and read as a broken test.
 */
export async function addLabel(
  world: SeededWorld,
  entityId: string,
  label: string,
  kind: string,
  revealedInChapter: number | null,
  precedence: number,
  revealSource?: string,
): Promise<void> {
  await raw`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter,
       reveal_source, precedence)
    VALUES
      (${entityId}, ${world.userId}, ${label}, ${normalizeText(label)},
       ${kind}::label_kind, ${revealedInChapter}, ${revealSource ?? null},
       ${precedence})
  `
}

export interface AssertionInput {
  subject: string
  predicate: string
  object?: string
  objectValue?: unknown
  knowledgeFrom: number
  knowledgeUntil?: number | null
  observedIn?: number
  status?: 'proposed' | 'accepted' | 'rejected' | 'deferred' | 'superseded'
  epistemic?: string
  proposedBy?: 'ai' | 'user'
  locked?: boolean
}

export async function addAssertion(
  world: SeededWorld,
  input: AssertionInput,
): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO assertions (
      id, work_id, user_id, subject_entity_id, predicate, object_entity_id,
      object_value, knowledge_from_chapter, knowledge_until_chapter,
      observed_in_chapter, confidence, epistemic_status, review_status,
      proposed_by, locked
    ) VALUES (
      ${id}, ${world.workId}, ${world.userId}, ${input.subject},
      ${input.predicate}, ${input.object ?? null},
      ${input.objectValue === undefined ? null : JSON.stringify(input.objectValue)},
      ${input.knowledgeFrom}, ${input.knowledgeUntil ?? null},
      ${input.observedIn ?? input.knowledgeFrom}, 0.9,
      ${(input.epistemic ?? 'explicit')}::epistemic_status,
      ${(input.status ?? 'accepted')}::review_status,
      ${input.proposedBy ?? 'ai'}, ${input.locked ?? false}
    )
  `
  return id
}

/**
 * An event, hung off an entity like the schema hangs it.
 *
 * `toldIn` and `shownIn` are kept apart here for the same reason the table
 * keeps them apart: a chapter that recounts an event is where the reader
 * learned of it, even when the art shows it three hundred chapters later.
 */
export async function addEvent(
  world: SeededWorld,
  entityId: string,
  input: {
    summary?: string | null
    isFlashback?: boolean
    shownIn?: number | null
    toldIn?: number | null
    storyTime?: StoryTime
  },
): Promise<void> {
  await raw`
    INSERT INTO events (entity_id, user_id, work_id, summary, story_time,
                        is_flashback, shown_in_chapter, told_in_chapter)
    VALUES (${entityId}, ${world.userId}, ${world.workId},
            ${input.summary ?? null},
            /*
             * raw.json(), not JSON.stringify().
             *
             * A JavaScript string handed to a jsonb column is stored as a JSON
             * *string* — the whole object, escaped, one scalar deep. It inserts
             * without complaint and reads back as text, so the fixture looks
             * right and every assertion about its contents fails.
             */
            ${input.storyTime === undefined ? null : raw.json(input.storyTime)},
            ${input.isFlashback ?? false},
            ${input.shownIn ?? null}, ${input.toldIn ?? null})
  `
}

export async function addMystery(
  world: SeededWorld,
  entityId: string,
  input: {
    question: string
    openedIn: number
    state?: 'open' | 'partially_resolved' | 'resolved' | 'abandoned'
    resolvedIn?: number | null
    /**
     * Le dernier chapitre publié contre lequel le balayage l'a déjà examinée.
     *
     * Absent = jamais examinée, ce qui est l'état de toute question fraîchement
     * proposée par le pipeline et donc le défaut ici.
     */
    sweptTo?: number | null
  },
): Promise<void> {
  await raw`
    INSERT INTO mysteries (entity_id, user_id, work_id, question,
                           opened_in_chapter, state, resolved_in_chapter,
                           swept_to_chapter)
    VALUES (${entityId}, ${world.userId}, ${world.workId}, ${input.question},
            ${input.openedIn}, ${(input.state ?? 'open')}::mystery_state,
            ${input.resolvedIn ?? null}, ${input.sweptTo ?? null})
  `
}

/**
 * A quoted line, with the page and the block it is quoted from.
 *
 * All three rows are needed and none is ceremony: the anchoring trigger
 * refuses evidence carrying an excerpt without a text block, and refuses a
 * text block in which the excerpt does not occur. A helper that skipped them
 * would be testing against a database less strict than the real one.
 */
export async function addQuote(
  world: SeededWorld,
  input: { assertionId: string; chapterNumber: number; text: string },
): Promise<void> {
  const chapterId = world.chapterIds.get(input.chapterNumber)
  if (!chapterId) {
    throw new Error(`Chapitre ${input.chapterNumber} absent du monde de test.`)
  }

  const pageId = randomUUID()
  const blockId = randomUUID()

  await raw`
    INSERT INTO pages (id, chapter_id, user_id, index, width, height,
                       storage_key_original, chapter_number)
    VALUES (${pageId}, ${chapterId}, ${world.userId},
            (SELECT coalesce(max(index), -1) + 1 FROM pages WHERE chapter_id = ${chapterId}),
            800, 1200, 'key', ${input.chapterNumber})
  `
  await raw`
    INSERT INTO text_blocks (id, page_id, chapter_id, user_id, bbox, text,
                             normalized_text, source, chapter_number)
    VALUES (${blockId}, ${pageId}, ${chapterId}, ${world.userId},
            '{"x":0,"y":0,"w":1,"h":1}'::jsonb, ${input.text},
            app.normalize_text(${input.text}), 'pdf_text', ${input.chapterNumber})
  `
  await raw`
    INSERT INTO evidence (assertion_id, user_id, chapter_id, page_id,
                          text_block_id, kind, excerpt)
    VALUES (${input.assertionId}, ${world.userId}, ${chapterId}, ${pageId},
            ${blockId}, 'dialogue', ${input.text})
  `
}

/**
 * A portrait, hung off an entity.
 *
 * `revealedIn` is the reveal chapter of the *label* that matched, not the
 * entity's first appearance: a face found by a true name must not appear
 * before the reader learns that name.
 */
export async function addPortrait(
  world: SeededWorld,
  entityId: string,
  input: { matchedLabel: string; revealedIn: number },
): Promise<void> {
  await raw`
    INSERT INTO entity_images (
      user_id, entity_id, source, source_ref, source_url, attribution,
      storage_key, matched_label, match_method, match_score, revealed_in_chapter
    ) VALUES (
      ${world.userId}, ${entityId}, 'onepieceapi', ${randomUUID()},
      'https://example.invalid/x', 'onepieceapi.com',
      ${`${world.userId}/entities/${entityId}/full/x.webp`},
      ${input.matchedLabel}, 'exact', 1, ${input.revealedIn}
    )
  `
}

/**
 * A stated presence: seen, or merely spoken of.
 *
 * Only rows written with `stated` may be read as a statement about presence —
 * the ones publication used to derive from the medium of the evidence mean
 * something weaker. See migration 0020.
 */
export async function addPresence(
  world: SeededWorld,
  entityId: string,
  input: { chapterNumber: number; kind: 'appearance' | 'mention' },
): Promise<void> {
  const chapterId = world.chapterIds.get(input.chapterNumber)
  if (!chapterId) {
    throw new Error(`Chapitre ${input.chapterNumber} absent du monde de test.`)
  }

  await raw`
    INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated,
                             chapter_number, confidence)
    VALUES (${entityId}, ${world.userId}, ${chapterId},
            ${input.kind}::occurrence_kind, true, ${input.chapterNumber}, 1)
  `
}

export async function closeDb(): Promise<void> {
  await raw.end({ timeout: 5 })
}
