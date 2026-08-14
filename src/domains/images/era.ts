/**
 * L'ellipse, et ce qu'elle fait à un portrait.
 *
 * Two years pass between the last page of chapter 597 and the first of 598.
 * Everyone comes back changed, and the changes are not cosmetic: they are the
 * pay-off of the arc that precedes them. A reader at chapter 40 who is shown
 * the post-ellipse face has been told, in the most convincing form an interface
 * has, that this character survives what is coming and what it costs them.
 *
 * That is a spoiler this application had no defence against. The boundary
 * protects *when a picture may appear* — the revelation chapter of the label
 * that found it — and says nothing about *which* picture. A portrait fetched
 * for « Nami » is dated by the chapter that names her, which is chapter 8; the
 * picture the wiki hands back for that name is the one at the top of the
 * article today, and the one at the top of the article today is the woman she
 * becomes at chapter 598.
 *
 * So an illustration now carries the period it depicts, and the period is
 * checked against the reader's position exactly like the revelation chapter is
 * — in the database, by the same policy. See
 * drizzle/0022_a_face_from_before_the_ellipsis.sql.
 *
 * `unknown` is not a hole to be filled with a guess. The three catalogues hand
 * over one portrait per character with nothing said about when it depicts them,
 * and inferring "current artwork, therefore post-ellipse" would be exactly the
 * silent reasoning on a weak signal this domain refuses everywhere else. An
 * unknown picture stays usable at every position; only a picture the source
 * itself labels as post-ellipse is withheld.
 */

/**
 * The last chapter before the ellipse.
 *
 * 597 ends the Marineford aftermath; 598 opens two years later. The number is
 * duplicated in SQL — it has to be, since the row-level policy is what enforces
 * this — and the migration comment points back here.
 */
export const LAST_PRE_TIMESKIP_CHAPTER = 597

export type Era = 'pre_timeskip' | 'post_timeskip' | 'unknown'

/** The two periods a reader can be in. `unknown` is a property of pictures. */
export type ReaderEra = Exclude<Era, 'unknown'>

export function eraAtChapter(chapter: number): ReaderEra {
  return chapter <= LAST_PRE_TIMESKIP_CHAPTER ? 'pre_timeskip' : 'post_timeskip'
}

/**
 * Words the wiki uses to date an illustration, in its file names.
 *
 * Measured against the real article of every Straw Hat plus a dozen others on
 * 2026-08-13: the convention is « Nami Manga Pre Timeskip Infobox.png », with
 * « after the timeskip » appearing in the longer, sentence-like names. Nothing
 * else is a reliable marker — « Nami Post Enies Lobby.png » is a pre-ellipse
 * picture whose name starts with the wrong word, which is why these match the
 * whole phrase rather than « post ».
 */
const MARKERS: Readonly<Record<ReaderEra, readonly string[]>> = {
  pre_timeskip: ['pre timeskip', 'before the timeskip'],
  post_timeskip: ['post timeskip', 'after the timeskip'],
}

/**
 * A file name reduced to lowercase words, padded with spaces.
 *
 * Underscores, hyphens and the extension all disappear, so « Pre_Timeskip »,
 * « Pre-Timeskip » and « pre timeskip » are one thing. The padding lets a
 * caller test for a whole word with `' anime '` and not match « animation ».
 *
 * Accents go too, and that is not cosmetic. The French wiki files « Équipage du
 * Roux » under `Equipage_du_Roux_Jolly_Roger.png`: the article title carries the
 * accent and the file name does not, so comparing a picture against the name
 * that asked for it — see `illustrates` — would fail on every French title with
 * a diacritic in it. Nothing this reads is spelled with an accent on purpose.
 */
export function fileWords(name: string): string {
  const base = name
    .replace(/^(?:File|Fichier|Image):/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
  return ` ${base} `
}

/**
 * When a picture depicts its subject, read from the name the wiki files it
 * under — or `unknown`, which is most of them.
 *
 * A name that claims both periods is unknown rather than either. « Zoro Pre and
 * Post Timeskip.png » is a side-by-side comparison: it depicts both, so it is
 * safe at neither. Note that it matches only the *post* marker — the two words
 * are not adjacent — which is why the ambiguity is caught on the bare words as
 * well as on the phrases.
 */
export function eraOfFileName(name: string): Era {
  const words = fileWords(name)
  if (words.includes(' pre ') && words.includes(' post ')) return 'unknown'

  const pre = MARKERS.pre_timeskip.some((marker) => words.includes(marker))
  const post = MARKERS.post_timeskip.some((marker) => words.includes(marker))
  if (pre === post) return 'unknown'
  return pre ? 'pre_timeskip' : 'post_timeskip'
}

/**
 * The same, for a URL whose last path segment is the file name.
 *
 * The wiki's `pageimages` property answers with an address rather than a title
 * — `…/images/0/09/Nefertari_Vivi_Anime_Post_Timeskip_Infobox.png/revision/latest?cb=…`
 * — and that address is the only thing said about the picture. Reading it is
 * how the lead image of an article gets dated at all.
 */
export function eraOfImageUrl(url: string): Era {
  const file = fileNameOfUrl(url)
  return file ? eraOfFileName(file) : 'unknown'
}

/**
 * The file name inside a wiki image address, decoded.
 *
 * `…/images/0/05/Chapitre_1018_Color%C3%A9.png/revision/latest?cb=…` yields
 * « Chapitre_1018_Coloré.png ». The name is the only thing the address says
 * about the picture, and everything that judges a picture on this side reads it
 * — its date here, and whether it depicts what was asked for in fandom.ts.
 */
export function fileNameOfUrl(url: string): string | null {
  const path = url.split('?')[0] ?? ''
  const file = path
    .split('/')
    .reverse()
    .find((segment) => /\.[a-z0-9]+$/i.test(segment))
  return file ? decodeURIComponent(file) : null
}
