import { describe, expect, it } from 'vitest'
import {
  illustrates,
  infoboxFiles,
  infoboxPortrait,
} from '@/domains/images/index.ts'

/**
 * The picture at the top of an article, and whether it is of the article.
 *
 * The defect this pins is a real one, seen on a real fiche: « Équipage du Roux »
 * opened on the coloured cover of chapter 1018. Nothing had malfunctioned —
 * MediaWiki's `pageimages` scores every image on a page and hands back the
 * winner, and on that article the winner is a colour spread sitting in a
 * footnote. The crew's own picture, the one the infobox holds up, is its Jolly
 * Roger.
 *
 * So the wikitext below is not invented. It is copied from
 * https://onepiece.fandom.com/fr/wiki/L'Équipage_du_Roux and three other live
 * articles as they stood on 2026-08-14, footnote included, because the footnote
 * is the whole problem. If the wiki rewrites them, this test is where it shows.
 */

/** The lead of « L'Équipage du Roux », infobox and offending footnote. */
const ROUX = `{{Spoil}}
{{Equipage Box
| backcolor      = BF0000
| textcolor      = FFFFFF
| titre          = Équipage de Shanks le Roux
| image          = [[Fichier:Equipage_du_Roux_Jolly_Roger.png|270px]]
| nomj           = 赤髪海賊団
| premiere       = [[Chapitre 1]] ; [[Épisode 4]]
| capitaine      = [[Shanks]]
| navire         = Ancien Navire Inconnu, [[Red Force]]
| statut         = Actif
}}
L''''équipage de Shanks le Roux''' est l'un des plus puissants équipages pirates.

Ils sont les deuxièmes détenteurs du [[Gomu Gomu no Mi]].<ref>[[Fichier:Chapitre 1018 Coloré.png|vignette]]
Chapitre [[Chapitre 1018|1018]]</ref>`

/** The lead of « Partys Bar » — one picture per medium, in a nested template. */
const PARTYS_BAR = `{{Îles Box
| backcolor = 915C83
| nom = Partys Bar
| image = {{Manga-Anime
|[[Fichier:Partys Bar Anime Infobox.png|270px]]
|[[Fichier:Partys Bar Manga Infobox.png|270px]]
}}
| nomj = パーティー ズバー
| région = [[East Blue]]
}}
Le '''Partys Bar''' est un bar tenu par [[Makino]] situé à [[Fuchsia]].`

/** The lead of « Red Hair Pirates » — the English crew box, file named bare. */
const RED_HAIR = `{{Crew Box
|colorscheme    = RedHairPiratesColors
|jroger         = Red Hair Pirates' Jolly Roger.png
|jname          = 赤髪海賊団
|ship           = [[Red Force]]
|first          = [[Chapter 1]]; [[Episode 4]]
}}

{{For|the chapter of the same name|Chapter 1079}}

The '''Red Hair Pirates''' are an extremely infamous and powerful [[pirate]] crew.`

/** The lead of « Nami » — no infobox at all here; hers lives in a tab template. */
const NAMI = `{{Nami Tabs Top}}

{{For|the chapter of the same name|Chapter 8}}

'''"Cat Burglar" Nami''' is the [[navigator]] of the [[Straw Hat Pirates]].`

describe('whether a picture is of what was asked for', () => {
  it('refuses the chapter cover offered as the Roux crew’s portrait', () => {
    // The defect, in one line. Nothing in this file name is of a crew.
    expect(illustrates('Chapitre 1018 Coloré.png', "L'Équipage du Roux")).toBe(false)
  })

  it('accepts the crew’s own flag, accent or no accent', () => {
    /*
     * The article is « L'Équipage du Roux » and its file is
     * `Equipage_du_Roux_Jolly_Roger.png`. Comparing the two as written would
     * fail on the É alone, which would refuse the right picture for half the
     * French wiki.
     */
    expect(
      illustrates('Equipage_du_Roux_Jolly_Roger.png', "L'Équipage du Roux"),
    ).toBe(true)
  })

  it('refuses another place’s infobox, whoever put it there', () => {
    /*
     * The French article for « Île de Dawn » really does illustrate itself with
     * the Goa Kingdom's infobox. A reader shown it under the island's name is
     * being told the two are the same place, on our word rather than the wiki's.
     */
    expect(illustrates('Royaume de Goa Anime Infobox.png', 'Île de Dawn')).toBe(false)
  })

  it('accepts a file that shares a word, misspelt or not', () => {
    // The wiki files Fuchsia's picture under « Fushsia ». One shared word is
    // the bar, which is what keeps a typo from costing a village its picture.
    expect(
      illustrates('Village de Fushsia Anime Infobox.png', 'Village de Fuchsia'),
    ).toBe(true)
  })

  it('refuses what is named after the subject but is not a picture of it', () => {
    expect(illustrates('Shanks Wanted Poster.png', 'Shanks')).toBe(false)
    expect(illustrates("Concept de l'équipage du Roux.png", "L'Équipage du Roux")).toBe(
      false,
    )
  })
})

describe('the files an article’s infobox names', () => {
  it('reads the image the Roux crew’s box holds up', () => {
    expect(infoboxFiles(ROUX)).toEqual(['File:Equipage du Roux Jolly Roger.png'])
  })

  it('stops at the end of the box, not at the end of the lead', () => {
    // The footnote's chapter cover is inside the same section and outside the
    // infobox. Reading past the closing braces would take in the very picture
    // this whole check exists to refuse.
    expect(infoboxFiles(ROUX).join(' ')).not.toContain('1018')
  })

  it('reads both sides of a nested {{Manga-Anime}}', () => {
    expect(infoboxFiles(PARTYS_BAR)).toEqual([
      'File:Partys Bar Anime Infobox.png',
      'File:Partys Bar Manga Infobox.png',
    ])
  })

  it('reads a file named bare, as the English crew boxes name theirs', () => {
    expect(infoboxFiles(RED_HAIR)).toEqual(["File:Red Hair Pirates' Jolly Roger.png"])
  })

  it('says nothing when the lead carries no box', () => {
    expect(infoboxFiles(NAMI)).toEqual([])
    expect(infoboxFiles('')).toEqual([])
  })

  it('says nothing when the box never closes', () => {
    // An unbalanced box is not repaired: everything after it is prose, and the
    // prose is full of pictures of other things.
    expect(infoboxFiles('{{Equipage Box\n| image = [[Fichier:A.png]]')).toEqual([])
  })
})

describe('the picture an infobox holds up', () => {
  it('takes the crew’s flag out of the Roux box', () => {
    expect(infoboxPortrait(infoboxFiles(ROUX), "L'Équipage du Roux")).toBe(
      'File:Equipage du Roux Jolly Roger.png',
    )
  })

  it('prefers the panel art to the animated one', () => {
    // The same preference `bestPortraits` applies, for the same reason: this is
    // a companion to a manga, and the wiki names the two apart.
    expect(infoboxPortrait(infoboxFiles(PARTYS_BAR), 'Partys Bar')).toBe(
      'File:Partys Bar Manga Infobox.png',
    )
  })

  it('holds up nothing rather than something of another subject', () => {
    expect(
      infoboxPortrait(['File:Royaume de Goa Anime Infobox.png'], 'Île de Dawn'),
    ).toBeNull()
    expect(infoboxPortrait([], 'Shanks')).toBeNull()
  })
})
