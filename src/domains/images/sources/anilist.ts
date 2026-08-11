import { fetchJson, pause } from '../http.ts'
import type { ImageCandidate } from '../types.ts'

/**
 * AniList — portraits for the characters the other two miss.
 *
 * 500 One Piece characters with a picture each, against onepieceapi's 369. The
 * overlap is large but not total, and where both have someone, onepieceapi wins
 * on ranking because it also knows the chapter of first appearance and AniList
 * does not.
 *
 * Two details of this API that shape the code:
 *
 *   Names arrive as `full` in *given-family* order — "Luffy Monkey", "Zoro
 *   Roronoa" — where the manga and the other catalogues use "Monkey D. Luffy".
 *   Both orderings are emitted so the matcher can find either; reordering is
 *   left to the token comparison rather than done here with a rule that would
 *   be wrong for mononyms.
 *
 *   The published rate limit is 30 requests a minute, and the response headers
 *   confirm it (`x-ratelimit-limit: 30`). Twenty pages of 25 at one every two
 *   seconds sits at half of that.
 */

const ENDPOINT = 'https://graphql.anilist.co'
/** One Piece, as an anime. The manga entry returns the same 500 characters. */
const MEDIA_ID = 21
const PER_PAGE = 25
const MAX_PAGES = 20
const PACE_MS = 2_000

const QUERY = `
  query ($media: Int!, $page: Int!, $perPage: Int!) {
    Media(id: $media) {
      characters(page: $page, perPage: $perPage, sort: FAVOURITES_DESC) {
        pageInfo { hasNextPage }
        nodes {
          id
          name { full native alternative }
          image { large }
          siteUrl
        }
      }
    }
  }
`

interface Node {
  id: number
  name?: {
    full?: string | null
    native?: string | null
    alternative?: Array<string | null> | null
  } | null
  image?: { large?: string | null } | null
  siteUrl?: string | null
}

interface Payload {
  data?: {
    Media?: {
      characters?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Node[] } | null
    } | null
  }
  errors?: Array<{ message?: string }>
}

export async function fetchAniList(): Promise<ImageCandidate[]> {
  const candidates: ImageCandidate[] = []

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await fetchJson<Payload>(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { media: MEDIA_ID, page, perPage: PER_PAGE },
      }),
    })

    if (payload.errors?.length) {
      throw new Error(
        `AniList : ${payload.errors.map((error) => error.message ?? '?').join(', ')}`,
      )
    }

    const block = payload.data?.Media?.characters
    const nodes = block?.nodes ?? []
    if (nodes.length === 0) break

    for (const node of nodes) {
      const candidate = toCandidate(node)
      if (candidate) candidates.push(candidate)
    }

    if (!block?.pageInfo?.hasNextPage) break
    await pause(PACE_MS)
  }

  return candidates
}

function toCandidate(node: Node): ImageCandidate | null {
  const image = node.image?.large
  if (!image) return null

  const names = new Set<string>()
  const full = node.name?.full?.trim()
  if (full) {
    names.add(full)
    // "Luffy Monkey" is also "Monkey Luffy" to anyone reading the manga.
    const words = full.split(/\s+/)
    if (words.length === 2) names.add(`${words[1]} ${words[0]}`)
  }
  const native = node.name?.native?.trim()
  if (native) names.add(native)
  for (const alternative of node.name?.alternative ?? []) {
    const value = alternative?.trim()
    if (value) names.add(value)
  }

  if (names.size === 0) return null

  return {
    source: 'anilist',
    sourceRef: String(node.id),
    kind: 'character',
    names: [...names],
    imageUrl: image,
    pageUrl: node.siteUrl ?? `https://anilist.co/character/${node.id}`,
    attribution: 'AniList',
    firstAppearanceChapter: null,
  }
}
