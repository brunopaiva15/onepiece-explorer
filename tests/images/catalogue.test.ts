import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cataloguePath, loadCatalogue } from '@/domains/images/catalogue.ts'
import type { Catalogue } from '@/domains/images/types.ts'

/**
 * Where the image catalogue is allowed to live.
 *
 * This is the bug that made the whole illustration feature look absent rather
 * than broken. The cache was written to `var/cache/` next to the source, which
 * is right on a machine you own and impossible on a serverless deployment,
 * where the bundle is read-only: `mkdir` threw EROFS, the throw came out of
 * `loadCatalogue`, the enrichment reported "impossible", and not one entity was
 * ever illustrated in production. Nothing was wrong with the pictures.
 *
 * Two properties then. The default path has to be writable wherever the code
 * actually runs, and — because that is exactly the assumption that was wrong
 * once — a cache that cannot be written must cost a refetch, never the
 * catalogue that was already in hand.
 */

const directories: string[] = []
const vars = ['IMAGE_CATALOGUE_PATH', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME'] as const
const saved = new Map(vars.map((name) => [name, process.env[name]]))

afterEach(async () => {
  for (const name of vars) {
    const previous = saved.get(name)
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ope-catalogue-'))
  directories.push(dir)
  return dir
}

const catalogue = (count: number): Catalogue => ({
  fetchedAt: new Date().toISOString(),
  candidates: Array.from({ length: count }, (_, index) => ({
    source: 'onepieceapi' as const,
    sourceRef: `c${index}`,
    kind: 'character' as const,
    names: [`Personnage ${index}`],
    imageUrl: 'https://example.invalid/x.webp',
    pageUrl: 'https://example.invalid/x',
    attribution: 'onepieceapi',
    firstAppearanceChapter: 1,
    era: 'unknown' as const,
  })),
  failures: [],
})

describe('where the catalogue is cached', () => {
  it('writes beside the code on a machine you own', () => {
    delete process.env.IMAGE_CATALOGUE_PATH
    delete process.env.VERCEL
    delete process.env.AWS_LAMBDA_FUNCTION_NAME

    expect(cataloguePath()).toBe(
      path.join(process.cwd(), 'var', 'cache', 'image-catalogue.json'),
    )
  })

  it('writes to the one writable directory on a read-only deployment', () => {
    delete process.env.IMAGE_CATALOGUE_PATH
    process.env.VERCEL = '1'

    expect(cataloguePath().startsWith(tmpdir())).toBe(true)
  })

  it('obeys an explicit path over everything else', () => {
    process.env.VERCEL = '1'
    process.env.IMAGE_CATALOGUE_PATH = '/somewhere/precis.json'

    expect(cataloguePath()).toBe('/somewhere/precis.json')
  })
})

describe('loading it', () => {
  it('keeps the catalogue when the cache cannot be written, and says why', async () => {
    // A path whose parent cannot be created: the deployment case, reproduced.
    process.env.IMAGE_CATALOGUE_PATH = '/proc/self/cmdline/impossible/catalogue.json'

    const loaded = await loadCatalogue({ build: async () => catalogue(3) })

    expect(loaded.candidates).toHaveLength(3)
    expect(loaded.cacheNote).toContain('non mis en cache')
  })

  it('writes the cache and says nothing when it can', async () => {
    const file = path.join(await scratch(), 'nested', 'catalogue.json')
    process.env.IMAGE_CATALOGUE_PATH = file

    const loaded = await loadCatalogue({ build: async () => catalogue(2) })

    expect(loaded.cacheNote).toBeUndefined()
    const written = JSON.parse(await readFile(file, 'utf8')) as Catalogue
    expect(written.candidates).toHaveLength(2)
  })

  it('refuses to replace a good cache with an empty result', async () => {
    // Three sources down means the network is down, not that One Piece has no
    // characters. Writing that would turn an outage into a permanent loss.
    const file = path.join(await scratch(), 'catalogue.json')
    process.env.IMAGE_CATALOGUE_PATH = file

    await loadCatalogue({ build: async () => catalogue(4) })
    const loaded = await loadCatalogue({
      refresh: true,
      build: async () => catalogue(0),
    })

    expect(loaded.candidates).toHaveLength(4)
  })
})
