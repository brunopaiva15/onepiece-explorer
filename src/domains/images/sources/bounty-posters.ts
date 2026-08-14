import { fetchJson, FetchFailure, pause } from '../http.ts'
import { nameWords, type Bounty, type BountyHistory } from '../bounties.ts'

/**
 * Les avis de recherche, tels que le wiki les range.
 *
 * https://onepiece.fandom.com/wiki/Bounty/Gallery holds every wanted poster the
 * work has printed, two hundred and thirty of them, in gallery blocks whose
 * every line is a file and a caption naming who is on it. It is the one place
 * where a poster can be found by a name rather than by having been seen.
 *
 * What it does *not* hold is a chapter. The captions say « Luffy's former
 * wanted poster (pre-Dressrosa) », the files say « Seventh », and neither is a
 * position on the axis this site reads on. That half comes from bounties.ts,
 * written by hand; this module's only job is to turn (character, printing) into
 * a file, and to refuse when it cannot do it confidently.
 *
 * **Refusing is the point.** A poster is a face, an epithet and a number, and
 * attaching the wrong printing to a character is worse than attaching none: the
 * reader is shown a bounty that is not theirs, on a site whose entire claim is
 * that what it shows you is what you have read. So a candidate needs a name
 * *and* something that identifies the printing — the amount in digits, or the
 * ordinal — before it is taken. Everything else scores zero and the entity
 * keeps its portrait.
 */

const API = 'https://onepiece.fandom.com/api.php'
const GALLERY_PAGE = 'Bounty/Gallery'
export const GALLERY_URL = 'https://onepiece.fandom.com/wiki/Bounty/Gallery'
export const ATTRIBUTION = 'onepiece.fandom.com'

/** Between two lookups. A free, community-run wiki gets asked slowly. */
const PACE_MS = 150

/** Wide enough to read the number on the poster, small enough to store. */
const POSTER_WIDTH = 512

export interface GalleryEntry {
  /** `File:…`, as MediaWiki names it. */
  title: string
  /** The gallery's own caption, wiki markup stripped. */
  caption: string
  /** The heading it sits under, which is a sea or an organisation. */
  section: string
}

export interface PosterFile extends GalleryEntry {
  imageUrl: string
  pageUrl: string
  width: number | null
  height: number | null
}

interface ParseResponse {
  parse?: { wikitext?: { '*'?: string } | string }
  error?: { info?: string }
}

interface ImageInfoResponse {
  query?: {
    normalized?: Array<{ from?: string; to?: string }>
    pages?: Record<
      string,
      {
        title?: string
        missing?: string | boolean
        imageinfo?: Array<{
          url?: string
          thumburl?: string
          thumbwidth?: number
          thumbheight?: number
          descriptionurl?: string
        }>
      }
    >
  }
}

/**
 * Wiki markup, reduced to what a caption says.
 *
 * `[[Monkey D. Luffy|Luffy]]` keeps « Luffy » because that is what the caption
 * reads as, and the target is kept too: a caption that links to the article and
 * displays a nickname is naming the character twice, and both spellings are
 * worth matching against.
 */
export function plainCaption(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$1 $2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every file the gallery lists, with its caption and its heading.
 *
 * Two syntaxes, because the wiki uses both and this page uses the first: the
 * `{{Gallery|…}}` template, whose entries are `|File.png|caption` lines, and
 * the `<gallery>` tag, whose entries are `File.png|caption` without the leading
 * pipe. Parsing only the one the page happens to use today would be a parser
 * that breaks on an edit nobody told us about.
 */
export function parseGallery(wikitext: string): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  const seen = new Set<string>()
  let section = 'Wanted Posters'
  let inTemplate = false
  let inTag = false

  for (const raw of wikitext.split(/\r?\n/)) {
    const line = raw.trim()

    const heading = /^(={2,6})\s*(.+?)\s*\1$/.exec(line)
    if (heading) {
      section = plainCaption(heading[2] ?? '')
      continue
    }

    if (/^\{\{Gallery\b/i.test(line)) inTemplate = true
    if (inTemplate && line.startsWith('}}')) {
      inTemplate = false
      continue
    }
    if (/^<gallery\b/i.test(line)) {
      inTag = true
      continue
    }
    if (/^<\/gallery>/i.test(line)) {
      inTag = false
      continue
    }
    if (!inTemplate && !inTag) continue

    /*
     * The `File:` prefix is optional, and that is the whole difference between
     * the two syntaxes: inside a `{{Gallery}}` the entries are bare file names
     * behind a pipe, inside a `<gallery>` tag they usually carry the namespace.
     * Requiring it parsed this page as empty.
     */
    const entry =
      /^\|?\s*(?:(?:File|Image):)?\s*([^|]+?\.(?:png|jpe?g|gif|webp))\s*(?:\|(.*))?$/i.exec(line)
    if (!entry) continue

    const file = entry[1]!.trim().replace(/_/g, ' ')
    const title = `File:${file}`
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    entries.push({ title, caption: plainCaption(entry[2] ?? ''), section })
  }

  return entries
}

/** The ordinals the wiki writes its file names with. */
const ORDINALS: Readonly<Record<number, string>> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  6: 'sixth',
  7: 'seventh',
  8: 'eighth',
  9: 'ninth',
  10: 'tenth',
}

export interface PosterMatch {
  entry: GalleryEntry
  score: number
  /** How it was recognised, kept so a run can be audited rather than trusted. */
  why: string
}

/**
 * Headings whose posters were never printed in the manga.
 *
 * A hundred and forty-one of the two hundred and twenty-four entries on that
 * page are films, games, specials and anime eyecatchers. They are perfectly
 * real posters and none of them is a chapter, which makes every one of them
 * unusable here: this site shows what a chapter showed you.
 *
 * The eyecatchers earned their line the hard way. « The end of Luffy's first
 * eyecatcher » contains the word « first », so an ordinal read out of a caption
 * matched an anime interstitial to Luffy's thirty-million poster, and the
 * result looked entirely plausible. Hence both this list and the rule below
 * that ordinals are read from the file name only.
 */
const NON_CANON_SECTIONS: readonly string[] = [
  'non-canon posters',
  'eyecatchers',
  'other variants',
]

/**
 * Captions that place a poster outside the chapters, inside a canon heading.
 *
 * « Higuma's wanted poster as seen in Episode of Luffy » sits under « East Blue
 * Posters », which is a canon heading, and is a special. The section is not
 * enough on its own.
 */
const NON_CANON_WORDS: readonly string[] = [
  'episode of',
  'movie',
  'film',
  'video game',
  'anime only',
  'non-canon',
  'noncanon',
  'filler',
  'special',
  'ova',
]

/** True when the entry is a poster a chapter printed. */
export function isCanon(entry: GalleryEntry): boolean {
  if (NON_CANON_SECTIONS.includes(entry.section.trim().toLowerCase())) return false
  const caption = entry.caption.toLowerCase()
  return !NON_CANON_WORDS.some((word) => caption.includes(word))
}

/**
 * The file that shows one printing of one character's poster.
 *
 * Three ways to be sure, and at least one of them is required:
 *
 *   1. **The manifest names the file.** Written by a person who looked at it.
 *      Nothing beats it, and it is the only way to reach a printing the wiki
 *      files under a name with nothing countable in it.
 *   2. **The amount is in the file name or the caption.** Digits are digits.
 *   3. **The ordinal is in the file name.** « Chopper's Second Wanted
 *      Poster.png » is the second printing; the wiki is consistent about this.
 *
 * The ordinal is read from the file name and never from the caption, which is
 * prose and where « first » means whatever the sentence needed it to mean.
 *
 * There is deliberately no fourth rule for the files the wiki calls
 * « Current ». Current is a fact about the wiki today, not about a chapter: the
 * day a new poster is printed, that file will hold the new one under the same
 * name, and a reader who has not got there would be shown it. That is the exact
 * failure era.ts was written about, and the answer is the same — a picture
 * whose date comes from « whatever is at the top of the article right now » is
 * not dated at all. Those printings are pinned in the manifest instead, where a
 * person is looking at them.
 *
 * A name alone is never enough. « Nami's Wanted Poster.png » names Nami and
 * says nothing about which of her three posters it is, so it is refused and she
 * keeps her portrait. A missing poster is a smaller failure than a wrong one by
 * a wide margin: one is a page with a portrait on it, the other tells a reader
 * a bounty that is not theirs.
 */
export function findPoster(
  gallery: readonly GalleryEntry[],
  character: BountyHistory,
  bounty: Bounty,
): PosterMatch | null {
  const canon = gallery.filter(isCanon)

  if (bounty.file) {
    const wanted = `file:${bounty.file}`.toLowerCase().replace(/_/g, ' ')
    const named = canon.find((entry) => entry.title.toLowerCase() === wanted)
    if (named) return { entry: named, score: 1000, why: 'fichier nommé dans le manifeste' }
    return null
  }

  let best: PosterMatch | null = null

  for (const entry of canon) {
    const title = nameWords(entry.title)
    const haystack = nameWords(`${entry.title} ${entry.caption}`)
    const named = character.aliases.some((alias) => haystack.includes(nameWords(alias)))
    if (!named) continue

    /*
     * Digits taken from the file name and the caption together, with every
     * separator removed, so « 1,111,000,000 » and « 1111000000 » are the same
     * number. The section heading is left out on purpose: « CP9 » and « East
     * Blue Posters » carry digits that belong to no bounty.
     */
    const digits = `${entry.title} ${entry.caption}`.replace(/\D/g, '')
    const reasons: string[] = ['nom']
    let score = 100
    let specific = false

    if (digits.includes(String(bounty.amount))) {
      score += 90
      specific = true
      reasons.push('montant')
    }

    const ordinal = ORDINALS[bounty.edition]
    if (ordinal && title.includes(nameWords(ordinal))) {
      score += 70
      specific = true
      reasons.push('édition')
    }

    if (!specific) continue
    if (!best || score > best.score) {
      best = { entry, score, why: reasons.join(' + ') }
    }
  }

  return best
}

/** The gallery page, as wikitext. One request. */
export async function fetchGallery(): Promise<GalleryEntry[]> {
  const url =
    `${API}?action=parse&format=json&formatversion=1&redirects=1&prop=wikitext` +
    `&page=${encodeURIComponent(GALLERY_PAGE)}`

  const body = await fetchJson<ParseResponse>(url)
  if (body.error?.info) throw new FetchFailure(url, body.error.info)

  const wikitext = body.parse?.wikitext
  const text = typeof wikitext === 'string' ? wikitext : (wikitext?.['*'] ?? '')
  if (!text) throw new FetchFailure(url, 'page sans wikitexte')

  return parseGallery(text)
}

/**
 * Where the bytes of a file actually are.
 *
 * Asked in batches of twenty and paced, because this is one request per poster
 * otherwise and the wiki is somebody's free server. `iiurlwidth` makes
 * MediaWiki do the downscaling, which saves fetching a two-megabyte PNG to
 * throw away nine tenths of it.
 */
export async function resolveFiles(
  titles: readonly string[],
): Promise<Map<string, PosterFile>> {
  const out = new Map<string, PosterFile>()
  const unique = [...new Set(titles)]

  for (let index = 0; index < unique.length; index += 20) {
    const batch = unique.slice(index, index + 20)
    const url =
      `${API}?action=query&format=json&formatversion=1&redirects=1` +
      `&prop=imageinfo&iiprop=url|size&iiurlwidth=${POSTER_WIDTH}` +
      `&titles=${encodeURIComponent(batch.join('|'))}`

    const body = await fetchJson<ImageInfoResponse>(url)

    /*
     * MediaWiki normalises « File:Nami's Wanted Poster.png » on the way in and
     * answers under the normalised title. Without this map the answer cannot be
     * matched back to what was asked, and every poster with an apostrophe in it
     * goes missing.
     */
    const asked = new Map<string, string>()
    for (const title of batch) asked.set(title.replace(/_/g, ' '), title)
    for (const rename of body.query?.normalized ?? []) {
      if (rename.from && rename.to) asked.set(rename.to, asked.get(rename.from) ?? rename.from)
    }

    for (const page of Object.values(body.query?.pages ?? {})) {
      if (!page.title || page.missing !== undefined) continue
      const info = page.imageinfo?.[0]
      const imageUrl = info?.thumburl ?? info?.url
      if (!imageUrl) continue

      const requested = asked.get(page.title) ?? page.title
      out.set(requested, {
        title: page.title,
        caption: '',
        section: '',
        imageUrl,
        pageUrl: info?.descriptionurl ?? `${GALLERY_URL}#${encodeURIComponent(page.title)}`,
        width: info?.thumbwidth ?? null,
        height: info?.thumbheight ?? null,
      })
    }

    if (index + 20 < unique.length) await pause(PACE_MS)
  }

  return out
}
