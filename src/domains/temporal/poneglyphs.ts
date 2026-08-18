/**
 * Les ponéglyphes, et le chapitre où le lecteur les apprend.
 *
 * A poneglyph is the other end of the same problem the wanted posters posed. A
 * bounty is a spoiler because the number moves; a poneglyph is a spoiler
 * because the *stone* moves — not in the world, but in what a reader is allowed
 * to know about it. The block in the royal tomb of Alubarna is « un ponéglyphe »
 * at chapter 193, « le ponéglyphe du Tombeau des Rois » at 202, a stone Robin
 * claims holds nothing but history at 203, and the stone that gives the
 * location of Pluton at 1053. Every one of those is the truth, and printing the
 * fourth one on the home page of somebody reading Alabasta hands them eight
 * hundred chapters at once.
 *
 * So the manifest dates every single thing it says. Not one chapter per stone —
 * one chapter per *claim about* a stone: when the reader hears it exists, when
 * they see it, when they watch somebody read it, when they are told where it
 * stands, when they are told it is a Road Poneglyph, when they are told nobody
 * knows where it is. A view of a stone at chapter N carries only the claims
 * dated at or before N, and `poneglyphsKnownAt` is the only thing that decides
 * it.
 *
 * Written by hand, for the reason bounties.ts gives at length and which is
 * worth stating once more here. Everything else on a page of this site is
 * something a chapter *told* the reader, extracted from imported material and
 * held behind the boundary. This is not that: it is the table of a work
 * published for thirty years, identical for everyone, checkable by anybody who
 * owns the volume. No extraction is going to improve on a stone somebody
 * located by reading the page it appears on.
 *
 * Where the chapters come from: the One Piece Wiki's own citations on
 * `Poneglyph`, which name a chapter and a page for each stone, checked against
 * the chapter summaries. That is the same standard bounties.ts holds its five
 * non-crew characters to. Whoever extends this next: cite the chapter and the
 * page in a comment beside the line, and never write a chapter you have not
 * seen a citation or a page for.
 *
 * Two things are deliberately absent.
 *
 *   **What a stone says.** The contents are the densest spoiler this work has —
 *   the Alabasta stone gives Pluton's location, and the chapter that tells the
 *   reader so is a thousand chapters past the one that shows the stone. A card
 *   here says that a stone exists, where it stands and whether somebody has
 *   read it. What it said is the story's to tell.
 *
 *   **The Hachinosu stone.** It is real and it has no chapter: it comes from an
 *   author's Q&A rather than from a page. There is no honest way to date it on
 *   the axis this site reads on, so it is not here — and this paragraph exists
 *   so the next person does not think it was forgotten.
 */

import { normalizeText } from '../knowledge/normalize.ts'

/** Where a stone is, as one chapter describes it. */
export interface PoneglyphWhere {
  /** The chapter that gives this description. */
  chapter: number
  /** How a card names the place. */
  text: string
  /**
   * Names the library may hold for that place, so a card can link into the
   * graph.
   *
   * Matched as whole words inside a label the reader has been told, which is
   * why « Alabasta » finds « Royaume d'Alabasta » and why it cannot find
   * « Alabastan ». Absent when no place in the graph could stand for it: an
   * island the story never named has nothing to point at.
   */
  entities?: string[]
}

/** One stele, and every dated claim this site makes about it. */
export interface Poneglyph {
  /** Stable key. Never shown; it identifies a line across a rename. */
  slug: string
  /**
   * What a card calls it, and it has to be safe at `known`.
   *
   * No name here says « road » — that classification arrives at chapter 818 and
   * is carried by `road`, so a stone seen at 817 is not labelled by the
   * interface with a word the story has not used yet.
   */
  name: string
  /** First chapter that tells the reader this stone exists. */
  known: number
  /** Every description of where it stands, ascending, the first dated `known`. */
  where: readonly PoneglyphWhere[]
  /** First chapter that shows it. Absent while no chapter has. */
  seen?: number
  /**
   * First chapter in which the reader watches somebody read it.
   *
   * « Watches », not « was read »: the scholars of Ohara spent years on their
   * stone and no chapter shows the reading, so that line has none. What the
   * reading *said* is never here — see the note at the top of this file.
   */
  read?: number
  /** From this chapter on, the reader may be told it is a Road Poneglyph. */
  road?: number
  /** From this chapter on, the reader knows nobody knows where it is. */
  lost?: number
}

/**
 * The stones, ordered by the chapter that reveals them.
 *
 * Ascending on purpose: this list is read as a reading order, the invariants
 * test asserts it, and a line inserted in the wrong place is the sort of
 * mistake nobody sees in a diff.
 */
export const PONEGLYPHS: readonly Poneglyph[] = [
  {
    /*
     * Le premier, et le seul que ce site montre encore à la plupart des
     * lecteurs.
     *
     * Two chapters and two different facts. At 193 Cobra gives up and agrees to
     * lead Crocodile to the stone — the reader knows a poneglyph exists in
     * Alabasta and nothing more. At 202 Cobra takes Robin down a hidden
     * staircase and the stone is on the page (ch. 202 p. 18, which is the
     * wiki's own « first appearance » for the whole subject). At 203 Robin
     * reads it aloud to Crocodile and says it holds nothing but history.
     *
     * Whether that was true is a question chapter 1053 answers, and 1053 is not
     * this line's business: `read` records that somebody read it, never what
     * they said.
     */
    slug: 'alabasta',
    name: 'Ponéglyphe d’Alabasta',
    known: 193,
    where: [
      { chapter: 193, text: 'Royaume d’Alabasta', entities: ['Alabasta'] },
      {
        chapter: 202,
        text: 'Tombeau des Rois, sous Alubarna',
        entities: ['Tombeau des Rois', 'Alubarna'],
      },
    ],
    seen: 202,
    read: 203,
  },
  {
    /*
     * Shandora's, and the reader hears of it three hundred chapters before
     * seeing it: Kalgara explains the Shandia's hereditary duty to protect the
     * stone in the flashback of chapter 290 (p. 9-10). Robin reads it under the
     * golden belfry at 301 (p. 10-15), which is also where the bell puts it on
     * the page.
     */
    slug: 'shandora',
    name: 'Ponéglyphe de Shandora',
    known: 290,
    where: [
      { chapter: 290, text: 'Shandora, la cité d’or', entities: ['Shandora'] },
      {
        chapter: 301,
        text: 'sous le Grand Beffroi d’or, Skypiea',
        entities: ['Shandora', 'Skypiea'],
      },
    ],
    seen: 301,
    read: 301,
  },
  {
    /*
     * Ohara's, in the basement of the Tree of Knowledge. Announced to Spandine
     * over a call at 394 — « on a trouvé le ponéglyphe » — and on the page at
     * 395 (p. 3), where the agents find it unscathed after setting off a bomb
     * around it.
     *
     * No `read`. The scholars of Ohara deciphered it over years of work and no
     * chapter shows the reading; Clover recounts what the stones say about the
     * Void Century, which is a different act. Leaving it absent is the honest
     * answer and not an omission.
     */
    slug: 'ohara',
    name: 'Ponéglyphe d’Ohara',
    known: 394,
    where: [
      { chapter: 394, text: 'Ohara', entities: ['Ohara'] },
      {
        chapter: 395,
        text: 'sous-sol de l’Arbre de la Connaissance, Ohara',
        entities: ['Arbre de la Connaissance', 'Ohara'],
      },
    ],
    seen: 395,
  },
  {
    /*
     * The one Robin found on the run as a child, in a wood on an island the
     * story never named (ch. 398 p. 7). Found and read in the same chapter, and
     * there is nothing to point a link at: an unnamed island is not a place the
     * graph can hold.
     */
    slug: 'west-blue',
    name: 'Ponéglyphe d’une forêt de West Blue',
    known: 398,
    where: [{ chapter: 398, text: 'une île de West Blue, jamais nommée' }],
    seen: 398,
    read: 398,
  },
  {
    /*
     * La Forêt Marine. Robin says at 616 (p. 7) that the stone on Fish-Man
     * Island should carry something of the Void Century — the island, not yet
     * the forest — and finds and reads it at 628 (p. 15), where what it carries
     * turns out to read as a letter. Neptune explains that letter at 649, which
     * is a claim about the contents and therefore not on this line.
     */
    slug: 'foret-marine',
    name: 'Ponéglyphe de la Forêt Marine',
    known: 616,
    where: [
      {
        chapter: 616,
        text: 'Île des Hommes-Poissons',
        entities: ['Île des Hommes-Poissons'],
      },
      {
        chapter: 628,
        text: 'Forêt Marine, Île des Hommes-Poissons',
        entities: ['Forêt Marine', 'Île des Hommes-Poissons'],
      },
    ],
    seen: 628,
    read: 628,
  },
  {
    /*
     * Celui des ruines côtières, et il arrive par une histoire de couverture.
     *
     * The locals Jinbe saved dig it out of ruins thrown ashore by Wadatsumi, on
     * the cover of chapter 778, and he leaves with it on the cover of 785. A
     * cover story is a page of the chapter the reader is holding, so it is dated
     * like any other page. Big Mom thanks him for it at 829 (p. 17), which is
     * where the reader learns where the stone went.
     */
    slug: 'ruines-cotieres',
    name: 'Ponéglyphe des ruines côtières',
    known: 778,
    where: [
      { chapter: 778, text: 'des ruines côtières remontées par Wadatsumi' },
      {
        chapter: 829,
        text: 'aux mains de Big Mom, Totto Land',
        entities: ['Totto Land', 'Whole Cake Island'],
      },
    ],
    seen: 778,
  },
  {
    /*
     * Zou's, in the Whale Tree (ch. 817 p. 15-16, where Robin finds it and asks
     * Inuarashi's leave to read it; the reading and the rubbing are at 818).
     *
     * The one line in this file where `road` earns its keep. The stone is on the
     * page at 817 and the words « road ponéglyphe » are Inuarashi's at 818
     * (p. 4-7) — so a reader sitting exactly on 817 gets a poneglyph in a tree,
     * with no badge and no talk of a fourth of anything, which is precisely what
     * they have read.
     */
    slug: 'zou',
    name: 'Ponéglyphe de Zou',
    known: 817,
    where: [
      { chapter: 817, text: 'dans l’Arbre-Baleine, Zou', entities: ['Arbre-Baleine', 'Zou'] },
    ],
    seen: 817,
    read: 818,
    road: 818,
  },
  {
    /*
     * Big Mom's. Nekomamushi reveals at 818 (p. 8-9) that she and Kaidô each
     * hold one; the stone itself is on the page at 846 (p. 12-15), under guard
     * in the Room of Treasure.
     */
    slug: 'big-mom',
    name: 'Ponéglyphe de Big Mom',
    known: 818,
    where: [
      {
        chapter: 818,
        text: 'aux mains de Big Mom, Totto Land',
        entities: ['Totto Land', 'Whole Cake Island'],
      },
      {
        chapter: 846,
        text: 'Salle du Trésor, Whole Cake Chateau',
        entities: ['Whole Cake Chateau', 'Whole Cake Island'],
      },
    ],
    seen: 846,
    road: 818,
  },
  {
    /*
     * Kaidô's, from the same reveal at 818. Where it actually stands — a cavern
     * at the foot of the sunken Mt. Fuji of old Wano — is Sukiyaki's to explain
     * at 1055 (p. 5-9), and nothing before that chapter may name it.
     *
     * No `seen`: I have no citation for a chapter that puts this stone on the
     * page, and inventing one would put a picture in a reader's hands that the
     * work never gave them.
     */
    slug: 'kaido',
    name: 'Ponéglyphe de Kaidô',
    known: 818,
    where: [
      { chapter: 818, text: 'aux mains de Kaidô, Pays des Wa', entities: ['Pays des Wa'] },
      {
        chapter: 1055,
        text: 'une caverne au pied du mont Fuji englouti, Pays des Wa',
        entities: ['Pays des Wa'],
      },
    ],
    road: 818,
  },
  {
    /*
     * Le quatrième, dont personne ne sait plus rien.
     *
     * At 818 (p. 8) the reader learns that a fourth road poneglyph exists and
     * that nobody knows where it is — that is the whole of what they know, and
     * `lost` is what says so. The flashback of 967 (p. 8-10) shows it in the Sea
     * Forest twenty-five years earlier, beside Joy Boy's letter, which is a fact
     * about where it *was*.
     */
    slug: 'quatrieme-perdu',
    name: 'Ponéglyphe disparu',
    known: 818,
    where: [
      { chapter: 818, text: 'emplacement inconnu' },
      {
        chapter: 967,
        text: 'la Forêt Marine, vingt-cinq ans plus tôt',
        entities: ['Forêt Marine', 'Île des Hommes-Poissons'],
      },
    ],
    seen: 967,
    road: 818,
    lost: 818,
  },
  {
    /* A second stone in the same treasure room, acquired nobody knows how
       (ch. 846 p. 12-15). */
    slug: 'big-mom-second',
    name: 'Second ponéglyphe de Big Mom',
    known: 846,
    where: [
      {
        chapter: 846,
        text: 'Salle du Trésor, Whole Cake Chateau',
        entities: ['Whole Cake Chateau', 'Whole Cake Island'],
      },
    ],
    seen: 846,
  },
  {
    /* Found by Brook in his soul form, behind a very firm door under the
       shogun's castle (ch. 934 p. 9). */
    slug: 'capitale-des-fleurs',
    name: 'Ponéglyphe de la Capitale des Fleurs',
    known: 934,
    where: [
      {
        chapter: 934,
        text: 'sous le château du shogun, Capitale des Fleurs',
        entities: ['Capitale des Fleurs', 'Pays des Wa'],
      },
    ],
    seen: 934,
  },
  {
    /* One of the stones Roger's crew found on their last voyage, on an island
       the flashback does not name (ch. 967 p. 8-10). */
    slug: 'roger',
    name: 'Ponéglyphe trouvé par l’équipage de Roger',
    known: 967,
    where: [{ chapter: 967, text: 'une île inconnue, sur la route de Roger' }],
    seen: 967,
    read: 967,
  },
  {
    /* The one Law came across in the Skull Dome while hunting for the road
       poneglyph (ch. 996 p. 11-12). */
    slug: 'onigashima',
    name: 'Ponéglyphe d’Onigashima',
    known: 996,
    where: [
      {
        chapter: 996,
        text: 'deuxième sous-sol du Dôme du Crâne, Onigashima',
        entities: ['Onigashima', 'Pays des Wa'],
      },
    ],
    seen: 996,
  },
]

/**
 * What the story has said about how many stones there are, and when it said it.
 *
 * A total is a spoiler like anything else, and a worse one than it looks: told
 * that four road poneglyphs exist, a reader who has seen one knows three are
 * out there, and told that there are thirty in all, a reader who has met six
 * knows what the next eight hundred chapters are for. Neither number may appear
 * before the chapter that states it.
 */
export const PONEGLYPH_COUNTS: ReadonlyArray<{
  chapter: number
  /** How many Road Poneglyphs exist, once a chapter has said. */
  roads?: number
  /** How many poneglyphs exist in all, once a chapter has said. */
  total?: number
}> = [
  /* Inuarashi explains what the four road poneglyphs are for (ch. 818 p. 4-7). */
  { chapter: 818, roads: 4 },
  /* Tamago, explaining the guard on Big Mom's: thirty in the world
     (ch. 846 p. 12-15). */
  { chapter: 846, total: 30 },
]

/**
 * A name reduced to the form both sides can be compared in.
 *
 * Accents folded and punctuation dropped by the same normaliser the anchoring
 * uses, then padded with spaces so a caller can test for a whole word:
 * « Zou » must not match « Zoulou » and « Ohara » must not match « Oharan ».
 * Same shape as `nameWords()` in bounties.ts, and deliberately so.
 */
export function placeWords(value: string): string {
  const base = normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return ` ${base} `
}

/**
 * Does a label the reader has been told stand for this name?
 *
 * Whole-word containment rather than equality, because a graph label carries
 * whatever the chapter called it: « Royaume d'Alabasta » is the place the line
 * « Alabasta » points at, and « Alabasta » is what the manifest can write
 * without knowing which of the two this library holds.
 */
export function labelNames(label: string, alias: string): boolean {
  return placeWords(label).includes(placeWords(alias))
}

/**
 * The word itself, in the forms a library may have filed it under.
 *
 * Both numbers, because the extraction files whatever the chapter said: a
 * chapter that speaks of « les ponéglyphes » gives a label in the plural, and a
 * heading looking only for the singular would find nothing in a library that
 * holds exactly the entity this page is about.
 */
export const PONEGLYPH_WORDS = ['poneglyphe', 'poneglyphes'] as const

/** A stone as one reader knows it, with everything they have not read removed. */
export interface PoneglyphView {
  slug: string
  name: string
  /** The chapter that told them it exists. */
  known: number
  /** Where it stands, or null while no chapter they have read says where. */
  where: string | null
  /** Places in the graph this description points at. Never beyond their reading. */
  entities: readonly string[]
  /** The chapter that showed it to them, when one has. */
  seen: number | null
  /** The chapter in which they watched somebody read it, when one has. */
  read: number | null
  /** Whether they have been told this stone is a Road Poneglyph. */
  road: boolean
  /** Whether they have been told nobody knows where it is. */
  lost: boolean
}

/** The description of a stone's place that a reader at this chapter has. */
export function whereAtChapter(stone: Poneglyph, chapter: number): PoneglyphWhere | null {
  let known: PoneglyphWhere | null = null
  for (const line of stone.where) {
    if (line.chapter <= chapter) known = line
  }
  return known
}

/**
 * One stone, reduced to what a reader at this chapter has actually been told.
 *
 * Every field is cut by the same comparison, and that is the whole of the
 * spoiler-safety here: a chapter number in the future does not become a smaller
 * chapter number, it becomes null. « Vu au chapitre 202 » shown to a reader of
 * 195 would tell them the stone gets found seven chapters from now, which is a
 * spoiler dressed as a date.
 */
export function poneglyphAtChapter(stone: Poneglyph, chapter: number): PoneglyphView {
  const where = whereAtChapter(stone, chapter)
  return {
    slug: stone.slug,
    name: stone.name,
    known: stone.known,
    where: where?.text ?? null,
    entities: where?.entities ?? [],
    seen: stone.seen !== undefined && stone.seen <= chapter ? stone.seen : null,
    read: stone.read !== undefined && stone.read <= chapter ? stone.read : null,
    road: stone.road !== undefined && stone.road <= chapter,
    lost: stone.lost !== undefined && stone.lost <= chapter,
  }
}

/**
 * Every stone a reader at this chapter has heard of, in the order they heard.
 *
 * Empty for the first hundred and ninety-two chapters, which is not a gap to
 * paper over: the word does not appear in the work before Cobra says it, and a
 * page that showed « aucun ponéglyphe connu » to a reader of chapter 40 would be
 * announcing a subject the story has not raised.
 */
export function poneglyphsKnownAt(chapter: number): PoneglyphView[] {
  return PONEGLYPHS.filter((stone) => stone.known <= chapter).map((stone) =>
    poneglyphAtChapter(stone, chapter),
  )
}

/** The totals a reader at this chapter has been given, if any. */
export function poneglyphCountsAtChapter(chapter: number): {
  roads: number | null
  total: number | null
} {
  let roads: number | null = null
  let total: number | null = null
  for (const line of PONEGLYPH_COUNTS) {
    if (line.chapter > chapter) continue
    if (line.roads !== undefined) roads = line.roads
    if (line.total !== undefined) total = line.total
  }
  return { roads, total }
}
