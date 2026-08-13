import { fetchJson, FetchFailure, pause } from '../http.ts'
import { eraOfFileName, eraOfImageUrl, fileWords, type ReaderEra } from '../era.ts'
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
 *
 * **It is also the only source that dates its pictures**, which is why it is
 * now asked about entities the catalogues *did* place. The lead image of a
 * character's article is the current one, and « current » on the other side of
 * the ellipse is a spoiler: measured on 2026-08-13, the picture at the top of
 * « Nami » is `Nami_Anime_Post_Timeskip_Infobox.png`. The file names are the
 * evidence and the remedy at once — the same article also lists
 * `Nami_Manga_Pre_Timeskip_Infobox.png`, which is the face a reader at chapter
 * 8 should be looking at. See era.ts.
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

/** What the portraits are downsized to. Matches store.ts's own full width. */
const PORTRAIT_WIDTH = 512

interface Answer {
  found: boolean
  imageUrl: string | null
  /** True when the title only exists as a section of another page. */
  fragmentRedirect: boolean
  /** The title MediaWiki resolved to, which is what a reader would check. */
  title: string | null
  /** Every file the article uses, as `File:…` titles. */
  files: string[]
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
        images?: Array<{ title?: string }>
      }
    >
  }
}

/**
 * One request, two answers: the lead image and the article's file list.
 *
 * `pageimages` and `images` are separate properties of the same `query`, so
 * asking for both costs exactly what asking for one used to. That matters: the
 * era-aware portrait below would otherwise double the number of requests this
 * application makes to a wiki that owes it nothing.
 */
async function ask(title: string, lang: Lang): Promise<Answer> {
  const url = `${WIKIS[lang]}?${new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'pageimages|images',
    piprop: 'original',
    imlimit: 'max',
    redirects: '1',
    titles: title,
  })}`

  const empty: Answer = {
    found: false,
    imageUrl: null,
    fragmentRedirect: false,
    title: null,
    files: [],
  }

  let data: QueryResponse
  try {
    data = await fetchJson<QueryResponse>(url, { attempts: 2 })
  } catch (error: unknown) {
    // A wiki that will not answer is not a wiki that says no. Either way this
    // entity keeps no picture, and the caller moves on.
    if (error instanceof FetchFailure) return empty
    throw error
  }

  const fragmentRedirect = (data.query?.redirects ?? []).some(
    (redirect) => Boolean(redirect.tofragment),
  )

  const pages = Object.values(data.query?.pages ?? {})
  const page = pages[0]
  if (!page) return { ...empty, fragmentRedirect }

  return {
    found: page.missing === undefined,
    imageUrl: page.original?.source ?? null,
    fragmentRedirect,
    title: page.title ?? null,
    files: (page.images ?? [])
      .map((image) => image.title ?? '')
      .filter((title) => title !== ''),
  }
}

/**
 * Every picture the wiki offers for one name, best-dated first.
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
 *
 * Returns a list rather than one picture because an article can offer the same
 * subject on both sides of the ellipse, and which of the two a given reader may
 * see is not this function's call — it is the boundary's, applied when the
 * picture is read. Storing only the one that suits today's reader would make
 * the answer depend on when enrichment happened to run.
 */
export async function lookupFandomImages(name: string): Promise<ImageCandidate[]> {
  const title = name.trim()
  if (title === '') return []

  const en = await ask(title, 'en')
  if (en.found && !en.fragmentRedirect) {
    const found = await toCandidates(en, 'en', title)
    if (found.length > 0) return found
  }

  for (const variant of frenchTitles(title)) {
    await pause(PACE_MS)
    const fr = await ask(variant, 'fr')
    if (fr.found && !fr.fragmentRedirect) {
      const found = await toCandidates(fr, 'fr', variant)
      if (found.length > 0) return found
    }
  }

  return []
}

/**
 * Only the dated pictures, and only from the English wiki.
 *
 * For a subject something else has already identified and illustrated, the one
 * thing missing is a date — so an undated answer here is no answer, and the
 * whole lookup is worth exactly one request when the article does not exist.
 *
 * English only, deliberately. `lookupFandomImages` falls back to the French
 * wiki because a bar or a village may only have an article there; that reason
 * does not apply to a character a catalogue already placed, and the French wiki
 * names its files in French, so it carries none of the markers this reads. Two
 * requests saved per character, on a wiki that owes us nothing.
 */
export async function lookupFandomPortraits(
  name: string,
): Promise<ImageCandidate[]> {
  const title = name.trim()
  if (title === '') return []

  const answer = await ask(title, 'en')
  if (!answer.found || answer.fragmentRedirect) return []

  const found = await toCandidates(answer, 'en', title)
  return found.filter((candidate) => candidate.era !== 'unknown')
}

/**
 * The same name, with the article the wiki files it under.
 *
 * The graph holds « Équipage du Roux »; the article is « L'Équipage du Roux ».
 *
 * Mostly the wiki already knows that. Asked for the bare name, the French wiki
 * answers with a page redirect to the article and its picture — measured, not
 * assumed. This is for the titles it has no redirect for, so it is *one* extra
 * attempt rather than the four an untested guess would have made: every one of
 * them is a request to a free wiki, and the entities that reach this code are
 * precisely the ones most likely to have no article under any spelling.
 *
 * Still an exact-title match, which is the whole guarantee — a determiner
 * cannot make « Équipage du Roux » resolve to something else.
 */
export function frenchTitles(title: string): string[] {
  const bare = title.trim()
  if (bare === '') return []

  // Already carries one: asking again with a second article would be nonsense.
  if (/^(l'|le |la |les )/i.test(bare)) return [bare]

  const first =
    bare.normalize('NFD').replace(/\p{Diacritic}/gu, '')[0]?.toLowerCase() ?? ''
  const elides = 'aeiouyh'.includes(first)

  return [bare, elides ? `L'${bare}` : `Les ${bare}`]
}

/**
 * What one resolved article is worth: its dated portraits, then its lead image.
 *
 * Dated first because that is the order of usefulness — a picture that states
 * which side of the ellipse it belongs to can be shown to the right reader,
 * and the lead image is the one that cannot. They are all kept: the boundary
 * decides between them at read time, per reader, which is the only place that
 * knows where the reader is.
 */
async function toCandidates(
  answer: Answer,
  lang: Lang,
  asked: string,
): Promise<ImageCandidate[]> {
  const resolved = answer.title ?? asked
  const pageUrl = `${ARTICLES[lang]}${encodeURIComponent(resolved.replace(/ /g, '_'))}`
  const attribution =
    lang === 'fr' ? 'onepiece.fandom.com (fr)' : 'onepiece.fandom.com'

  const base = {
    source: 'fandom' as const,
    // The wiki illustrates things no catalogue kind covers — a bar, a village,
    // a crew — and does not say which. `page` is what we actually know.
    kind: 'page' as const,
    names: [resolved],
    pageUrl,
    attribution,
    firstAppearanceChapter: null,
  }

  const candidates: ImageCandidate[] = []

  const dated = bestPortraits(answer.files, resolved)
  const urls = await fileUrls(Object.values(dated), lang)

  for (const [era, file] of Object.entries(dated) as Array<[ReaderEra, string]>) {
    const url = urls.get(file)
    if (!url) continue
    candidates.push({
      ...base,
      // Distinct from the lead image's ref below, which is deliberately left as
      // it was: a re-run must recognise a portrait it already stored rather
      // than filing a second copy of it.
      sourceRef: `${lang}:${resolved}#${file}`,
      imageUrl: url,
      era,
    })
  }

  /*
   * The lead image, unless a dated portrait already covers its period.
   *
   * Asked about « Nami », the wiki's lead image is her anime portrait from
   * after the ellipse — and the article also yields her manga portrait from
   * after the ellipse, which is the one this application prefers anyway. Two
   * pictures of the same woman at the same moment is a download, a re-encode
   * and a row for something no reader will ever be shown. An *undated* lead is
   * kept whatever else was found: it is the only thing that can serve a period
   * the article did not illustrate.
   */
  const leadEra = answer.imageUrl ? eraOfImageUrl(answer.imageUrl) : 'unknown'
  const redundant =
    leadEra !== 'unknown' && candidates.some((candidate) => candidate.era === leadEra)

  if (
    answer.imageUrl &&
    !redundant &&
    !candidates.some((c) => c.imageUrl === answer.imageUrl)
  ) {
    candidates.push({
      ...base,
      // The resolved title, not the label we asked with: two of our entities
      // resolving to the same article are the same picture, and the unique index
      // on (entity, source, ref) should see that.
      sourceRef: `${lang}:${resolved}`,
      imageUrl: answer.imageUrl,
      // Read from the file name in the URL. Usually `unknown`; for a character
      // who lived through the ellipse it usually is not, and that is precisely
      // the picture this whole change exists to withhold.
      era: leadEra,
    })
  }

  return candidates
}

/**
 * Words that mean « this file is the article's reference picture of its
 * subject », and words that mean it is anything else.
 *
 * Measured against the articles of every Straw Hat and a dozen others: the
 * convention is `<Name> <Manga|Anime> <Pre|Post> Timeskip Infobox.png`, with
 * `<Name> Pre Timeskip Portrait.png` as an older variant. Requiring one of
 * those two words is what keeps the game artwork out — `Nami Pre Timeskip
 * Pirate Warriors 4.png` and `Zoro Pre-Timeskip Burning Will.png` are dated,
 * on-subject, and not what anyone means by a portrait — without needing a list
 * of every video game the franchise has ever had.
 */
const PORTRAIT_WORDS = ['infobox', 'portrait'] as const

/**
 * Refused outright, whatever else the name says.
 *
 * Short, because the portrait requirement above already does most of the work.
 * These are the things that get *named* like a portrait and are not one: a
 * wanted poster is a drawing of a drawing, a concept sheet is production
 * material, an outfit shot frames the clothes rather than the face.
 */
const REFUSED = [
  ' movie ',
  ' film ',
  ' special ',
  ' ova ',
  ' live action ',
  ' game ',
  ' opening ',
  ' ending ',
  ' wanted ',
  ' bounty ',
  ' poster ',
  ' cover ',
  ' concept ',
  ' outfit ',
  ' color scheme ',
  ' colored ',
  ' cosplay ',
] as const

/**
 * The best dated portrait on each side of the ellipse, or neither.
 *
 * `subject` is the resolved article title, and a file must carry one of its
 * words to be considered. That check is not decoration: an article's file list
 * includes what its templates drag in — `153rd Branch Infobox.png` sits in
 * Koby's — and the failure mode of taking one of those is a confident, wrong
 * face, which this domain treats as worse than no face at all.
 *
 * Manga over anime, deliberately. This is a companion to a manga you are
 * reading; the panel art is what the pages you just turned look like. The wiki
 * offers both, named apart, so the preference costs nothing.
 */
export function bestPortraits(
  files: string[],
  subject: string,
): Partial<Record<ReaderEra, string>> {
  const marks = subjectWords(subject)
  const best: Partial<Record<ReaderEra, { file: string; score: number }>> = {}

  for (const file of files) {
    const era = eraOfFileName(file)
    if (era === 'unknown') continue

    const words = fileWords(file)
    if (!PORTRAIT_WORDS.some((word) => words.includes(word))) continue
    if (REFUSED.some((word) => words.includes(word))) continue
    if (!marks.some((mark) => words.includes(` ${mark} `))) continue

    const score =
      (words.includes(' manga ') ? 50 : 0) +
      (words.includes(' anime ') ? -20 : 0) +
      (words.includes('infobox') ? 20 : 0) +
      (words.includes('portrait') ? 15 : 0)

    const held = best[era]
    if (!held || score > held.score) best[era] = { file, score }
  }

  return {
    ...(best.pre_timeskip ? { pre_timeskip: best.pre_timeskip.file } : {}),
    ...(best.post_timeskip ? { post_timeskip: best.post_timeskip.file } : {}),
  }
}

/**
 * The words of a title that identify its subject.
 *
 * Four letters or more, because « D » in « Monkey D. Luffy » identifies
 * nothing and would let any file through. A title made only of short words —
 * they exist — keeps them all rather than being left with no check at all.
 */
function subjectWords(subject: string): string[] {
  const words = fileWords(subject).trim().split(' ').filter(Boolean)
  const long = words.filter((word) => word.length >= 4)
  return long.length > 0 ? long : words
}

/** Addresses for a handful of `File:` titles, in one request. Empty on failure. */
async function fileUrls(
  titles: string[],
  lang: Lang,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (titles.length === 0) return urls

  const url = `${WIKIS[lang]}?${new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: String(PORTRAIT_WIDTH),
    titles: titles.join('|'),
  })}`

  interface InfoResponse {
    query?: {
      pages?: Record<
        string,
        {
          title?: string
          imageinfo?: Array<{ url?: string; thumburl?: string }>
        }
      >
    }
  }

  let data: InfoResponse
  try {
    data = await fetchJson<InfoResponse>(url, { attempts: 2 })
  } catch (error: unknown) {
    // No addresses means no dated portraits, and the lead image still stands.
    // Degrading to yesterday's behaviour is the right failure here.
    if (error instanceof FetchFailure) return urls
    throw error
  }

  for (const page of Object.values(data.query?.pages ?? {})) {
    const info = page.imageinfo?.[0]
    // The thumbnail, not the original: the wiki serves 2.7 MB PNGs for some of
    // these and store.ts downsizes to 512 px anyway. `thumburl` is the original
    // when the file is already narrower than that.
    const address = info?.thumburl ?? info?.url
    if (page.title && address) urls.set(page.title, address)
  }

  return urls
}
