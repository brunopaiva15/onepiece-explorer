import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { BOUNTY_HISTORY, formatBerries } from '@/domains/images/bounties.ts'
import { enrichBountyPosters, postersQuietly } from '@/domains/images/posters.ts'
import type { PosterFile } from '@/domains/images/sources/bounty-posters.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce qu'une passe automatique a le droit de faire.
 *
 * The button version of this ran on a person's schedule, so it could afford to
 * be wasteful: it read the gallery, re-resolved all forty-seven printings and
 * re-downloaded all twenty-six every time, and the insert threw the duplicates
 * away. Hung off « a chapter was published » that becomes a thousand gallery
 * reads and twenty-six thousand downloads on a batch import of the whole work.
 *
 * So the automatic pass is narrower than the button on purpose, and each
 * narrowing is a rule somebody could undo without noticing:
 *
 *   * it asks the library what it holds *before* it asks Fandom anything;
 *   * it considers only printings a person pinned, never the file-name
 *     heuristics, which are the half of the matcher that has been wrong;
 *   * it is capped, so one publication cannot become the whole manifest.
 *
 * None of that may weaken what the button does, which is the last test here.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 96, 435, 801, 1053])
})

afterAll(async () => {
  await closeDb()
})

const luffy = BOUNTY_HISTORY.find((c) => c.canonical === 'Monkey D. Luffy')!

/**
 * The printings a pass is expected to bring in.
 *
 * Pinned, and drawn by the manga. Luffy's thirty million is pinned to the
 * anime's panel of it and marked as such, and a pass that fetched it would be
 * storing bytes the read path refuses to show — so it is out of every count
 * here, the same way it is out of the wall.
 */
const fetchable = luffy.rows.filter((row) => row.file && !row.rendering)

/** A downloader and a resolver that answer without a network. */
function stubs() {
  const asked: string[] = []
  const downloaded: string[] = []

  const resolve = async (titles: readonly string[]): Promise<Map<string, PosterFile>> => {
    asked.push(...titles)
    return new Map(
      titles.map((title) => [
        title,
        {
          title,
          caption: '',
          section: '',
          imageUrl: `https://example.invalid/${encodeURIComponent(title)}`,
          originalUrl: `https://example.invalid/full/${encodeURIComponent(title)}`,
          pageUrl: `https://example.invalid/wiki/${encodeURIComponent(title)}`,
          width: 512,
          height: 800,
        },
      ]),
    )
  }

  const download = async (_userId: string, entityId: string, candidate: { sourceRef: string }) => {
    downloaded.push(candidate.sourceRef)
    return {
      storageKey: `${entityId}/full/${downloaded.length}.webp`,
      thumbKey: `${entityId}/thumb/${downloaded.length}.webp`,
      width: 512,
      height: 800,
      bytes: 1000,
      mime: 'image/webp' as const,
    }
  }

  return { asked, downloaded, resolve, download }
}

/** One accepted character the manifest knows. */
async function seedLuffy(): Promise<string> {
  const id = await createEntity(world, 'character', 1)
  await addLabel(world, id, 'Monkey D. Luffy', 'true_name', 1, 100)
  return id
}

async function storedChapters(): Promise<number[]> {
  const rows = await raw<Array<{ revealed_in_chapter: number }>>`
    SELECT revealed_in_chapter FROM entity_images
    WHERE user_id = ${world.userId} AND kind = 'poster'
    ORDER BY revealed_in_chapter
  `
  return rows.map((row) => row.revealed_in_chapter)
}

describe('la passe automatique', () => {
  it('n’ouvre jamais la galerie, et n’en a pas besoin', async () => {
    await seedLuffy()
    const { asked, downloaded, resolve, download } = stubs()

    /*
     * No `gallery` is provided and none is fetched: a pin carries its own file
     * name, so the pass reaches `resolveFiles` by title. If this ever regressed
     * the test would try to reach onepiece.fandom.com from the suite, which is
     * the failure mode it is written to make loud.
     */
    const report = await enrichBountyPosters(world.userId, {
      pinnedOnly: true,
      resolve,
      download,
    })

    expect(report.failures).toEqual([])
    expect(report.stored).toBeGreaterThan(0)
    expect(asked.length).toBe(downloaded.length)
  })

  it('ne considère que les tirages qu’une personne a épinglés', async () => {
    await seedLuffy()
    const { downloaded, resolve, download } = stubs()

    await enrichBountyPosters(world.userId, { pinnedOnly: true, resolve, download })

    const chapters = await storedChapters()
    expect(chapters).toEqual(fetchable.map((row) => row.chapter).sort((a, b) => a - b))

    // And nothing that was not pinned: the unpinned printings are the ones the
    // matcher would have had to judge from a file name.
    expect(downloaded.length).toBe(fetchable.length)
  })

  it('ne retélécharge rien la seconde fois', async () => {
    await seedLuffy()

    const first = stubs()
    const before = await enrichBountyPosters(world.userId, {
      pinnedOnly: true,
      resolve: first.resolve,
      download: first.download,
    })
    expect(before.stored).toBeGreaterThan(0)
    expect(before.skipped).toBe(0)

    const second = stubs()
    const after = await enrichBountyPosters(world.userId, {
      pinnedOnly: true,
      resolve: second.resolve,
      download: second.download,
    })

    // The whole reason this can hang off a published chapter: an up-to-date
    // library costs one query and not one request.
    expect(second.downloaded).toEqual([])
    expect(second.asked).toEqual([])
    expect(after.stored).toBe(0)
    expect(after.skipped).toBe(before.stored)
  })

  it('s’arrête au plafond sans mentir sur ce qui manque', async () => {
    await seedLuffy()
    const { downloaded, resolve, download } = stubs()

    const report = await enrichBountyPosters(world.userId, {
      pinnedOnly: true,
      limit: 1,
      resolve,
      download,
    })

    expect(downloaded.length).toBe(1)
    expect(report.stored).toBe(1)
    /*
     * `resolved` counts the printings this library is missing a file for, not
     * how far the pass got before the cap. A limit that shortened the count
     * would make the number look like a fact about the manifest when it is a
     * fact about the batch size.
     */
    expect(report.resolved).toBe(fetchable.length)
  })

  it('avale une panne du wiki plutôt que de la faire remonter', async () => {
    await seedLuffy()
    const report = await enrichBountyPosters(world.userId, {
      pinnedOnly: true,
      resolve: async () => {
        throw new Error('502 depuis Fandom')
      },
    })

    // It runs after the response, beside work that already succeeded: a fan
    // wiki being down must not turn a published chapter into an error message.
    expect(report.failures.map((failure) => failure.what)).toContain('résolution des fichiers')
    expect(report.stored).toBe(0)
  })

  it('ne joint personne quand il n’y a rien à rapatrier', async () => {
    // `postersQuietly` takes no injection point, so it is exercised on the
    // shape where reaching the network would be a bug rather than a slow test:
    // a library holding no character the manifest knows.
    const nobody = await createEntity(world, 'character', 1)
    await addLabel(world, nobody, 'Makino', 'true_name', 1, 100)

    const report = await postersQuietly(world.userId)
    expect(report?.considered).toBe(0)
    expect(report?.failures).toEqual([])
  })

  it('ne rend rien quand la bibliothèque ne contient aucun personnage du manifeste', async () => {
    const nobody = await createEntity(world, 'character', 1)
    await addLabel(world, nobody, 'Makino', 'true_name', 1, 100)

    const { asked, resolve, download } = stubs()
    const report = await enrichBountyPosters(world.userId, { pinnedOnly: true, resolve, download })

    expect(report.considered).toBe(0)
    expect(asked).toEqual([])
    expect(await storedChapters()).toEqual([])
  })
})

describe('le bouton reste la passe complète', () => {
  it('lit la galerie et rapporte ce qui n’a pas de fichier', async () => {
    await seedLuffy()
    const { resolve, download } = stubs()

    /*
     * The manual pass is given a gallery rather than fetching one, but it is
     * the same code path: heuristics on, every printing judged, and the
     * unresolved list is what the panel prints for somebody to act on.
     */
    const report = await enrichBountyPosters(world.userId, {
      gallery: [],
      resolve,
      download,
    })

    const unpinned = luffy.rows.filter((row) => !row.file).length
    expect(report.unresolved.length).toBe(unpinned)
    expect(report.unresolved.some((line) => line.includes('Monkey D. Luffy'))).toBe(true)
  })

  /*
   * Le tirage écarté, et pourquoi il n'est pas « manquant ».
   *
   * Luffy's thirty million has a file, somebody verified it, and it was drawn
   * by the anime. Both halves of that are load-bearing: the pass must not fetch
   * a picture the reader will never be shown, and it must not file the printing
   * under « the wiki has nothing », which would send the next person looking
   * for a file that is already written on the line.
   */
  it('écarte une image dessinée hors du manga sans la ranger dans les manquants', async () => {
    await seedLuffy()
    const { downloaded, resolve, download } = stubs()

    const report = await enrichBountyPosters(world.userId, {
      gallery: [],
      resolve,
      download,
    })

    const printing = `Monkey D. Luffy · ${formatBerries(30_000_000)} (ch. 96)`
    expect(report.declined).toContain(printing)
    expect(report.unresolved).not.toContain(printing)

    // Nothing was fetched for it, and nothing was stored at its chapter.
    expect(downloaded.some((ref) => ref.includes('Luffy Receives His First Bounty'))).toBe(false)
    expect(await storedChapters()).not.toContain(96)
  })
})
