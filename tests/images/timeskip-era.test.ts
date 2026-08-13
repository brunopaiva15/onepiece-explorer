import { describe, expect, it } from 'vitest'
import {
  bestPortraits,
  eraAtChapter,
  eraOfFileName,
  eraOfImageUrl,
  LAST_PRE_TIMESKIP_CHAPTER,
} from '@/domains/images/index.ts'

/**
 * Reading a date out of a file name.
 *
 * The wiki does not expose a field saying when a picture depicts its subject.
 * It does name its files with unusual discipline, and that naming is the whole
 * signal this feature rests on — so the names below are not invented. They are
 * copied from the live articles of Nami, Luffy, Zoro, Vivi and Koby as they
 * stood on 2026-08-13, including the awkward ones: a picture called « Post
 * Enies Lobby » that is not post-ellipse at all, an infobox belonging to
 * somebody else that a template drags into Koby's article, and the game
 * artwork that is dated, on-subject and not a portrait.
 *
 * If the wiki ever renames these, this test is where it shows up — which is the
 * point of pinning real strings rather than plausible ones.
 */

describe('which side of the ellipse a chapter is on', () => {
  it('splits between 597 and 598', () => {
    expect(LAST_PRE_TIMESKIP_CHAPTER).toBe(597)
    expect(eraAtChapter(1)).toBe('pre_timeskip')
    expect(eraAtChapter(597)).toBe('pre_timeskip')
    expect(eraAtChapter(598)).toBe('post_timeskip')
    expect(eraAtChapter(1_100)).toBe('post_timeskip')
  })

  it('puts a reader who has read nothing before the ellipse', () => {
    // Boundary 0 is a real position — a reader who has imported chapters but
    // not moved the slider off the start. Nothing may be shown to them at all,
    // and certainly not a face from six hundred chapters ahead.
    expect(eraAtChapter(0)).toBe('pre_timeskip')
  })
})

describe('the date in a file name', () => {
  it('reads the wiki’s own marker', () => {
    expect(eraOfFileName('Nami_Manga_Pre_Timeskip_Infobox.png')).toBe('pre_timeskip')
    expect(eraOfFileName('Nami_Manga_Post_Timeskip_Infobox.png')).toBe('post_timeskip')
    expect(eraOfFileName('File:Zoro Pre-Timeskip Burning Will.png')).toBe('pre_timeskip')
    expect(
      eraOfFileName('Luffy_after_the_timeskip_in_the_Digitally_Colored_Manga.png'),
    ).toBe('post_timeskip')
  })

  it('is not fooled by a word that merely starts with « post »', () => {
    /*
     * « Nami Post Enies Lobby.png » is a picture from chapter 440-ish. Matching
     * on « post » alone would date it after the ellipse and hide it from every
     * reader it was meant for — the failure mode of a spoiler filter that is
     * too eager is a blank page, which reads as "no picture exists".
     */
    expect(eraOfFileName('Nami_Post_Enies_Lobby.png')).toBe('unknown')
    expect(eraOfFileName('Nami_Post-Arabasta_Arc_Outfit.png')).toBe('unknown')
  })

  it('refuses a name that claims both periods', () => {
    // A side-by-side comparison depicts both, so it is safe at neither.
    expect(eraOfFileName('Zoro_Pre_and_Post_Timeskip.png')).toBe('unknown')
  })

  it('says unknown for the great majority, which is the honest answer', () => {
    expect(eraOfFileName('Nami_Portrait.png')).toBe('unknown')
    expect(eraOfFileName('Featured_Article.png')).toBe('unknown')
  })

  it('reads it out of an address, which is all pageimages gives', () => {
    expect(
      eraOfImageUrl(
        'https://static.wikia.nocookie.net/onepiece/images/0/09/' +
          'Nefertari_Vivi_Anime_Post_Timeskip_Infobox.png/revision/latest?cb=20190505023647',
      ),
    ).toBe('post_timeskip')

    /*
     * The lead image of a character's article is the current one, and this is
     * the measurement that motivated the whole change: asked about « Vivi », the
     * wiki hands back the woman she is after the ellipse. Until now that picture
     * was stored undated and shown from the chapter that names her.
     */
    expect(eraOfImageUrl('https://static.invalid/Partys_Bar.png')).toBe('unknown')
    expect(eraOfImageUrl('')).toBe('unknown')
  })
})

/** Every file name here is really on https://onepiece.fandom.com/wiki/Nami. */
const NAMI = [
  'File:Nami Anime Post Timeskip Infobox.png',
  'File:Nami Anime Pre Timeskip Infobox.png',
  'File:Nami Manga Post Timeskip Infobox.png',
  'File:Nami Manga Pre Timeskip Infobox.png',
  'File:Nami Portrait.png',
  'File:Nami Pre Timeskip Portrait.png',
  'File:Nami Pre Timeskip Pirate Warriors 4.png',
  'File:Nami Post Timeskip Pirate Warriors 4.png',
  "File:Nami's Initial Post Timeskip Outfit.png",
  'File:Nami Post Enies Lobby.png',
  'File:Featured Article.png',
]

describe('choosing a portrait out of an article’s files', () => {
  it('takes the manga infobox on each side', () => {
    expect(bestPortraits(NAMI, 'Nami')).toEqual({
      pre_timeskip: 'File:Nami Manga Pre Timeskip Infobox.png',
      post_timeskip: 'File:Nami Manga Post Timeskip Infobox.png',
    })
  })

  it('prefers the panel art to the animated one', () => {
    // A companion to a manga you are reading should show what the pages you
    // just turned show. The wiki names the two apart, so it costs nothing.
    const both = [
      'File:Nami Anime Pre Timeskip Infobox.png',
      'File:Nami Manga Pre Timeskip Infobox.png',
    ]
    expect(bestPortraits(both, 'Nami').pre_timeskip).toBe(
      'File:Nami Manga Pre Timeskip Infobox.png',
    )
  })

  it('falls back to the older « Portrait » naming', () => {
    const older = ['File:Buggy Pre Timeskip Portrait.png']
    expect(bestPortraits(older, 'Buggy').pre_timeskip).toBe(
      'File:Buggy Pre Timeskip Portrait.png',
    )
  })

  it('keeps out the game artwork without knowing the games', () => {
    /*
     * « Nami Pre Timeskip Pirate Warriors 4.png » is dated, is of Nami, and is
     * a video game render. Listing every game the franchise has had would be an
     * arms race; requiring the wiki's own word for a reference picture —
     * infobox, or portrait — settles it once.
     */
    const games = NAMI.filter((file) => file.includes('Pirate Warriors'))
    expect(bestPortraits(games, 'Nami')).toEqual({})
  })

  it('keeps out an outfit shot, which frames the clothes', () => {
    expect(bestPortraits(["File:Nami's Initial Post Timeskip Outfit.png"], 'Nami')).toEqual(
      {},
    )
  })

  it('refuses somebody else’s infobox', () => {
    /*
     * Koby's article really does list « 153rd Branch Infobox.png », dragged in
     * by a template. A wrong face is worse than no face: an absence reads as
     * « not found », a wrong portrait reads as « found », and nobody re-checks
     * a face they have already accepted.
     */
    const foreign = [
      'File:153rd Branch Post Timeskip Infobox.png',
      'File:Koby Manga Post Timeskip Infobox.png',
    ]
    expect(bestPortraits(foreign, 'Koby')).toEqual({
      post_timeskip: 'File:Koby Manga Post Timeskip Infobox.png',
    })
  })

  it('ignores the one-letter word in a name', () => {
    // « D » identifies nobody, so it must not be what lets a file through.
    expect(
      bestPortraits(
        ['File:D Manga Pre Timeskip Infobox.png'],
        'Monkey D. Luffy',
      ),
    ).toEqual({})
    expect(
      bestPortraits(
        ['File:Monkey D. Luffy Manga Pre Timeskip Infobox.png'],
        'Monkey D. Luffy',
      ).pre_timeskip,
    ).toBe('File:Monkey D. Luffy Manga Pre Timeskip Infobox.png')
  })

  it('returns nothing for a character the ellipse did not change', () => {
    /*
     * Ace, Bellemere, Kuina — and Shanks, who simply has no dated file. Their
     * articles carry one undated infobox, and the right outcome is no dated
     * portrait at all rather than a guess: the undated catalogue picture then
     * serves every reader, as it always did.
     */
    expect(bestPortraits(['File:Shanks Portrait.png'], 'Shanks')).toEqual({})
    expect(bestPortraits([], 'Portgas D. Ace')).toEqual({})
  })
})
