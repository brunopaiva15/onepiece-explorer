/*
 * What a page holds while it reads, and what happens when it holds too much.
 *
 * The reading pool is sized per instance and small, because a serverless
 * runtime multiplies instances and the database's connection slots belong to
 * all of them at once. That sizing turns "this read wants two connections at
 * the same time" from an invisible cost into a failure, and the failure is not
 * a slow page: a transaction holds its connection for as long as it runs, so a
 * read that opens a second one *from inside the first* waits for a connection
 * the waiting code is itself holding. Nothing returns, the instance keeps its
 * connections checked out, and every later page on it hangs too.
 *
 * That is the same defect tests/db/ingest-nesting.test.ts pins on the other
 * pool, and it was here as well: the chapter delta read the chapter at its own
 * boundary and, inside that transaction, opened another at the boundary before
 * to find what the chapter refutes.
 *
 * So these run against a pool of exactly one connection. A read that needs two
 * at once will not be slow here; it will not return at all, which is what the
 * per-test timeouts are for. A read that merely wants several in *sequence* —
 * story mode opens one per chapter — queues and finishes, which is the whole
 * distinction being pinned.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appSql, closeConnections } from '@/db/client.ts'
import { getStoryPage, STORY_WINDOW } from '@/domains/temporal/story.ts'
import { getNarrativeDelta } from '@/domains/temporal/timeline.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  addPortrait,
  addPresence,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/*
 * Set before anything opens the pool, which is safe because it is built on
 * first *use* rather than at import — see the comment in db/client.ts about
 * `next build` importing every route.
 */
const POOL_MAX_BEFORE = process.env.DB_POOL_MAX
process.env.DB_POOL_MAX = '1'

let world: SeededWorld

beforeAll(() => {
  // The pool really is one deep, or none of this proves anything.
  expect(appSql().options.max).toBe(1)
})

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 4, 5, 6, 7])

  const shanks = await createEntity(world, 'character', 1)
  await addLabel(world, shanks, 'l’homme au manteau rouge', 'alias', 1, 10)
  await addLabel(world, shanks, 'Shanks le Roux', 'true_name', 3, 100)
  await addPortrait(world, shanks, { matchedLabel: 'Shanks le Roux', revealedIn: 3 })
  await addPresence(world, shanks, { chapterNumber: 1, kind: 'appearance' })
  await addEvent(world, shanks, {
    summary: 'Shanks le Roux quitte le village sans se retourner.',
    toldIn: 3,
  })
  await addMystery(world, shanks, {
    question: 'Où va le manteau rouge ?',
    openedIn: 2,
    resolvedIn: 5,
    state: 'resolved',
  })

  const village = await createEntity(world, 'place', 2)
  await addLabel(world, village, 'le village de Fuchsia', 'true_name', 2, 100)

  // A belief held from chapter 2 and refuted at 3 — the row the delta can only
  // see one chapter earlier, and the reason it opened a second transaction.
  await addAssertion(world, {
    subject: shanks,
    predicate: 'located_at',
    object: village,
    knowledgeFrom: 2,
    knowledgeUntil: 3,
  })
})

afterAll(async () => {
  await closeConnections()
  await closeDb()
  if (POOL_MAX_BEFORE === undefined) delete process.env.DB_POOL_MAX
  else process.env.DB_POOL_MAX = POOL_MAX_BEFORE
})

describe('the chapter delta, with a pool of one connection', () => {
  /*
   * The failure as it would be met: /delta/3 on a deployment whose pool is one
   * deep. The refutation is the point of the page, so this is the real path and
   * not a reconstruction of it.
   */
  it('returns, and still names what the chapter refutes', async () => {
    const delta = await getNarrativeDelta(world.userId, 3)

    expect(delta).not.toBeNull()
    expect(delta!.refuted.map((row) => row.predicate)).toEqual(['located_at'])
    // Read at chapter 2, where the belief was still held and the name had not
    // yet landed — the boundary of the second transaction, not the first.
    expect(delta!.refuted[0]!.subjectLabel).toBe('l’homme au manteau rouge')
    expect(delta!.refuted[0]!.heldSince).toBe(2)
  }, 20_000)

  it('still says what a newly named entity used to be called', async () => {
    const delta = await getNarrativeDelta(world.userId, 3)

    const named = delta!.newNames.find((row) => row.label === 'Shanks le Roux')
    expect(named?.previous).toBe('l’homme au manteau rouge')
  }, 20_000)
})

describe('a window of story mode, with a pool of one connection', () => {
  /*
   * Six chapters, each read at its own boundary, plus the refutations of each
   * read one chapter earlier: a dozen transactions for one render. Sequential
   * they queue on the single connection and the window comes back; two at a
   * time for one chapter and it would not.
   */
  it('returns the whole window', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: STORY_WINDOW,
      ceiling: 7,
    })

    expect(page.beats.filter((beat) => beat.kind === 'chapitre')).toHaveLength(
      STORY_WINDOW,
    )
    expect(page.nextCursor).toBe(7)
    // The beads that need the second boundary, and the ones that need a signed
    // portrait, are both in there — this is the full path, not a metadata read.
    expect(page.beats.some((beat) => beat.kind === 'dementi')).toBe(true)
    expect(page.beats.some((beat) => beat.portrait !== null)).toBe(true)
  }, 30_000)
})
