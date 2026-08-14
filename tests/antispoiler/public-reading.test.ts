import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { publicLibraryOwnerId } from '@/lib/env.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { imagesFor } from '@/domains/images/index.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import {
  assertSafeKey,
  keyOwner,
  storageKey,
} from '@/domains/storage/adapter.ts'
import {
  addAssertion,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Public reading: the graph is open, the pages are not.
 *
 * The owner asked for a site anyone can browse while remaining the only person
 * who can upload. That is a coherent thing to build and a dangerous one to build
 * loosely, because the two halves fail in opposite directions: too little and
 * the site is useless to a visitor, too much and it becomes a way of handing
 * out somebody else's manga.
 *
 * The line drawn: facts, relations, timelines, entity labels and quoted
 * excerpts are public — that is what a fan wiki is. Page and panel images are
 * not, and neither is anything that writes.
 *
 * These tests are in `tests/antispoiler/` on purpose. They are not about a
 * feature working; they are about a leak not happening, which is the same
 * category as the eight scenarios and deserves the same blocking treatment.
 */

let world: SeededWorld
const originalOwner = process.env.PUBLIC_LIBRARY_OWNER_ID

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 5, 40])
})

afterEach(() => {
  if (originalOwner === undefined) delete process.env.PUBLIC_LIBRARY_OWNER_ID
  else process.env.PUBLIC_LIBRARY_OWNER_ID = originalOwner
})

afterAll(async () => {
  await closeDb()
})

/** A character named late, plus a fact only chapter 40 reveals. */
async function seedLibrary(): Promise<{ early: string; late: string }> {
  const ferryman = await createEntity(world, 'character', 1)
  const guild = await createEntity(world, 'group', 1)
  const secret = await createEntity(world, 'group', 40)

  await addLabel(world, ferryman, 'le passeur', 'placeholder', 1, 10)
  await addLabel(world, guild, 'la Guilde des Marées', 'true_name', 1, 100)
  await addLabel(world, secret, 'les Bannis', 'true_name', 40, 100)

  const early = await addAssertion(world, {
    subject: ferryman,
    predicate: 'member_of',
    object: guild,
    knowledgeFrom: 1,
  })
  const late = await addAssertion(world, {
    subject: ferryman,
    predicate: 'secretly_member_of',
    object: secret,
    knowledgeFrom: 40,
  })

  return { early, late }
}

describe('which library the public site shows', () => {
  it('names none by default, leaving the sole library to be resolved', () => {
    /*
     * Absent is the normal case, not the closed one. The site is public; the
     * variable exists to disambiguate an installation with more than one
     * account, and `getViewerSession()` falls back to the only library there
     * is. Null here means "nobody named one", not "nobody may read".
     */
    delete process.env.PUBLIC_LIBRARY_OWNER_ID
    expect(publicLibraryOwnerId()).toBeNull()
  })

  it('refuses a malformed id rather than half-designating', () => {
    /*
     * A typo must not resolve to a *different* library. Returning null hands
     * the decision back to the sole-library fallback, which abstains as soon as
     * there is more than one candidate — so the failure direction of a bad
     * value is "nothing published", never "somebody else's reading published".
     */
    for (const value of ['oui', 'true', '1', 'not-a-uuid', '   ', '']) {
      process.env.PUBLIC_LIBRARY_OWNER_ID = value
      expect(publicLibraryOwnerId()).toBeNull()
    }
  })

  it('accepts a well-formed id', () => {
    const id = randomUUID()
    process.env.PUBLIC_LIBRARY_OWNER_ID = ` ${id} `
    expect(publicLibraryOwnerId()).toBe(id)
  })
})

describe('what a visitor may read', () => {
  it('sees the graph at the boundary they choose', async () => {
    await seedLibrary()

    // A visitor is served the owner's library — the same projection the owner
    // gets, at whatever chapter the visitor puts the slider.
    const atOne = await projectGraph(world.userId, 1)
    const atForty = await projectGraph(world.userId, 40)

    expect(atOne.nodes.length).toBeGreaterThan(0)
    expect(atForty.nodes.length).toBeGreaterThan(atOne.nodes.length)
  })

  it('is still bound by the chapter boundary, exactly like the owner', async () => {
    const { late } = await seedLibrary()

    /*
     * Making the site public must not weaken the thing it is built on. The
     * boundary is enforced by row-level security, so a visitor read is filtered
     * by the same policy on the same column — there is no second, laxer path.
     */
    const atFive = await projectGraph(world.userId, 5)
    const labels = atFive.nodes.map((node) => node.label)

    expect(labels).not.toContain('les Bannis')

    const visible = await raw<Array<{ id: string }>>`
      SELECT id FROM assertions WHERE id = ${late}
    `
    // The row exists in the library…
    expect(visible.length).toBe(1)
    // …and is absent from the chapter-5 projection.
    expect(atFive.edges.some((edge) => edge.predicate === 'secretly_member_of')).toBe(
      false,
    )
  })

  it('gets an empty library rather than an error when the owner id matches nothing', async () => {
    // A mistyped id points at a user with no work row. That must read as "there
    // is nothing here", not as a 500 blaming the application.
    await expect(listChapters(randomUUID(), '')).resolves.toEqual([])
  })
})

describe('which library an anonymous visitor lands on', () => {
  /**
   * The session for someone with no account.
   *
   * `getViewerSession()` asks the auth server who is calling; a visitor is
   * nobody, and that is the only thing these tests need from it. Stubbing the
   * verified-user lookup is what lets the rest — resolving a library, refusing
   * to guess between two, reading the published ceiling — be exercised against
   * the real database rather than asserted about in prose.
   */
  async function visitorSession(requestedBoundary?: unknown) {
    vi.resetModules()
    vi.doMock('@/domains/auth/server.ts', () => ({
      getCurrentUser: async () => null,
      requireUser: async () => {
        throw new Error('un visiteur anonyme ne doit jamais atteindre requireUser')
      },
    }))
    const { getViewerSession } = await import('@/domains/auth/session.ts')
    return getViewerSession(requestedBoundary)
  }

  afterEach(() => {
    vi.doUnmock('@/domains/auth/server.ts')
    vi.resetModules()
  })

  it('reads the sole library of the installation with nothing configured', async () => {
    /*
     * The common deployment: one person, one library, and no environment
     * variable pasted anywhere. Requiring a uuid in the settings to make your
     * own public site show anything is a configuration step that exists to
     * restate the obvious, and getting it wrong used to mean an anonymous
     * visitor hit requireUser() and was bounced to a sign-in page.
     */
    delete process.env.PUBLIC_LIBRARY_OWNER_ID
    await seedLibrary()

    const session = await visitorSession()

    expect(session.isOwner).toBe(false)
    expect(session.userId).toBe(world.userId)
    expect(session.workId).toBe(world.workId)
    // The ceiling is the last *published* chapter, and the visitor starts there.
    expect(session.maxChapter).toBe(40)
    expect(session.boundaryChapter).toBe(40)
  })

  it('takes the boundary from the request, clamped to what is published', async () => {
    delete process.env.PUBLIC_LIBRARY_OWNER_ID
    await seedLibrary()

    expect((await visitorSession('5')).boundaryChapter).toBe(5)
    // Asking past the end of the library gets the end of the library.
    expect((await visitorSession('9000')).boundaryChapter).toBe(40)
  })

  it('abstains rather than guessing when there is more than one library', async () => {
    /*
     * Two accounts and nothing designating one of them: picking either would be
     * publishing somebody else's reading on their behalf. An empty session is
     * the only honest answer, and the settings page says which variable ends
     * the ambiguity.
     */
    delete process.env.PUBLIC_LIBRARY_OWNER_ID
    await seedLibrary()
    const other = randomUUID()
    await raw`INSERT INTO profiles (id) VALUES (${other})`
    await raw`
      INSERT INTO works (id, user_id, slug, title)
      VALUES (${randomUUID()}, ${other}, 'one-piece', 'One Piece')
    `

    const session = await visitorSession()

    expect(session.workId).toBe('')
    expect(session.maxChapter).toBe(0)
    expect(session.isOwner).toBe(false)
  })

  it('obeys the configured id when one is set, even with several libraries', async () => {
    await seedLibrary()
    const other = randomUUID()
    await raw`INSERT INTO profiles (id) VALUES (${other})`
    await raw`
      INSERT INTO works (id, user_id, slug, title)
      VALUES (${randomUUID()}, ${other}, 'one-piece', 'One Piece')
    `
    process.env.PUBLIC_LIBRARY_OWNER_ID = world.userId

    const session = await visitorSession()

    expect(session.userId).toBe(world.userId)
    expect(session.workId).toBe(world.workId)
  })

  it('publishes nothing when the configured id matches no library', async () => {
    // Failing closed on a typo: an empty site, never a fallback onto whichever
    // library happens to be there.
    await seedLibrary()
    process.env.PUBLIC_LIBRARY_OWNER_ID = randomUUID()

    const session = await visitorSession()

    expect(session.workId).toBe('')
    expect(session.maxChapter).toBe(0)
  })

  it('never provisions a row for an anonymous visitor', async () => {
    /*
     * `getReaderSession()` creates a profile and a work on first sign-in, which
     * is right for a person and wrong for a stranger. A visitor arriving at an
     * installation with no library at all must leave it exactly as empty as
     * they found it.
     */
    delete process.env.PUBLIC_LIBRARY_OWNER_ID
    await resetDatabase()

    const session = await visitorSession()
    expect(session.workId).toBe('')

    const works = await raw<Array<{ count: string }>>`SELECT count(*) FROM works`
    const profiles = await raw<Array<{ count: string }>>`SELECT count(*) FROM profiles`
    expect(works[0]?.count).toBe('0')
    expect(profiles[0]?.count).toBe('0')
  })
})

describe('what a visitor may not see', () => {
  it('cannot reach a page or panel image, because the key is not theirs', () => {
    /*
     * The asset route makes three independent checks: authenticated, key under
     * the caller's own prefix, valid unexpired signature. An anonymous visitor
     * fails the first. Someone signed in as themselves fails the second, which
     * is what this asserts — the ownership test is a string prefix on the key,
     * so it cannot be satisfied by anyone but the owner.
     */
    const key = storageKey({
      userId: world.userId,
      chapterId: randomUUID(),
      kind: 'display',
      filename: 'page-01.webp',
    })

    expect(() => assertSafeKey(key)).not.toThrow()
    expect(keyOwner(key)).toBe(world.userId)

    const stranger = randomUUID()
    expect(keyOwner(key)).not.toBe(stranger)
  })

  it('cannot reach an entity illustration through the boundary either', async () => {
    // Illustrations are external, not scans — but they are still served from the
    // private bucket by signed URL, and a visitor gets them only through the
    // same boundary-filtered read as everything else.
    const entity = await createEntity(world, 'character', 40)
    await addLabel(world, entity, 'les Bannis', 'true_name', 40, 100)

    await raw`
      INSERT INTO entity_images (
        user_id, entity_id, source, source_ref, source_url, attribution,
        storage_key, matched_label, match_method, match_score, revealed_in_chapter
      ) VALUES (
        ${world.userId}, ${entity}, 'onepieceapi', 'x',
        'https://example.invalid/x', 'onepieceapi.com',
        ${`${world.userId}/entities/${entity}/full/x.webp`},
        'les Bannis', 'exact', 1, 40
      )
    `

    expect((await imagesFor(world.userId, 5, [entity])).size).toBe(0)
    expect((await imagesFor(world.userId, 40, [entity])).size).toBe(1)
  })
})

describe('what a visitor may not do', () => {
  it('has no write path that does not go through requireOwner', async () => {
    /*
     * A structural check rather than a behavioural one, and deliberately so.
     * Every server action and route that writes resolves its session through
     * `requireOwner()`, which requires a signed-in user. `getViewerSession()` is
     * the read-only one, and the failure this guards against is somebody
     * reaching for it in an action six months from now because both names look
     * plausible at a write site.
     */
    const { glob, readFile } = await import('node:fs/promises')

    /*
     * A route that only answers GET is a read, and a read is exactly what
     * `getViewerSession()` is for — /api/histoire serves the public story mode
     * through it, as the pages around it do.
     *
     * So the rule is not "no route may name it" but "nothing that can write may
     * name it", and that is checkable rather than trusted: a file is exempt only
     * while it exports no mutating handler. Add a POST to a read route later and
     * this fails, which is the whole point — an allowlist would have gone stale
     * the moment somebody did.
     */
    // Deliberately loose: `export async function POST`, `export const POST =`
    // and `export { POST }` all count, and so does a false positive. This
    // errs towards flagging, which is the safe direction for a guard.
    const MUTATING = /export[^\n]*\b(?:POST|PUT|PATCH|DELETE)\b/

    const files: string[] = []
    const offenders: string[] = []
    for await (const file of glob('src/app/**/{actions,route}.ts')) {
      files.push(file)
      const source = await readFile(file, 'utf8')
      if (!source.includes('getViewerSession')) continue

      // A server action file is a write surface whatever it contains.
      const isAction = file.endsWith('actions.ts')
      if (isAction || MUTATING.test(source)) offenders.push(file)
    }

    // Assert the search found something. A glob that silently matches nothing
    // makes the check below pass forever while checking nothing — the exact
    // failure this whole file exists to catch, turned on the test itself.
    expect(files.length).toBeGreaterThanOrEqual(7)
    expect(offenders).toEqual([])
  })

  it('keeps the owner’s stored reading position out of the public view', async () => {
    /*
     * The owner's slider is their reading position. A visitor's comes from the
     * query string and nowhere else — otherwise the public page would announce
     * how far through the series its owner currently is, which is nobody's
     * business and is itself a small spoiler about them.
     */
    await raw`UPDATE profiles SET boundary_chapter = 5 WHERE id = ${world.userId}`

    const [profile] = await raw<Array<{ boundary_chapter: number }>>`
      SELECT boundary_chapter FROM profiles WHERE id = ${world.userId}
    `
    expect(profile?.boundary_chapter).toBe(5)

    // A visitor asking for chapter 40 gets 40, not the owner's 5.
    const graph = await projectGraph(world.userId, 40)
    expect(graph.boundaryChapter).toBe(40)
  })
})

describe('the gate in front of everything', () => {
  it('lets an anonymous visitor read the public site', async () => {
    /*
     * The test that should have existed first.
     *
     * Public reading shipped with the graph open at the domain level and the
     * proxy still bouncing every anonymous visitor to the sign-in page. Ten
     * domain tests passed and the feature did not work at all, because none of
     * them went through the gate. A rule about who gets in needs a test of the
     * rule.
     */
    const { decide } = await import('@/proxy.ts')

    for (const path of [
      '/',
      '/histoire',
      '/graph',
      '/graph/table',
      '/recherche',
      '/entite/abc',
      '/chronologie',
      '/mysteres',
      '/delta/12',
      '/mentions-legales',
      '/api/histoire',
    ]) {
      expect(decide(path, false)).toBe('allow')
    }
  })

  it('shuts the whole /admin prefix to an anonymous visitor', async () => {
    /*
     * One prefix, not a list of six paths somebody has to remember to extend.
     * The last entry is the point: a route nobody has thought about yet is
     * private because of where it lives.
     */
    const { decide } = await import('@/proxy.ts')

    for (const path of [
      '/admin',
      '/admin/import',
      '/admin/chapitres',
      '/admin/chapitres/abc',
      '/admin/runs/abc',
      '/admin/review/abc',
      '/admin/reglages',
      '/admin/ask',
      '/admin/quelque-chose-de-neuf',
      '/api/export',
    ]) {
      expect(decide(path, false)).toBe('sign-in')
    }
  })

  it('treats an unknown route as private', async () => {
    // The public site is an allowlist, so a page nobody has classified yet is
    // private rather than accidentally public.
    const { decide } = await import('@/proxy.ts')

    expect(decide('/quelque-chose-de-neuf', false)).toBe('sign-in')
    expect(decide('/histoire-secrete', false)).toBe('sign-in')
  })

  it('lets the two pages that must answer before a session through', async () => {
    /*
     * `/admin/etat` reports which variable is missing, and the failure it
     * diagnoses takes down the sign-in page too. Gating it behind the thing it
     * explains would make it useless in the only situation it exists for — and
     * gating the sign-in page itself is a redirect loop.
     */
    const { decide } = await import('@/proxy.ts')

    expect(decide('/admin/etat', false)).toBe('allow')
    expect(decide('/admin/connexion', false)).toBe('allow')
  })

  it('sends a signed-in owner from the sign-in page to the workshop', async () => {
    const { decide } = await import('@/proxy.ts')

    expect(decide('/admin/connexion', true)).toBe('admin')
    expect(decide('/admin/reglages', true)).toBe('allow')
    expect(decide('/', true)).toBe('allow')
  })

  it('stands down when the authentication configuration is unusable', async () => {
    /*
     * The gate runs before every route, `/etat` included. So it must survive a
     * configuration the rest of the application cannot use — a value that is
     * present but is not a URL threw inside createServerClient and took the
     * diagnostic page down with everything else. Letting the request through is
     * safe: row-level security is the boundary, and every page that reads
     * anything raises its own configuration error.
     */
    const { usableAuthConfig } = await import('@/proxy.ts')

    const key = 'anon-key'
    expect(usableAuthConfig({})).toBeNull()
    expect(
      usableAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' }),
    ).toBeNull()
    for (const url of [
      'authentification', // a description pasted from the documentation table
      '',
      '   ',
      'x.supabase.co', // no scheme
      'postgresql://x.supabase.co', // right shape, wrong protocol
    ]) {
      expect(
        usableAuthConfig({
          NEXT_PUBLIC_SUPABASE_URL: url,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
        }),
      ).toBeNull()
    }

    expect(
      usableAuthConfig({
        NEXT_PUBLIC_SUPABASE_URL: '  https://x.supabase.co  ',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: `  ${key}  `,
      }),
    ).toEqual({ url: 'https://x.supabase.co', anonKey: key })
  })
})
