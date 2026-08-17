/**
 * Les primes, et le chapitre où le lecteur les apprend.
 *
 * A wanted poster is the most spoiler-dense object in this work. It carries a
 * face, an epithet and a number, and all three move: Luffy is worth thirty
 * million at chapter 96 and three billion at 1053, and showing the second one
 * to somebody reading the first tells them, in the most convincing form an
 * interface has, everything the four hundred chapters in between were for.
 *
 * So a poster is dated, like everything else on this site. The wiki cannot do
 * the dating for us: the gallery files are named « Monkey D. Luffy's Seventh
 * Wanted Poster.png », the ordinal is the only clue, and the file description
 * pages carry no chapter at all. What follows is therefore written by hand.
 *
 * That is the same decision arcs.ts makes, for the same reason, and the
 * argument is worth repeating because it is the one this file has to answer.
 * Everything else on a page here is something a chapter *told* the reader,
 * extracted from imported material and held behind the boundary. A bounty is
 * not that. It is a fact about a work published for thirty years, identical for
 * everyone, checkable by anybody who owns the volume, and no extraction is
 * going to improve on a number somebody read off the page. Writing it down is
 * honest; asking a model to guess it would not be.
 *
 * `chapter` is « the first chapter in which the reader knows this poster ». Not
 * when the bounty was issued in-world, not when the wiki says the Marines
 * printed it: when the page shows it. That is the axis the whole site reads on.
 *
 * To extend it: add a row, keep the chapters ascending, and check the number
 * against the chapter before committing. There is no test that can verify a
 * bounty for you — the value of this file is that every line in it was read off
 * a page by a person.
 */

import type { ImageCrop } from './types.ts'

/** One printing of one poster, and when the reader gets to see it. */
export interface Bounty {
  /** First chapter that shows this poster. Ascending within a character. */
  chapter: number
  /** The figure printed on it, in berries. */
  amount: number
  /**
   * Which printing this is, counting from the first.
   *
   * Carried because it is how the wiki names its files: « Chopper's Second
   * Wanted Poster.png ». It is the strongest signal the gallery gives for
   * telling one printing of a poster from another.
   */
  edition: number
  /**
   * The gallery file, when nothing countable in its name identifies it.
   *
   * **A pin means somebody opened the picture and read the number off it.** It
   * is not a guess from the file name, and the file names here are the reason
   * for that rule: « Nami's Current Wanted Poster.png » was last uploaded in
   * 2016 and shows sixty-six million, which is the printing of chapter 801 and
   * not the one she is wanted for now. Five of the nine pins in this file were
   * wrong on the first pass, all of them in that same way, and all five looked
   * entirely reasonable from the name alone.
   *
   * « Current » is a fact about the wiki on the day somebody last touched it,
   * never about a chapter — which is why the matcher refuses to read the word
   * and why these live here instead, where a person is looking at them.
   *
   * `pnpm images:posters` prints the printings it could not resolve. Pinning
   * one means finding it in the gallery, opening it, and checking that the
   * figure printed on it is the figure on this line.
   */
  file?: string
  /**
   * Where the poster is, when the file is a panel rather than a poster.
   *
   * Same rule as `file`, one step further: somebody opened the picture, read
   * the number, and drew the box. It exists because the wiki holds no
   * standalone image of Luffy's thirty million — the protagonist would be
   * absent from a wall of wanted posters from chapter 96 to chapter 601, which
   * is the wrong answer to « et Luffy ? ».
   *
   * Not a general escape hatch. Cropping to a poster inside a panel shows the
   * same document the file is being cited for; cropping to a face and calling
   * it a poster is the mistake this wall was rebuilt to stop making.
   */
  crop?: ImageCrop
}

export interface BountyHistory {
  /** The name this file calls them. Not shown anywhere. */
  canonical: string
  /**
   * Every name a chapter might have given them, and every name the wiki files
   * their posters under. Matching runs on both sides at once: the graph's label
   * comes from the extraction, the gallery caption comes from Fandom, and the
   * two agree far more often than they disagree.
   */
  aliases: string[]
  rows: Bounty[]
}

/**
 * The crew, and the handful of others the wiki has a poster for.
 *
 * Not a stopping point anybody chose: it is where the evidence runs out. The
 * gallery holds a picture of about a quarter of the printings listed here, so
 * the rest of the manifest exists to say what is missing rather than to hide
 * it, and `pnpm images:posters` prints that list every run.
 *
 * The five outside the crew were added because their posters cover the early
 * chapters, where the crew's own are still hundreds of chapters away: Arlong at
 * 69 and Krieg at 96 are the first two real posters anybody reading in order
 * ever sees on this site. Every one of them was verified the same way, by
 * opening the picture and reading the figure off it, and their chapters come
 * from the wiki's own citations rather than from memory.
 *
 * Whoever extends this next: the Warlords and the Emperors are the obvious
 * block, and the work per line is small and dull and cannot be skipped.
 */
export const BOUNTY_HISTORY: readonly BountyHistory[] = [
  {
    canonical: 'Monkey D. Luffy',
    aliases: ['monkey d luffy', 'luffy', 'luffy au chapeau de paille', 'straw hat luffy'],
    rows: [
      /*
       * Le premier avis, et le seul endroit où le wiki le montre.
       *
       * There is no file on that wiki holding this poster on its own: six
       * hundred and ninety-three pictures are filed under « Luffy » and
       * « Monkey D. Luffy » and eleven of them mention a poster, all of them
       * either a later printing, a dub, a film or an eyecatcher. This one is
       * the anime's panel of Usopp and Luffy reading it on the Merry, and the
       * poster inside it is legible: WANTED, DEAD OR ALIVE, MONKEY·D·LUFFY,
       * ฿30,000,000-, MARINE. The box below is that poster and nothing else.
       */
      {
        chapter: 96,
        amount: 30_000_000,
        edition: 1,
        file: 'Luffy Receives His First Bounty.png',
        crop: { box: [0.394, 0.12, 0.223, 0.415], ratio: 665 / 482 },
      },
      { chapter: 234, amount: 100_000_000, edition: 2 },
      { chapter: 435, amount: 300_000_000, edition: 3 },
      { chapter: 601, amount: 400_000_000, edition: 4, file: 'Luffy Wanted Poster.png' },
      { chapter: 801, amount: 500_000_000, edition: 5 },
      { chapter: 903, amount: 1_500_000_000, edition: 6 },
      { chapter: 1053, amount: 3_000_000_000, edition: 7 },
    ],
  },
  {
    canonical: 'Roronoa Zoro',
    aliases: ['roronoa zoro', 'zoro', 'zorro', 'pirate hunter zoro'],
    rows: [
      { chapter: 234, amount: 60_000_000, edition: 1 },
      {
        chapter: 435,
        amount: 120_000_000,
        edition: 2,
        file: "Zoro's Wanted Poster.png",
      },
      {
        chapter: 801,
        amount: 320_000_000,
        edition: 3,
        file: "Roronoa Zoro's Current Wanted Poster.png",
      },
      { chapter: 1058, amount: 1_111_000_000, edition: 4 },
    ],
  },
  {
    canonical: 'Nami',
    aliases: ['nami', 'cat burglar nami', 'chatte voleuse'],
    rows: [
      { chapter: 435, amount: 16_000_000, edition: 1, file: "Nami's Wanted Poster.png" },
      { chapter: 801, amount: 66_000_000, edition: 2, file: "Nami's Current Wanted Poster.png" },
      { chapter: 1058, amount: 366_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Usopp',
    aliases: ['usopp', 'god usopp', 'sogeking', 'pipo', 'sniperking', 'sniper king'],
    rows: [
      { chapter: 435, amount: 30_000_000, edition: 1, file: "Usopp's Wanted Poster.png" },
      { chapter: 801, amount: 200_000_000, edition: 2, file: "God Usopp's Wanted Poster.png" },
      { chapter: 1058, amount: 500_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Sanji',
    aliases: ['sanji', 'vinsmoke sanji', 'black leg sanji', 'sandy', 'jambe noire'],
    rows: [
      { chapter: 435, amount: 77_000_000, edition: 1, file: "Sanji's Wanted Poster.png" },
      { chapter: 801, amount: 177_000_000, edition: 2 },
      { chapter: 903, amount: 330_000_000, edition: 3 },
      {
        chapter: 1058,
        amount: 1_032_000_000,
        edition: 4,
        file: "Sanji's Current Wanted Poster.png",
      },
    ],
  },
  {
    canonical: 'Tony Tony Chopper',
    aliases: ['tony tony chopper', 'chopper'],
    rows: [
      {
        chapter: 435,
        amount: 50,
        edition: 1,
        file: "Tony Tony Chopper's Wanted Poster.png",
      },
      { chapter: 801, amount: 100, edition: 2 },
      { chapter: 1058, amount: 1_000, edition: 3 },
    ],
  },
  {
    canonical: 'Nico Robin',
    aliases: ['nico robin', 'robin', "l'enfant démon", 'devil child'],
    rows: [
      { chapter: 398, amount: 79_000_000, edition: 1 },
      {
        chapter: 435,
        amount: 80_000_000,
        edition: 2,
        file: "Nico Robin's Wanted Poster.png",
      },
      {
        chapter: 801,
        amount: 130_000_000,
        edition: 3,
        file: "Nico Robin's Current Wanted Poster.png",
      },
      { chapter: 1058, amount: 930_000_000, edition: 4 },
    ],
  },
  {
    canonical: 'Franky',
    aliases: ['franky', 'iron man franky', 'cyborg franky', 'cutty flam'],
    rows: [
      { chapter: 435, amount: 44_000_000, edition: 1, file: "Franky's Wanted Poster.png" },
      { chapter: 801, amount: 94_000_000, edition: 2 },
      { chapter: 1058, amount: 394_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Brook',
    aliases: ['brook', 'soul king brook', 'humming brook', 'soul king'],
    rows: [
      { chapter: 489, amount: 33_000_000, edition: 1, file: 'Brook Alive Bounty Poster.png' },
      {
        chapter: 801,
        amount: 83_000_000,
        edition: 2,
        file: "Brook's Concert Wanted Poster.png",
      },
      { chapter: 1058, amount: 383_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Jinbe',
    aliases: ['jinbe', 'jinbei', 'jimbei', 'knight of the sea jinbe', 'chevalier de la mer'],
    rows: [
      { chapter: 635, amount: 438_000_000, edition: 3 },
      {
        chapter: 1058,
        amount: 1_100_000_000,
        edition: 4,
        file: "Jinbe's Current Wanted Poster.png",
      },
    ],
  },
  {
    canonical: 'Arlong',
    aliases: ['arlong', 'arlong la scie'],
    rows: [
      { chapter: 69, amount: 20_000_000, edition: 1, file: "Arlong's Wanted Poster.png" },
    ],
  },
  {
    canonical: 'Higuma',
    aliases: ['higuma', 'higuma l’ours', 'higuma the bear'],
    rows: [
      /*
       * The first poster the work ever shows, on the first page of chapter 1,
       * and the first one a reader of this site can see. The picture is the one
       * « Episode of Luffy » drew of it, which is why the line is pinned: the
       * matcher refuses a file whose caption names a special, and cannot tell a
       * non-canonical poster from a canonical poster drawn for television.
       */
      { chapter: 1, amount: 8_000_000, edition: 1, file: 'Higuma Bounty Poster.png' },
    ],
  },
  {
    canonical: 'Dorry',
    aliases: ['dorry'],
    rows: [
      /*
       * A hundred million at chapter 118, and no picture of it anywhere: the
       * file the wiki calls « Dorry Wanted Poster.png » shows one billion eight
       * hundred million, which is the printing of chapter 1130 after a century
       * of inflation. Pinning the file to this row on the strength of its name
       * would have put a thousand chapters of spoiler on the front page of
       * anybody reading Little Garden.
       */
      { chapter: 118, amount: 100_000_000, edition: 1 },
      {
        chapter: 1130,
        amount: 1_800_000_000,
        edition: 2,
        file: 'Dorry Wanted Poster.png',
      },
    ],
  },
  {
    canonical: 'Brogy',
    aliases: ['brogy', 'broggy'],
    rows: [
      /*
       * Le même cent millions que Dorry, et la même absence — sauf qu'ici un
       * fichier a l'air de la combler.
       *
       * « Dorry & Brogy Bounty Poster.png » is in the gallery, under a
       * canonical heading, captioned « Dorry and Brogy's first known wanted
       * poster ». It matches on the name and then fails on the printing, twice
       * over. The word « first » is in the caption and not in the file name,
       * and ordinals are read from file names only — that rule is what keeps an
       * eyecatcher off Luffy's thirty million, and it costs this row.
       *
       * Pinning it anyway would be the worse answer. The picture is an anime
       * frame of the two posters overlapping, cropped so that no figure appears
       * on it at all, and half of what it shows is Dorry: it fails the rule
       * `file` is written under, which is that somebody opened the picture and
       * read the number off it.
       *
       * So the row stays open, and « Brogy · 100 000 000 ฿ (ch. 118) » in the
       * report is the refusal working rather than a poster going missing.
       */
      { chapter: 118, amount: 100_000_000, edition: 1 },
      {
        chapter: 1130,
        amount: 1_800_000_000,
        edition: 2,
        file: 'Brogy Wanted Poster.png',
      },
    ],
  },
  {
    canonical: 'Buggy',
    aliases: ['buggy', 'baggy', 'buggy le clown', 'baggy le clown', 'buggy the clown'],
    rows: [
      { chapter: 96, amount: 15_000_000, edition: 1, file: "Buggy's Wanted Poster.png" },
    ],
  },
  {
    canonical: 'Don Krieg',
    aliases: ['don krieg', 'krieg'],
    rows: [
      { chapter: 96, amount: 17_000_000, edition: 1, file: "Krieg's Wanted Poster.png" },
    ],
  },
  {
    canonical: 'Portgas D. Ace',
    aliases: ['portgas d ace', 'ace', 'ace aux poings ardents', 'fire fist ace'],
    rows: [
      {
        chapter: 551,
        amount: 550_000_000,
        edition: 1,
        file: "Portgas D. Ace's Wanted Poster.png",
      },
    ],
  },
  {
    canonical: 'Dracule Mihawk',
    aliases: ['dracule mihawk', 'mihawk', 'oeil de faucon', 'œil de faucon', 'hawk eyes'],
    rows: [
      {
        chapter: 1058,
        amount: 3_590_000_000,
        edition: 1,
        file: "Mihawk's Wanted Poster.png",
      },
    ],
  },
  {
    canonical: 'Crocodile',
    aliases: ['crocodile', 'sir crocodile', 'mr 0'],
    rows: [
      {
        chapter: 1058,
        amount: 1_965_000_000,
        edition: 1,
        file: "Crocodile's Wanted Poster.png",
      },
    ],
  },
]

/**
 * A name reduced to the form both sides can be compared in.
 *
 * Accents folded, punctuation dropped, padded with spaces so a caller can test
 * for a whole word: « Robin » must not match « Robins » and « Nami » must not
 * match « Dynamite ». Same shape as `fileWords()` in era.ts, and deliberately
 * so.
 */
export function nameWords(value: string): string {
  const base = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
  return ` ${base} `
}

/** The character a graph label or a gallery caption is talking about. */
export function bountyCharacter(label: string): BountyHistory | null {
  const words = nameWords(label)
  let best: BountyHistory | null = null
  let bestLength = 0

  for (const character of BOUNTY_HISTORY) {
    for (const alias of character.aliases) {
      const padded = nameWords(alias)
      if (!words.includes(padded)) continue
      /*
       * The longest alias wins, and that is not a tie-break for tidiness.
       * « Vinsmoke Sanji » contains « Sanji »; a label that carries the longer
       * form is telling us something the shorter one does not, and taking the
       * first match in declaration order would silently prefer whichever line
       * happened to be written first.
       */
      if (padded.length > bestLength) {
        best = character
        bestLength = padded.length
      }
    }
  }

  return best
}

/**
 * The poster a reader at this chapter knows, which is the last one printed at
 * or before it.
 *
 * Null before the first: a character with no bounty yet has no poster, and that
 * is most characters for most of the story. Nothing is guessed and nothing is
 * rounded up to the nearest known printing.
 */
export function bountyAtChapter(
  character: BountyHistory,
  chapter: number,
): Bounty | null {
  let known: Bounty | null = null
  for (const row of character.rows) {
    if (row.chapter <= chapter) known = row
  }
  return known
}

/** Every printing revealed at or before a chapter, oldest first. */
export function bountiesUpTo(character: BountyHistory, chapter: number): Bounty[] {
  return character.rows.filter((row) => row.chapter <= chapter)
}

/** The narrow no-break space French groups its digits with. */
const NNBSP = '\u202f'

/**
 * A figure, printed the way a poster prints it.
 *
 * Grouped by hand rather than through `toLocaleString`, whose separator comes
 * from whichever ICU the runtime was built with: the same number came out with
 * a narrow no-break space here and a plain one elsewhere, and a figure that
 * renders differently per host is a figure that cannot be tested. No-break
 * throughout, so « 1 111 000 000 ฿ » never breaks across two lines of a card
 * four inches wide.
 */
export function formatBerries(amount: number): string {
  const grouped = String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)
  return `${grouped}${NNBSP}\u0e3f`
}
