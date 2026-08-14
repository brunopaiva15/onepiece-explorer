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
 * The crew, and nobody else, for now.
 *
 * Ten characters is not an arbitrary stopping point: their bounties are the
 * ones every reader knows the chapter of, which is exactly what makes this list
 * auditable. Warlords and Emperors are the obvious next block, and every one of
 * them needs the same treatment, one line at a time.
 */
export const BOUNTY_HISTORY: readonly BountyHistory[] = [
  {
    canonical: 'Monkey D. Luffy',
    aliases: ['monkey d luffy', 'luffy', 'chapeau de paille', 'straw hat luffy'],
    rows: [
      { chapter: 96, amount: 30_000_000, edition: 1 },
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
      { chapter: 435, amount: 120_000_000, edition: 2 },
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
      { chapter: 435, amount: 16_000_000, edition: 1 },
      { chapter: 801, amount: 66_000_000, edition: 2, file: "Nami's Current Wanted Poster.png" },
      { chapter: 1058, amount: 366_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Usopp',
    aliases: ['usopp', 'god usopp', 'sogeking', 'pipo', 'sniper king'],
    rows: [
      { chapter: 435, amount: 30_000_000, edition: 1 },
      { chapter: 801, amount: 200_000_000, edition: 2, file: "God Usopp's Wanted Poster.png" },
      { chapter: 1058, amount: 500_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Sanji',
    aliases: ['sanji', 'vinsmoke sanji', 'black leg sanji', 'jambe noire'],
    rows: [
      { chapter: 435, amount: 77_000_000, edition: 1 },
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
      { chapter: 435, amount: 80_000_000, edition: 2 },
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
      { chapter: 435, amount: 44_000_000, edition: 1 },
      { chapter: 801, amount: 94_000_000, edition: 2 },
      { chapter: 1058, amount: 394_000_000, edition: 3 },
    ],
  },
  {
    canonical: 'Brook',
    aliases: ['brook', 'soul king brook', 'humming brook', 'soul king'],
    rows: [
      { chapter: 489, amount: 33_000_000, edition: 1 },
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
