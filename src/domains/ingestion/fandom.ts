/**
 * The chapter, fetched from the wiki instead of typed.
 *
 * ADR 0008 ruled this out — "aucun scraping, rien de téléchargé
 * automatiquement, l'utilisateur colle ce qu'il a lu" — and that ruling is
 * reversed here deliberately, by the owner of the library, for a reason the
 * numbers make plain: the pipeline needs a detailed summary per chapter and
 * there are more than a thousand chapters. Pasting two texts each was the real
 * cost of the whole product.
 *
 * What made it a rule was never the fetching. It was fetching *arbitrary* URLs
 * found in documents, which turns an import into a server-side request forgery,
 * and it is why this module takes a chapter **number** and nothing else. The two
 * endpoints are constants in this file; a URL in the field is read for its digits
 * and then thrown away. Nothing a document contains can direct a request.
 *
 * Two summaries, one per language, which is exactly the pair the extraction step
 * wants (migration 0017). Which one is citable is decided by `citableAndParallel`
 * below, and it is not the obvious one — see the reasoning there.
 *
 * The content is Fandom's, under CC BY-SA. Stored in a private library for one
 * reader, which is what this tool is; anything published from it would owe the
 * wiki an attribution.
 */

/** Where the summaries come from. Constants, never taken from input. */
const ENDPOINTS = {
  en: {
    api: 'https://onepiece.fandom.com/api.php',
    page: (chapter: number) => `Chapter ${chapter}`,
    /** The section holding the detailed retelling, and its near misses. */
    section: 'Long Summary',
    aliases: ['long summary'],
    url: (chapter: number) => `https://onepiece.fandom.com/wiki/Chapter_${chapter}`,
  },
  fr: {
    api: 'https://onepiece.fandom.com/fr/api.php',
    page: (chapter: number) => `Chapitre ${chapter}`,
    section: 'Résumé approfondi',
    aliases: ['résumé approfondi', 'resume approfondi', 'résumé détaillé'],
    url: (chapter: number) => `https://onepiece.fandom.com/fr/wiki/Chapitre_${chapter}`,
  },
} as const

export type FandomLanguage = keyof typeof ENDPOINTS

export interface FandomSummary {
  language: FandomLanguage
  /** The wiki page it came from, for attribution and for checking. */
  page: string
  url: string
  /** The section heading as the wiki actually spells it today. */
  section: string
  /** Paragraphs, already stripped of markup. Blank when nothing was found. */
  text: string
}

export interface FandomFetch {
  chapterNumber: number
  summaries: FandomSummary[]
  /** Why a language is missing, in the words the reviewer needs. */
  problems: Array<{ language: FandomLanguage; reason: string }>
}

/** Injected so tests never touch the network, and never need to. */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export class FandomError extends Error {}

/**
 * Which text the graph is built from, and which one only names things.
 *
 * English is the citable source when the wiki has it, and that is the opposite
 * of what French-first intuition suggests. Two reasons, both about what each
 * text actually is:
 *
 *   The English "Long Summary" is the detailed one. The French wiki's
 *   "Résumé approfondi" is a shorter retelling where it exists at all, and the
 *   graph can only ever contain what its citable text states — a thinner source
 *   is a thinner graph, chapter after chapter, and no amount of review recovers
 *   a fact the source never mentioned.
 *
 *   The French text is worth more as the naming aid than as the source. What it
 *   uniquely carries is the *convention*: how a French reader renders « Straw
 *   Hat Pirates ». That is precisely the question the model cannot answer from
 *   an English text and the one thing it is asked to stop guessing at.
 *
 * What it costs is that excerpts are quoted in English, which the review centre
 * and the entity sheets will show. That was already the accepted trade in ADR
 * 0008: a citation is a copy, verified character by character, and translating
 * it would make it match nothing. Everything the model *writes* stays French.
 *
 * With only one language available there is no choice to make: it is the source,
 * and there is no naming aid.
 */
export function citableAndParallel(fetched: FandomFetch): {
  citable: FandomSummary
  naming: FandomSummary | null
} {
  const english = fetched.summaries.find((summary) => summary.language === 'en')
  const french = fetched.summaries.find((summary) => summary.language === 'fr')

  if (english) return { citable: english, naming: french ?? null }
  if (french) return { citable: french, naming: null }

  // fetchChapterSummaries throws rather than return nothing, so this is
  // unreachable; saying so beats a non-null assertion that hides the reason.
  throw new FandomError('Aucun résumé à publier pour ce chapitre.')
}

/**
 * The chapter number, from a URL or from the number itself.
 *
 * Accepts both wikis' spellings and a bare number, because the field is a
 * paste-anything field: a URL copied from a browser, or "1042" typed by someone
 * who knows what they want. Everything else in the string is discarded — that
 * discarding is the security property, not a convenience.
 */
export function chapterNumberFrom(input: string): number {
  const value = decodeURIComponent(input.trim())

  const bare = value.match(/^\d{1,5}$/)
  if (bare) return Number(bare[0])

  const named = value.match(/(?:chapter|chapitre)[_\s-]*(\d{1,5})/iu)
  if (named?.[1]) return Number(named[1])

  throw new FandomError(
    'Impossible de lire un numéro de chapitre dans cette adresse. ' +
      'Collez l’URL de la page du chapitre, ou simplement son numéro.',
  )
}

/**
 * One chapter, in both languages, as far as the wiki has them.
 *
 * A missing language is not an error: the French wiki lags the English one by
 * hundreds of chapters, and a chapter that exists only in English is still
 * perfectly importable — it just arrives without its naming aid. What would be
 * an error is silence about it, so every miss comes back with its reason.
 */
export async function fetchChapterSummaries(
  chapterNumber: number,
  fetcher: Fetcher = defaultFetcher,
): Promise<FandomFetch> {
  const summaries: FandomSummary[] = []
  const problems: FandomFetch['problems'] = []

  for (const language of ['fr', 'en'] as const) {
    try {
      summaries.push(await fetchOne(language, chapterNumber, fetcher))
    } catch (error) {
      problems.push({
        language,
        reason: error instanceof Error ? error.message : 'Erreur inconnue.',
      })
    }
  }

  if (summaries.length === 0) {
    throw new FandomError(
      `Aucun résumé trouvé pour le chapitre ${chapterNumber}. ` +
        problems.map((problem) => `${problem.language} : ${problem.reason}`).join(' · '),
    )
  }

  return { chapterNumber, summaries, problems }
}

/**
 * How many chapters one range may ask for.
 *
 * Not a performance limit — the wiki answers a chapter in well under a second.
 * It is a limit on how much prose a person is agreeing to store without having
 * read it. Twenty chapters is a volume and a half, already more than anyone
 * proof-reads in one sitting; a field that accepted "1 to 1100" would turn a
 * typo into a library.
 */
export const MAX_RANGE_LENGTH = 20

/** How many chapters are in flight at once. Four requests each, so: politely. */
const RANGE_CONCURRENCY = 3

export interface FandomRangeEntry {
  chapterNumber: number
  /** What came back, or null when the wiki has this chapter in no language. */
  fetched: FandomFetch | null
  /** Why nothing came back. Set exactly when `fetched` is null. */
  error: string | null
}

/**
 * A run of consecutive chapters, each fetched independently.
 *
 * One chapter failing is an outcome, not an abort. The French wiki lags the
 * English one by hundreds of chapters and either can have a hole in it; a range
 * of ten that loses one must still import the nine, or the feature is unusable
 * exactly where it is most needed. So every chapter comes back carrying either
 * its summaries or its reason, and the form shows both before anything is
 * stored.
 *
 * Results are in chapter order regardless of which finished first — the order
 * is the one thing the caller cannot recompute, since it is what the queue will
 * be processed in.
 */
export async function fetchChapterRange(
  from: number,
  to: number,
  fetcher: Fetcher = defaultFetcher,
): Promise<FandomRangeEntry[]> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
    throw new FandomError('Un intervalle se donne en entiers positifs.')
  }
  if (to < from) {
    throw new FandomError(
      `L’intervalle ${from}–${to} va à l’envers : le premier chapitre doit venir avant le dernier.`,
    )
  }

  const length = to - from + 1
  if (length > MAX_RANGE_LENGTH) {
    throw new FandomError(
      `${length} chapitres d’un coup, au-delà des ${MAX_RANGE_LENGTH} autorisés. ` +
        'Ce sont des textes que vous allez relire avant de les stocker : ' +
        'au-delà, personne ne les relit.',
    )
  }

  const numbers = Array.from({ length }, (_, offset) => from + offset)
  const results = new Map<number, FandomRangeEntry>()
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      const chapterNumber = numbers[index]
      if (chapterNumber === undefined) return

      try {
        results.set(chapterNumber, {
          chapterNumber,
          fetched: await fetchChapterSummaries(chapterNumber, fetcher),
          error: null,
        })
      } catch (error) {
        results.set(chapterNumber, {
          chapterNumber,
          fetched: null,
          error: error instanceof Error ? error.message : 'Erreur inconnue.',
        })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(RANGE_CONCURRENCY, numbers.length) }, () => worker()),
  )

  return numbers.map((chapterNumber) => {
    const entry = results.get(chapterNumber)
    if (!entry) throw new Error(`Chapitre ${chapterNumber} sans résultat.`)
    return entry
  })
}

async function fetchOne(
  language: FandomLanguage,
  chapterNumber: number,
  fetcher: Fetcher,
): Promise<FandomSummary> {
  const endpoint = ENDPOINTS[language]
  const page = endpoint.page(chapterNumber)

  const sections = await call(fetcher, endpoint.api, {
    action: 'parse',
    page,
    prop: 'sections',
    format: 'json',
  })

  const index = sectionIndex(sections, endpoint.section, endpoint.aliases)
  if (index === null) {
    throw new FandomError(
      `Section « ${endpoint.section} » introuvable sur « ${page} ».`,
    )
  }

  const body = await call(fetcher, endpoint.api, {
    action: 'parse',
    page,
    section: index.index,
    prop: 'text',
    format: 'json',
  })

  const html = readPath(body, ['parse', 'text', '*'])
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new FandomError(`La section « ${index.name} » de « ${page} » est vide.`)
  }

  const text = htmlToParagraphs(html)
  if (text.length === 0) {
    throw new FandomError(
      `La section « ${index.name} » de « ${page} » ne contient aucun paragraphe.`,
    )
  }

  return { language, page, url: endpoint.url(chapterNumber), section: index.name, text }
}

async function call(
  fetcher: Fetcher,
  api: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  )
  const response = await fetcher(`${api}?${query.toString()}`)

  if (!response.ok) {
    throw new FandomError(`Le wiki a répondu ${response.status}.`)
  }

  const data: unknown = await response.json()
  const error = readPath(data, ['error', 'info'])
  if (typeof error === 'string') {
    // MediaWiki answers 200 with an error object for a page that does not
    // exist, which is the ordinary case here: a chapter the wiki has not
    // written up yet.
    throw new FandomError(error)
  }
  return data
}

/**
 * Which section holds the detailed summary.
 *
 * Exact match first, then a short list of the spellings each wiki has actually
 * used. A wiki renames its headings, and failing on "Résumé détaillé" because
 * the constant says "approfondi" would be a break with no cause a reader could
 * see. Not a fuzzy search: an unrecognised heading is reported, never guessed
 * at, because the wrong section is a summary of something else entirely.
 */
function sectionIndex(
  parsed: unknown,
  wanted: string,
  aliases: readonly string[],
): { index: string; name: string } | null {
  const sections = readPath(parsed, ['parse', 'sections'])
  if (!Array.isArray(sections)) return null

  const named = sections
    .map((section) => {
      const record = section as Record<string, unknown>
      return {
        index: typeof record.index === 'string' ? record.index : String(record.index ?? ''),
        name: decodeEntities(stripTags(typeof record.line === 'string' ? record.line : '')).trim(),
      }
    })
    .filter((section) => section.index.length > 0 && section.name.length > 0)

  const exact = named.find(
    (section) => section.name.toLowerCase() === wanted.toLowerCase(),
  )
  if (exact) return exact

  const alias = named.find((section) =>
    aliases.some((candidate) => section.name.toLowerCase().includes(candidate)),
  )
  return alias ?? null
}

/**
 * MediaWiki's HTML, reduced to the paragraphs the pipeline slices.
 *
 * Written by hand rather than with a parser dependency, which is defensible for
 * exactly one reason: the input is not arbitrary HTML from the web. It is the
 * output of one renderer, whose shape is a heading, paragraphs, and the
 * furniture below — edit links, reference superscripts, navigation tables — all
 * of it identifiable by tag or class.
 *
 * Everything that is not a paragraph or a list item is dropped rather than
 * flattened. A navigation table rendered as text would become a passage of
 * chapter numbers, and a passage is a citable unit: a fact anchored to a row of
 * links is a fact whose evidence proves nothing.
 */
export function htmlToParagraphs(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|table|figure|aside)[\s\S]*?<\/\1>/gi, '')
    .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, '')
    .replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/span>/gi, '')
    .replace(/<h[1-6][\s\S]*?<\/h[1-6]>/gi, '')

  const blocks = [...cleaned.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) =>
    decodeEntities(stripTags(match[2] ?? ''))
      .replace(/\s+/g, ' ')
      .trim(),
  )

  return blocks.filter((block) => block.length > 0).join('\n\n')
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

/**
 * The entities MediaWiki actually emits, and the numeric forms.
 *
 * A full table would be a dependency in disguise; this covers what the renderer
 * escapes — the five XML ones — plus the spaces and dashes that appear in wiki
 * prose. Anything else arrives as UTF-8 already.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
}

/** Read a nested field without trusting any of the levels to exist. */
function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      // MediaWiki asks clients to identify themselves and rate-limits the ones
      // that do not. Naming the tool is also the honest thing to do.
      'user-agent': 'onepiece-explorer (private reading tool; contact via repository)',
    },
    // A wiki that hangs must not hang an import.
    signal: AbortSignal.timeout(20_000),
  })
  return response
}
