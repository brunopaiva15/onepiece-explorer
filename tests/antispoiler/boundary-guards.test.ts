import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  addAssertion,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
} from '../helpers/db.ts'
import { withBoundary } from '@/db/boundary.ts'
import { assertions, entityLabels } from '@/db/schema/index.ts'

/**
 * The two structural guards behind the product's central promise.
 *
 * These are not tests of a feature. They are tests that the mechanism which
 * makes every other anti-spoiler guarantee possible is actually switched on —
 * so if someone disables row-level security, connects with the wrong role, or
 * adds a read path that skips withBoundary(), CI says so immediately rather
 * than the app quietly serving spoilers.
 */

afterAll(async () => {
  await closeDb()
})

describe('guard 1 — reading outside withBoundary() returns nothing', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('yields zero rows when no boundary is set, even though data exists', async () => {
    const world = await seedWorld([1, 3])
    const luffy = await createEntity(world, 'character', 1)
    const crew = await createEntity(world, 'group', 1)
    await addAssertion(world, {
      subject: luffy,
      predicate: 'member_of',
      object: crew,
      knowledgeFrom: 1,
    })

    // The row is really there.
    const stored = await raw<{ n: number }[]>`SELECT count(*)::int AS n FROM assertions`
    expect(stored[0]?.n).toBe(1)

    // A session that authenticates but never declares a boundary sees nothing.
    // app.boundary() returns -1 when unset: fail-closed by construction.
    const leaked = await raw.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims',
        ${JSON.stringify({ sub: world.userId, role: 'authenticated' })}, true)`
      await tx`SET LOCAL ROLE authenticated`
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM assertions`
    })
    expect(leaked[0]?.n).toBe(0)
  })

  it('does not leak one user’s knowledge to another', async () => {
    const alice = await seedWorld([1])
    const bob = await seedWorld([1])

    const entity = await createEntity(alice, 'character', 1)
    await addAssertion(alice, {
      subject: entity,
      predicate: 'appears_in',
      objectValue: { chapter: 1 },
      knowledgeFrom: 1,
    })

    const asBob = await withBoundary(
      { userId: bob.userId, boundaryChapter: 9999 },
      (db) => db.select().from(assertions),
    )
    expect(asBob).toHaveLength(0)

    const asAlice = await withBoundary(
      { userId: alice.userId, boundaryChapter: 9999 },
      (db) => db.select().from(assertions),
    )
    expect(asAlice).toHaveLength(1)
  })

  it('hides a fact revealed after the boundary, and reveals it at the boundary', async () => {
    const world = await seedWorld([20, 300])
    const shadowA = await createEntity(world, 'character', 20)
    const shadowB = await createEntity(world, 'character', 20)

    // Chapter 300 reveals the two silhouettes are the same person.
    await addAssertion(world, {
      subject: shadowA,
      predicate: 'same_as',
      object: shadowB,
      knowledgeFrom: 300,
      observedIn: 300,
    })

    const atChapter20 = await withBoundary(
      { userId: world.userId, boundaryChapter: 20 },
      (db) => db.select().from(assertions),
    )
    expect(atChapter20).toHaveLength(0)

    const atChapter300 = await withBoundary(
      { userId: world.userId, boundaryChapter: 300 },
      (db) => db.select().from(assertions),
    )
    expect(atChapter300).toHaveLength(1)
  })

  it('keeps the old alias in place until the true name is revealed', async () => {
    const world = await seedWorld([1, 50])
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'L’homme au manteau', 'placeholder', 1, 10)
    await addLabel(world, entity, 'Dragon', 'true_name', 50, 100)

    const nameAt = async (boundary: number) =>
      withBoundary({ userId: world.userId, boundaryChapter: boundary }, async (db) => {
        const rows = await db.select().from(entityLabels)
        return rows.sort((a, b) => b.precedence - a.precedence)[0]?.label
      })

    expect(await nameAt(49)).toBe('L’homme au manteau')
    expect(await nameAt(50)).toBe('Dragon')
  })

  it('keeps a refuted belief visible in the past and gone in the present', async () => {
    const world = await seedWorld([10, 40])
    const character = await createEntity(world, 'character', 10)
    const place = await createEntity(world, 'place', 10)

    // Believed from chapter 10, refuted at chapter 40.
    await addAssertion(world, {
      subject: character,
      predicate: 'located_at',
      object: place,
      knowledgeFrom: 10,
      knowledgeUntil: 40,
    })
    // The correction, revealed at 40. Both rows exist forever.
    await addAssertion(world, {
      subject: character,
      predicate: 'located_at',
      object: place,
      knowledgeFrom: 40,
      epistemic: 'user_validated',
    })

    const at39 = await withBoundary(
      { userId: world.userId, boundaryChapter: 39 },
      (db) => db.select().from(assertions),
    )
    const at40 = await withBoundary(
      { userId: world.userId, boundaryChapter: 40 },
      (db) => db.select().from(assertions),
    )

    expect(at39).toHaveLength(1)
    expect(at39[0]?.knowledgeUntilChapter).toBe(40)
    expect(at40).toHaveLength(1)
    expect(at40[0]?.epistemicStatus).toBe('user_validated')

    // And nothing was destroyed to achieve that.
    const stored = await raw<{ n: number }[]>`SELECT count(*)::int AS n FROM assertions`
    expect(stored[0]?.n).toBe(2)
  })

  it('never shows a proposal that has not been accepted', async () => {
    const world = await seedWorld([1])
    const entity = await createEntity(world, 'character', 1)
    await addAssertion(world, {
      subject: entity,
      predicate: 'appears_in',
      objectValue: { chapter: 1 },
      knowledgeFrom: 1,
      status: 'proposed',
    })

    const visible = await withBoundary(
      { userId: world.userId, boundaryChapter: 9999 },
      (db) => db.select().from(assertions),
    )
    expect(visible).toHaveLength(0)
  })
})

describe('guard 2 — no module reaches the database directly', () => {
  /**
   * ESLint enforces this too, but a lint rule can be disabled inline and lint
   * can be skipped. The boundary is the product's core guarantee, so it gets
   * a test as well: any new read path must go through withBoundary().
   */
  const ALLOWED = new Set([
    path.join('src', 'db', 'client.ts'),
    path.join('src', 'db', 'boundary.ts'),
  ])

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) yield full
    }
  }

  it('only src/db imports appSql or ingestSql', async () => {
    const offenders: string[] = []
    const root = path.join(process.cwd(), 'src')

    for await (const file of walk(root)) {
      const relative = path.relative(process.cwd(), file)
      if (ALLOWED.has(relative)) continue

      const source = await readFile(file, 'utf8')
      if (/\b(appSql|ingestSql)\b/.test(source)) offenders.push(relative)
    }

    expect(
      offenders,
      `Ces modules accèdent au pool directement et contournent donc la frontière de chapitre :\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })
})
