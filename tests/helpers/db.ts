import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

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

export async function addLabel(
  world: SeededWorld,
  entityId: string,
  label: string,
  kind: string,
  revealedInChapter: number,
  precedence: number,
): Promise<void> {
  await raw`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
    VALUES
      (${entityId}, ${world.userId}, ${label}, ${label.toLowerCase()},
       ${kind}::label_kind, ${revealedInChapter}, ${precedence})
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

export async function closeDb(): Promise<void> {
  await raw.end({ timeout: 5 })
}
