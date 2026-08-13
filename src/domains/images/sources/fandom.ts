import { fetchJson, FetchFailure, pause } from '../http.ts'
import type { ImageCandidate } from '../types.ts'

/**
 * The wiki, asked one title at a time.
 *
 * The other three sources are catalogues: fetch twelve hundred rows once, match
 * names against them offline. This one cannot work that way and should not —
 * MediaWiki has no "give me everything" endpoint that a polite client would
 * use, and the whole point here is the long tail the catalogues do not carry:
 * bars, villages, crews, races, the Partys Bar and the Village de Fuchsia.
 *
 * So it is a *fallback*, asked only about entities nothing else could
 * illustrate, one request per name, and only when a name exists to ask about.
 *
 * **Two wikis, in order, and the order matters.** The graph is written in
 * French, so a French label is what we have to ask with. The English wiki is
 * tried first anyway because it is the larger and better illustrated of the
 * two, and a great many proper nouns are spelled identically in both — Makino,
 * Shanks, Higuma. When the English wiki has no such page, the French one
 * usually does, under exactly the label the graph holds.
 *
 * **A redirect to a section is refused.** « Bandits de Higuma » may redirect to
 * a paragraph of a larger page, and MediaWiki will happily hand back that
 * page's lead image — a picture of something else, captioned as if it were
 * this. The wiki is telling us it has no article for this thing; that is an
 * answer, and the answer is no.
 */

const WIKIS = {
  en: 'https://onepiece.fandom.com/api.php',
  fr: 'https://onepiece.fandom.com/fr/api.php',
} as const

const ARTICLES = {
  en: 'https://onepiece.fandom.com/wiki/',
  fr: 'https://onepiece.fandom.com/fr/wiki/',
} as const

type Lang = keyof typeof WIKIS

/** Between two lookups. A free, community-run wiki gets asked slowly. */
const PACE_MS = 150

interface Answer {
  found: boolean
  imageUrl: string | null
  /** True when the title only exists as a section of another page. */
  fragmentRedirect: boolean
  /** The title MediaWiki resolved to, which is what a reader would check. */
  title: string | null
}

interface QueryResponse {
  query?: {
    redirects?: Array<{ from?: string; to?: string; tofragment?: string }>
    pages?: Record<
      string,
      {
        title?: string
        missing?: string | boolean
        original?: { source?: string }
      }
    >
  }
}

async function ask(title: string, lang: Lang): Promise<Answer> {
  const url = `${WIKIS[lang]}?${new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'pageimages',
    piprop: 'original',
    redirects: '1',
    titles: title,
  })}`

  let data: QueryResponse
  try {
    data = await fetchJson<QueryResponse>(url, { attempts: 2 })
  } catch (error: unknown) {
    // A wiki that will not answer is not a wiki that says no. Either way this
    // entity keeps no picture, and the caller moves on.
    if (error instanceof FetchFailure) {
      return { found: false, imageUrl: null, fragmentRedirect: false, title: null }
    }
    throw error
  }

  const fragmentRedirect = (data.query?.redirects ?? []).some(
    (redirect) => Boolean(redirect.tofragment),
  )

  const pages = Object.values(data.query?.pages ?? {})
  const page = pages[0]
  if (!page) {
    return { found: false, imageUrl: null, fragmentRedirect, title: null }
  }

  return {
    found: page.missing === undefined,
    imageUrl: page.original?.source ?? null,
    fragmentRedirect,
    title: page.title ?? null,
  }
}

/**
 * A picture for one name, or nothing.
 *
 * English first, then French. There is no third branch: an article must really
 * exist under this title — after page redirects, never a section redirect — or
 * this returns nothing.
 *
 * The obvious extra branch is « take the English image anyway, whatever it
 * redirected to ». It would raise the hit rate and it is exactly the weak
 * signal this repository refuses everywhere else. An absence reads as « not
 * found »; a wrong face reads as « found », and nobody re-checks a portrait
 * they have already accepted.
 */
export async function lookupFandomImage(
  name: string,
): Promise<ImageCandidate | null> {
  const title = name.trim()
  if (title === '') return null

  const en = await ask(title, 'en')
  if (en.found && !en.fragmentRedirect && en.imageUrl) {
    return toCandidate(en, 'en', title)
  }

  for (const variant of frenchTitles(title)) {
    await pause(PACE_MS)
    const fr = await ask(variant, 'fr')
    if (fr.found && !fr.fragmentRedirect && fr.imageUrl) {
      return toCandidate(fr, 'fr', variant)
    }
  }

  return null
}

/**
 * The same name, with the article the wiki files it under.
 *
 * The graph holds « Équipage du Roux »; the article is « L'Équipage du Roux ».
 * That is a determiner, not a different subject, and refusing it costs a
 * picture that plainly exists. Crews, ships and organisations are where French
 * titles carry the article and our labels do not.
 *
 * Still an exact-title match, which is the whole guarantee: a determiner cannot
 * make « Équipage du Roux » resolve to something else. Two variants, not five —
 * these are requests to somebody's free wiki, and the elision rule picks the
 * only one that could be right.
 */
export function frenchTitles(title: string): string[] {
  const bare = title.trim()
  if (bare === '') return []

  // Already carries one: asking again with a second article would be nonsense.
  if (/^(l'|le |la |les )/i.test(bare)) return [bare]

  const first =
    bare.normalize('NFD').replace(/\p{Diacritic}/gu, '')[0]?.toLowerCase() ?? ''
  const elides = 'aeiouyh'.includes(first)

  return [bare, elides ? `L'${bare}` : `Le ${bare}`, `Les ${bare}`]
}

function toCandidate(answer: Answer, lang: Lang, asked: string): ImageCandidate {
  const resolved = answer.title ?? asked
  return {
    source: 'fandom',
    // The resolved title, not the label we asked with: two of our entities
    // resolving to the same article are the same picture, and the unique index
    // on (entity, source, ref) should see that.
    sourceRef: `${lang}:${resolved}`,
    // The wiki illustrates things no catalogue kind covers — a bar, a village,
    // a crew — and does not say which. `page` is what we actually know.
    kind: 'page',
    names: [resolved],
    imageUrl: answer.imageUrl!,
    pageUrl: `${ARTICLES[lang]}${encodeURIComponent(resolved.replace(/ /g, '_'))}`,
    attribution: lang === 'fr' ? 'onepiece.fandom.com (fr)' : 'onepiece.fandom.com',
    firstAppearanceChapter: null,
  }
}
