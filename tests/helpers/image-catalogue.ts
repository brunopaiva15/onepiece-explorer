import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Catalogue, ImageCandidate } from '@/domains/images/types.ts'

/**
 * A catalogue on disk, so no test ever opens a socket.
 *
 * The shapes below are copied from real responses of the three services,
 * including the parts that are awkward: AniList's given-family name ordering,
 * an epithet that is the only name a chapter uses, and a decoy ("Faux Zoro")
 * that exists in the real catalogue and is exactly what a mononym match must
 * not land on.
 */

export const CANDIDATES: ImageCandidate[] = [
  {
    source: 'onepieceapi',
    sourceRef: 'op-luffy',
    kind: 'character',
    names: ['Monkey D. Luffy', 'Monkey D. Luffy', 'モンキー・D・ルフィ', 'Straw Hat'],
    imageUrl: 'https://example.invalid/luffy.webp',
    pageUrl: 'https://example.invalid/characters/luffy',
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: 1,
    era: 'unknown',
  },
  {
    source: 'onepieceapi',
    sourceRef: 'op-zoro',
    kind: 'character',
    names: ['Roronoa Zoro', 'ロロノア・ゾロ'],
    imageUrl: 'https://example.invalid/zoro.webp',
    pageUrl: 'https://example.invalid/characters/zoro',
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: 3,
    era: 'unknown',
  },
  {
    source: 'anilist',
    sourceRef: 'al-zoro',
    kind: 'character',
    names: ['Zoro Roronoa', 'Roronoa Zoro', 'Zolo'],
    imageUrl: 'https://example.invalid/al-zoro.png',
    pageUrl: 'https://anilist.co/character/62',
    attribution: 'AniList',
    firstAppearanceChapter: null,
    era: 'unknown',
  },
  {
    source: 'anilist',
    sourceRef: 'al-fake-zoro',
    kind: 'character',
    names: ['Manjarou', 'Faux Zoro'],
    imageUrl: 'https://example.invalid/manjarou.png',
    pageUrl: 'https://anilist.co/character/99',
    attribution: 'AniList',
    firstAppearanceChapter: null,
    era: 'unknown',
  },
  {
    source: 'onepieceapi',
    sourceRef: 'op-sanji',
    kind: 'character',
    names: ['Sanji', 'サンジ'],
    imageUrl: 'https://example.invalid/sanji.webp',
    pageUrl: 'https://example.invalid/characters/sanji',
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: 43,
    era: 'unknown',
  },
  {
    source: 'api-onepiece',
    sourceRef: '1',
    kind: 'fruit',
    names: ['Gum-Gum Fruit', 'Gomu Gomu no Mi'],
    imageUrl: 'https://example.invalid/gomu.png',
    pageUrl: 'https://example.invalid/fruits/1',
    attribution: 'api-onepiece.com',
    firstAppearanceChapter: null,
    era: 'unknown',
  },
  {
    source: 'onepieceapi',
    sourceRef: 'op-merry',
    kind: 'ship',
    names: ['Going Merry', 'ゴーイングメリー号'],
    imageUrl: 'https://example.invalid/merry.webp',
    pageUrl: 'https://example.invalid/ships/merry',
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: 42,
    era: 'unknown',
  },
  {
    source: 'onepieceapi',
    sourceRef: 'op-dawn',
    kind: 'island',
    names: ['Dawn Island', 'ドーン島'],
    imageUrl: 'https://example.invalid/dawn.webp',
    pageUrl: 'https://example.invalid/islands/dawn',
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: 1,
    era: 'unknown',
  },
]

export const CATALOGUE: Catalogue = {
  fetchedAt: '2026-08-11T00:00:00.000Z',
  candidates: CANDIDATES,
  failures: [],
}

/** Write the fixture and point IMAGE_CATALOGUE_PATH at it. */
export async function useFixtureCatalogue(
  catalogue: Catalogue = CATALOGUE,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ope-catalogue-'))
  const file = path.join(dir, 'image-catalogue.json')
  await writeFile(file, JSON.stringify(catalogue), 'utf8')
  process.env.IMAGE_CATALOGUE_PATH = file
  return file
}

/**
 * A stand-in for the download step.
 *
 * Returns plausible keys without touching the network or the disk. Storage
 * itself is covered by `tests/storage/`; what these tests are about is which
 * picture gets attached to which entity, and from which chapter it shows.
 */
export function fakeDownload(): (
  userId: string,
  entityId: string,
  candidate: ImageCandidate,
) => Promise<{
  storageKey: string
  thumbKey: string
  width: number
  height: number
  bytes: number
  mime: 'image/webp'
}> {
  return async (userId, entityId, candidate) => ({
    storageKey: `${userId}/entities/${entityId}/full/${candidate.source}-${candidate.sourceRef}.webp`,
    thumbKey: `${userId}/entities/${entityId}/thumb/${candidate.source}-${candidate.sourceRef}.webp`,
    width: 512,
    height: 768,
    bytes: 40_000,
    mime: 'image/webp',
  })
}
