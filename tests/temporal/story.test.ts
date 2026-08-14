import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getStoryPage, type BeatKind, type StoryPage } from '@/domains/temporal/story.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  addPortrait,
  addPresence,
  addQuote,
  closeDb,
  raw,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The thread, one stretch at a time.
 *
 * These pin which beads land on which chapter, what a chapter with nothing in
 * it looks like, and where the thread stops. That a bead never borrows a later
 * chapter's knowledge is pinned separately, in the anti-spoiler suite, because
 * it is the one that must stay blocking.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 4])
})

afterAll(async () => {
  await closeDb()
})

/** The beads of one chapter, minus its notch. */
function at(page: StoryPage, chapter: number, kind?: BeatKind) {
  return page.beats.filter(
    (beat) =>
      beat.chapter === chapter &&
      beat.kind !== 'chapitre' &&
      (kind === undefined || beat.kind === kind),
  )
}

async function read(from: number, count: number, ceiling: number) {
  return getStoryPage(world.userId, world.workId, { from, count, ceiling })
}

describe('a stretch of thread', () => {
  it('notches every published chapter, in reading order', async () => {
    const page = await read(1, 3, 4)

    expect(
      page.beats.filter((beat) => beat.kind === 'chapitre').map((b) => b.chapter),
    ).toEqual([1, 2, 3])
  })

  it('hands back the next chapter as a cursor, and null at the end', async () => {
    const first = await read(1, 3, 4)
    expect(first.nextCursor).toBe(4)

    const second = await read(first.nextCursor!, 3, 4)
    expect(second.beats.map((beat) => beat.chapter)).toEqual([4])
    expect(second.nextCursor).toBeNull()
  })

  it('stops at the reader’s own boundary, whatever the window asks for', async () => {
    const page = await read(1, 12, 2)

    expect([...new Set(page.beats.map((beat) => beat.chapter))]).toEqual([1, 2])
    expect(page.nextCursor).toBeNull()
    expect(page.lastChapter).toBe(2)
  })

  it('gives a chapter with nothing in it a notch and no beads', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Luffy', 'true_name', 1, 100)

    const page = await read(1, 2, 4)

    expect(at(page, 1).length).toBeGreaterThan(0)
    expect(at(page, 2)).toHaveLength(0)
    expect(
      page.beats.some((beat) => beat.chapter === 2 && beat.kind === 'chapitre'),
    ).toBe(true)
  })
})

describe('the beads', () => {
  it('puts an event on the chapter that told it', async () => {
    const event = await createEntity(world, 'event', 2)
    await addLabel(world, event, 'Le départ de Luffy', 'true_name', 2, 100)
    await addEvent(world, event, {
      summary: 'Luffy quitte Fuchsia dans un tonneau.',
      toldIn: 2,
    })

    const page = await read(1, 3, 4)

    expect(at(page, 1, 'evenement')).toHaveLength(0)
    const [beat] = at(page, 2, 'evenement')
    // The sentence, once. An event has no subtitle: the summary is the beat,
    // and the label is the same sentence with a title's job.
    expect(beat!.text).toBe('Luffy quitte Fuchsia dans un tonneau.')
    expect(beat!.detail).toBeNull()
  })

  it('marks a flashback as a memory and keeps its in-world moment', async () => {
    const event = await createEntity(world, 'event', 3)
    await addLabel(world, event, 'Le sacrifice de Shanks', 'true_name', 3, 100)
    await addEvent(world, event, {
      summary: 'Shanks perd un bras.',
      toldIn: 3,
      isFlashback: true,
      storyTime: { kind: 'approximate', description: 'environ dix ans plus tôt' },
    })

    const page = await read(3, 1, 4)
    const [beat] = at(page, 3, 'souvenir')

    expect(beat!.text).toBe('Shanks perd un bras.')
    // The moment is not a second sentence; the page puts it on the small label.
    expect(beat!.detail).toBe('environ dix ans plus tôt')
  })

  it('writes a name landing as the change, not just the new name', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'l’homme au tablier de cuir', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 3, 100)

    const page = await read(1, 4, 4)
    const [beat] = at(page, 3, 'nom')

    expect(beat!.text).toBe('Kaelo Renn')
    expect(beat!.detail).toBe('l’homme au tablier de cuir')
  })

  it('says what a refuted belief cost to hold', async () => {
    const subject = await createEntity(world, 'character', 1)
    const village = await createEntity(world, 'place', 1)
    await addLabel(world, subject, 'Higuma', 'true_name', 1, 100)
    await addLabel(world, village, 'Fuchsia', 'true_name', 1, 100)
    await addAssertion(world, {
      subject,
      predicate: 'located_at',
      object: village,
      knowledgeFrom: 1,
      knowledgeUntil: 3,
    })

    const page = await read(1, 4, 4)

    expect(at(page, 1, 'dementi')).toHaveLength(0)
    const [beat] = at(page, 3, 'dementi')
    expect(beat!.text).toBe('Higuma se trouve à Fuchsia')
    expect(beat!.detail).toBe('cru depuis le chapitre 1')
  })

  it('opens a mystery once, on its own chapter, and never again', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Le One Piece', 'true_name', 1, 100)
    await addMystery(world, mystery, {
      question: 'Qu’est-ce que le One Piece ?',
      openedIn: 1,
    })

    const page = await read(1, 4, 4)

    expect(at(page, 1, 'question')).toHaveLength(1)
    for (const chapter of [2, 3, 4]) {
      expect(at(page, chapter, 'question')).toHaveLength(0)
    }
  })

  it('closes a mystery on the chapter that resolves it', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Le trésor', 'true_name', 1, 100)
    await addMystery(world, mystery, {
      question: 'Où est le trésor ?',
      openedIn: 1,
      state: 'resolved',
      resolvedIn: 3,
    })

    const page = await read(1, 4, 4)

    expect(at(page, 1, 'question')).toHaveLength(1)
    expect(at(page, 3, 'reponse')[0]!.text).toBe('Où est le trésor ?')
  })

  it('quotes a line the pipeline anchored, never one it composed', async () => {
    const subject = await createEntity(world, 'character', 1)
    await addLabel(world, subject, 'Shanks', 'true_name', 1, 100)
    const assertionId = await addAssertion(world, {
      subject,
      predicate: 'promises',
      knowledgeFrom: 1,
      objectValue: { text: 'rendre le chapeau' },
    })
    const line = 'Rends-moi ce chapeau quand tu seras devenu un grand pirate.'
    await addQuote(world, { assertionId, chapterNumber: 1, text: line })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'citation')[0]!.text).toBe(line)
  })

  it('tells the chapter in the order it is read', async () => {
    const stranger = await createEntity(world, 'character', 2)
    await addLabel(world, stranger, 'le passeur', 'alias', 2, 10)
    const event = await createEntity(world, 'event', 2)
    await addLabel(world, event, 'La traversée', 'true_name', 2, 100)
    await addEvent(world, event, { summary: 'Ils passent.', toldIn: 2 })
    const mystery = await createEntity(world, 'mystery', 2)
    await addLabel(world, mystery, 'La marque', 'true_name', 2, 100)
    await addMystery(world, mystery, { question: 'Qui a laissé la marque ?', openedIn: 2 })

    const page = await read(2, 1, 4)

    // Who walks on, then what happens to them, then what it leaves open. The
    // event and the mystery are entities too and must not also walk on.
    expect(at(page, 2).map((beat) => beat.kind)).toEqual([
      'entree',
      'evenement',
      'question',
    ])
  })
})

/**
 * Everything below was found by looking at the real thing.
 *
 * A library of invented fixtures has three entities and one event per chapter,
 * so none of these showed up in the tests: they need a chapter that introduces
 * thirty-five entities, half of which are events. Chapter 1 of the real work
 * did, and produced a page two hundred inches long in which every event
 * appeared three times.
 */
describe('what the first real chapter showed', () => {
  it('does not walk an event on as if it were a character', async () => {
    const event = await createEntity(world, 'event', 1)
    await addLabel(world, event, 'Le duel du quai', 'true_name', 1, 100)
    await addEvent(world, event, { summary: 'Ils se battent.', toldIn: 1 })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'entree')).toHaveLength(0)
    expect(at(page, 1, 'evenement')).toHaveLength(1)
  })

  it('does not walk a mystery on as if it were a character', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'La marque', 'true_name', 1, 100)
    await addMystery(world, mystery, { question: 'Qui a laissé la marque ?', openedIn: 1 })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'entree')).toHaveLength(0)
    expect(at(page, 1, 'question')).toHaveLength(1)
  })

  it('does not call a first name a reveal', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'nom')).toHaveLength(0)
    expect(at(page, 1, 'entree')[0]!.text).toBe('Monkey D. Luffy')
  })

  it('does not print a truncated copy of the sentence above it', async () => {
    /*
     * The label is capped at 200 characters and the summary at 400, so a long
     * event is named by its own summary cut off mid-word. Equality did not see
     * that as a repetition; the reader did.
     */
    const event = await createEntity(world, 'event', 1)
    const complet =
      'Une fois libéré, Zoro bloque les épées de tous les Marines chargeant ' +
      'avec ses trois sabres et les menace de mort s’ils bougent, avant ' +
      'd’annoncer sa décision de rejoindre Luffy tout en posant ses conditions ' +
      'liées à son rêve de devenir le meilleur sabreur du monde.'
    await addLabel(world, event, complet.slice(0, 200), 'true_name', 1, 100)
    await addEvent(world, event, { summary: complet, toldIn: 1 })

    const [beat] = at(await read(1, 1, 4), 1, 'evenement')

    expect(beat!.text).toBe(complet)
    expect(beat!.detail).toBeNull()
  })

  it('does not print an event’s sentence twice when it is also its name', async () => {
    const event = await createEntity(world, 'event', 1)
    const phrase = 'Shanks sauve Luffy et perd son bras gauche.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)
    const [beat] = at(page, 1, 'evenement')

    expect(beat!.text).toBe(phrase)
    expect(beat!.detail).toBeNull()
  })

  it('keeps events in the order they were told, not in alphabetical order', async () => {
    for (const name of ['Zéphyr lève l’ancre', 'Un canot dérive', 'Alba tombe']) {
      const event = await createEntity(world, 'event', 1)
      await addLabel(world, event, name, 'true_name', 1, 100)
      // A summary that is not a prefix of the label: this test is about order,
      // and a label the summary echoes would now be replaced by it.
      await addEvent(world, event, { summary: `Quelque chose arrive : ${name}.`, toldIn: 1 })
    }

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'evenement').map((beat) => beat.text)).toEqual([
      'Quelque chose arrive : Zéphyr lève l’ancre.',
      'Quelque chose arrive : Un canot dérive.',
      'Quelque chose arrive : Alba tombe.',
    ])
  })

  it('refuses a quote torn out of the middle of a sentence', async () => {
    const subject = await createEntity(world, 'character', 1)
    await addLabel(world, subject, 'Luffy', 'true_name', 1, 100)
    const assertionId = await addAssertion(world, {
      subject,
      predicate: 'seeks',
      knowledgeFrom: 1,
      objectValue: { text: 'le One Piece' },
    })
    await addQuote(world, {
      assertionId,
      chapterNumber: 1,
      text: 'declaring he will get a crew stronger than Shanks and the most',
    })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'citation')).toHaveLength(0)
  })

  it('shows the same line once, however many rows carry it', async () => {
    for (const _ of [0, 1]) {
      const twin = await createEntity(world, 'character', 1)
      await addLabel(world, twin, 'Benn Beckman', 'true_name', 1, 100)
    }

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'entree')).toHaveLength(1)
  })
})

describe('ce que le vrai chapitre 1 a encore montré', () => {
  it('calls a character by the short name the sentence uses', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Monkey D. Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Luffy quitte le village dans un tonneau, sans se retourner.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const parts = at(await read(1, 1, 4), 1, 'evenement')[0]!.textParts

    expect(parts).not.toBeNull()
    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Luffy',
    ])
  })

  it('refuses a short name two characters could answer to', async () => {
    const ace = await createEntity(world, 'character', 1)
    const other = await createEntity(world, 'character', 1)
    await addLabel(world, ace, 'Portgas D. Ace', 'true_name', 1, 100)
    await addLabel(world, other, 'Bannis D. Ace', 'true_name', 1, 100)
    await addPortrait(world, ace, { matchedLabel: 'Portgas D. Ace', revealedIn: 1 })
    await addPortrait(world, other, { matchedLabel: 'Bannis D. Ace', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Ace traverse la place sans un mot pour les villageois.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    expect(at(await read(1, 1, 4), 1, 'evenement')[0]!.textParts).toBeNull()
  })

  it('does not quote a chapter whose source is not French', async () => {
    const subject = await createEntity(world, 'character', 1)
    await addLabel(world, subject, 'Shanks', 'true_name', 1, 100)
    const assertionId = await addAssertion(world, {
      subject,
      predicate: 'promises',
      knowledgeFrom: 1,
      objectValue: { text: 'x' },
    })
    await addQuote(world, {
      assertionId,
      chapterNumber: 1,
      text: 'The Red Hair Pirates then raise anchor and set sail from the village.',
    })
    await raw`UPDATE chapters SET language = 'en' WHERE user_id = ${world.userId}`

    expect(at(await read(1, 1, 4), 1, 'citation')).toHaveLength(0)
  })

  it('folds a chapter’s events past the fifth, without dropping any', async () => {
    for (let i = 0; i < 8; i++) {
      const event = await createEntity(world, 'event', 1)
      await addLabel(world, event, `Événement ${i}`, 'true_name', 1, 100)
      await addEvent(world, event, { summary: `Il arrive ${i}.`, toldIn: 1 })
    }

    const events = at(await read(1, 1, 4), 1, 'evenement')

    expect(events).toHaveLength(8)
    expect(events.filter((beat) => beat.collapsed)).toHaveLength(3)
    expect(events.slice(0, 5).every((beat) => !beat.collapsed)).toBe(true)
  })
})

describe('the faces on the thread', () => {
  it('gives a character their portrait', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, {
      matchedLabel: 'Monkey D. Luffy',
      revealedIn: 1,
    })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'entree')[0]!.portrait).not.toBeNull()
    expect(at(page, 1, 'entree')[0]!.portrait!.matchedLabel).toBe('Monkey D. Luffy')
  })

  it('gives a face to someone who is only spoken of', async () => {
    /*
     * « On en parle · Polo » came back a grey square, then « entre en scène ·
     * Polo » two chapters later carried his face. The bead about a name is the
     * one that least survives having none: the kind was split out of « entre en
     * scène » and this list was not told about it.
     */
    const polo = await createEntity(world, 'character', 2)
    await addLabel(world, polo, 'Polo', 'true_name', 2, 100)
    await addPresence(world, polo, { chapterNumber: 2, kind: 'mention' })
    await addPortrait(world, polo, { matchedLabel: 'Polo', revealedIn: 2 })

    const page = await read(1, 4, 4)
    const beat = at(page, 2, 'mention')[0]!

    expect(beat.text).toBe('Polo')
    expect(beat.portrait).not.toBeNull()
    expect(beat.portrait!.matchedLabel).toBe('Polo')
  })

  it('does not spend its budget on entities that have no picture', async () => {
    /*
     * The failure this pins: a chapter introduces a crowd, the cap trims the
     * *candidates* to the first handful, those happen to be groups and places
     * no catalogue illustrates, and the chapter comes back with no faces —
     * looking exactly like a chapter whose characters matched nothing.
     */
    // More candidates than the cap, and the only one with a face is last.
    for (let i = 0; i < 20; i++) {
      const extra = await createEntity(world, 'place', 1)
      await addLabel(world, extra, `Île ${i}`, 'true_name', 1, 100)
    }
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, {
      matchedLabel: 'Monkey D. Luffy',
      revealedIn: 1,
    })

    const page = await read(1, 1, 4)
    const face = at(page, 1, 'entree').find((beat) => beat.entityId === luffy)

    expect(face!.portrait).not.toBeNull()
  })

  it('finds a picture hanging off the merged half of an entity', async () => {
    const silhouette = await createEntity(world, 'character', 1)
    const named = await createEntity(world, 'character', 1)
    await addLabel(world, silhouette, 'la silhouette', 'alias', 1, 10)
    await addLabel(world, named, 'Shanks', 'true_name', 1, 100)
    // The catalogue matched the half that carries the true name.
    await addPortrait(world, named, { matchedLabel: 'Shanks', revealedIn: 1 })
    await addAssertion(world, {
      subject: silhouette,
      predicate: 'same_as',
      object: named,
      knowledgeFrom: 1,
    })

    const page = await read(1, 1, 4)
    const beat = at(page, 1, 'entree').find(
      (candidate) => candidate.entityId === silhouette,
    )

    expect(beat!.portrait).not.toBeNull()
    expect(beat!.portrait!.matchedLabel).toBe('Shanks')
  })

  it('puts a face beside every named character inside a sentence', async () => {
    const shanks = await createEntity(world, 'character', 1)
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, shanks, 'Shanks', 'true_name', 1, 100)
    await addLabel(world, luffy, 'Luffy', 'true_name', 1, 100)
    await addPortrait(world, shanks, { matchedLabel: 'Shanks', revealedIn: 1 })
    await addPortrait(world, luffy, { matchedLabel: 'Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase =
      'Au Partys Bar, Shanks refuse d’emmener Luffy en mer, jugeant qu’il est trop jeune.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)
    const parts = at(page, 1, 'evenement')[0]!.textParts

    expect(parts).not.toBeNull()
    expect(parts!.map((part) => part.text).join('')).toBe(phrase)
    expect(
      parts!.filter((part) => part.portrait).map((part) => part.text),
    ).toEqual(['Shanks', 'Luffy'])
  })

  it('does not grow a face in the middle of a word', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Luffytaro traverse le pont sans que personne ne le voie.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'evenement')[0]!.textParts).toBeNull()
  })

  it('prefers the longest name when two overlap', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Luffy', 'alias', 1, 10)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Monkey D. Luffy quitte le village au petit matin, seul.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)
    const parts = at(page, 1, 'evenement')[0]!.textParts

    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Monkey D. Luffy',
    ])
  })

  /*
   * What a chapter *recounts* about someone is not a rival claim on their name.
   *
   * An event is a row in `entities` and its label is its own summary, so
   * « Baggy s'empare du chapeau de paille de Luffy » ended on the short name
   * « Luffy » exactly like « Monkey D. Luffy » does — two entities claiming it,
   * a coin flip refused, and no face beside the one character the sentence is
   * about. Worse, the labels are read from the whole library rather than from
   * the chapter, so one such event anywhere silenced every chapter after it.
   */
  it('keeps a short name a sentence merely ends with', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Monkey D. Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Baggy s’empare du chapeau de paille de Luffy'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const parts = at(await read(1, 1, 4), 1, 'evenement')[0]!.textParts

    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Luffy',
    ])
  })

  it('gives a name to its owner rather than to what is named after them', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Monkey D. Luffy', revealedIn: 1 })

    const hat = await createEntity(world, 'object', 1)
    await addLabel(world, hat, 'Chapeau de paille de Luffy', 'true_name', 1, 100)

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Baggy jette le chapeau au sol et crache dessus devant Luffy.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const parts = at(await read(1, 1, 4), 1, 'evenement')[0]!.textParts

    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Luffy',
    ])
  })

  it('answers a short name filed twice under the same full name', async () => {
    /*
     * Two rows, one person: entity resolution did not merge them. The reader
     * cannot see the duplicate and should not pay for it — one name held twice
     * is not two names, so the half that has a face answers.
     */
    const twin = await createEntity(world, 'character', 1)
    await addLabel(world, twin, 'Monkey D. Luffy', 'true_name', 1, 100)

    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPortrait(world, luffy, { matchedLabel: 'Monkey D. Luffy', revealedIn: 1 })

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Luffy frappe Baggy à l’estomac, sans un mot de plus.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const parts = at(await read(1, 1, 4), 1, 'evenement')[0]!.textParts

    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Luffy',
    ])
  })

  it('leaves a name alone when the library has no face for it', async () => {
    const shanks = await createEntity(world, 'character', 1)
    await addLabel(world, shanks, 'Shanks', 'true_name', 1, 100)

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Shanks lève l’ancre sans se retourner vers le village.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'evenement')[0]!.textParts).toBeNull()
  })

  it('never puts a face on a name the reader has not been given', async () => {
    /*
     * The sentence contains the true name because chapter 4 wrote it. Read at
     * chapter 2, that label does not exist — row-level security removed it —
     * so nothing matches and the reader sees the sentence as written, with no
     * face and no link to a character they have not met.
     */
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'la silhouette', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 4, 100)
    await addPortrait(world, stranger, {
      matchedLabel: 'Kaelo Renn',
      revealedIn: 4,
    })

    const event = await createEntity(world, 'event', 2)
    const phrase = 'Kaelo Renn traverse la place sans que personne ne le nomme.'
    await addLabel(world, event, phrase, 'true_name', 2, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 2 })

    const page = await read(1, 4, 4)

    expect(at(page, 2, 'evenement')[0]!.textParts).toBeNull()
  })

  it('never shows a face before the name that found it', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'l’homme au tablier de cuir', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 3, 100)
    await addPortrait(world, stranger, {
      matchedLabel: 'Kaelo Renn',
      revealedIn: 3,
    })

    const page = await read(1, 4, 4)

    expect(at(page, 1, 'entree')[0]!.portrait).toBeNull()
    expect(at(page, 3, 'nom')[0]!.portrait).not.toBeNull()
  })

  /*
   * A busy chapter used to run out of faces, and the ones it dropped were the
   * ones the reader was looking at.
   *
   * The thread asked for a fixed number of portraits per chapter, and the order
   * it asked in was « longest label first » — a tie-break borrowed from the
   * regex that cuts the sentences, which has nothing to say about what the page
   * draws. So a chapter carrying twenty walk-ons with long descriptive names
   * spent the whole allowance on them, and « Smoker bloque Luffy et Sanji »
   * came out with a face beside Luffy and nothing beside the other two.
   *
   * Twenty here, against an allowance that used to be sixteen.
   */
  it('runs out of nothing, however many faces a chapter needs', async () => {
    const crowd = 20
    for (let index = 0; index < crowd; index += 1) {
      const walkOn = await createEntity(world, 'character', 1)
      await addLabel(world, walkOn, `Marin de garde numéro ${index} de Logue Town`, 'true_name', 1, 100)
      await addPortrait(world, walkOn, {
        matchedLabel: `Marin de garde numéro ${index} de Logue Town`,
        revealedIn: 1,
      })
    }

    for (const name of ['Smoker', 'Luffy', 'Sanji']) {
      const character = await createEntity(world, 'character', 1)
      await addLabel(world, character, name, 'true_name', 1, 100)
      await addPortrait(world, character, { matchedLabel: name, revealedIn: 1 })
    }

    const event = await createEntity(world, 'event', 1)
    const phrase = 'Smoker bloque Luffy et Sanji, et les bat sans effort.'
    await addLabel(world, event, phrase, 'true_name', 1, 100)
    await addEvent(world, event, { summary: phrase, toldIn: 1 })

    const page = await read(1, 1, 4)
    const parts = at(page, 1, 'evenement')[0]!.textParts

    expect(parts!.filter((part) => part.portrait).map((part) => part.text)).toEqual([
      'Smoker',
      'Luffy',
      'Sanji',
    ])

    // And the walk-ons keep theirs: this is not a budget moved elsewhere.
    expect(
      at(page, 1, 'entree').filter((beat) => beat.portrait !== null),
    ).toHaveLength(crowd + 3)
  })
})

describe('a library with nothing in it', () => {
  it('returns an empty thread rather than failing', async () => {
    const page = await getStoryPage(world.userId, '', {
      from: 1,
      count: 5,
      ceiling: 4,
    })

    expect(page.beats).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('returns nothing when the reader has read nothing', async () => {
    const page = await read(1, 5, 0)
    expect(page.beats).toEqual([])
  })
})

/**
 * Heard of, then seen.
 *
 * Koby tells Luffy about a pirate hunter named Zoro at chapter 2; Zoro walks on
 * at chapter 3. The graph called both the same thing, because the occurrence
 * kind was derived from the medium of the evidence and a written chapter has no
 * drawings — so everything was a mention, and « entre en scène » fired wherever
 * the entity was first heard of.
 */
describe('mentionné, puis vu', () => {
  it('says a character is spoken of before they walk on', async () => {
    const zoro = await createEntity(world, 'character', 2)
    await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 2, 100)
    await addPresence(world, zoro, { chapterNumber: 2, kind: 'mention' })
    await addPresence(world, zoro, { chapterNumber: 3, kind: 'appearance' })

    const page = await read(1, 4, 4)

    expect(at(page, 2, 'mention').map((beat) => beat.text)).toEqual([
      'Roronoa Zoro',
    ])
    expect(at(page, 2, 'entree')).toHaveLength(0)
    expect(at(page, 3, 'entree').map((beat) => beat.text)).toEqual([
      'Roronoa Zoro',
    ])
  })

  it('walks someone on at the chapter that shows them', async () => {
    const kuina = await createEntity(world, 'character', 3)
    await addLabel(world, kuina, 'Kuina', 'true_name', 3, 100)
    await addPresence(world, kuina, { chapterNumber: 3, kind: 'appearance' })

    const page = await read(1, 4, 4)

    expect(at(page, 3, 'entree')).toHaveLength(1)
    expect(at(page, 3, 'mention')).toHaveLength(0)
  })

  it('leaves a library recorded before the field exactly as it was', async () => {
    /*
     * No stated row at all: the old answer, walking on. Occurrences written
     * before migration 0020 say « mention » about everyone, and reading those
     * would demote every character ever imported.
     */
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

    const page = await read(1, 1, 4)

    expect(at(page, 1, 'entree')).toHaveLength(1)
    expect(at(page, 1, 'mention')).toHaveLength(0)
  })

  it('does not walk a character on again at the first chapter that states it', async () => {
    /*
     * The half of the library imported after the field met the half imported
     * before it, and every recurring character walked on a second time.
     *
     * Luffy is in chapter 1 and in every chapter since. The chapters read
     * before migration 0020 hold no stated row about him — that is what the
     * migration says they mean — so the first chapter imported after it was
     * the first chapter *stating* that he is on the page, and « personne vue
     * enfin » fired for someone the reader had followed for twenty chapters.
     *
     * Absence of a stated appearance is not evidence of absence. Walking on
     * late is claimed only where the graph says he was spoken of and not
     * seen.
     */
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addPresence(world, luffy, { chapterNumber: 4, kind: 'appearance' })

    const page = await read(1, 4, 4)

    expect(at(page, 1, 'entree')).toHaveLength(1)
    expect(at(page, 4, 'entree')).toHaveLength(0)
  })
})

describe('l’ordre des entrées en scène', () => {
  it('introduces people before what they carry', async () => {
    /*
     * « Gomu Gomu no Pistol entre en scène » stood above the character whose
     * power it is, because the order was the order the extraction happened to
     * emit them. A chapter introduces a cast, then where they are, then what
     * they carry.
     */
    const pouvoir = await createEntity(world, 'power', 1)
    await addLabel(world, pouvoir, 'Gomu Gomu no Pistol', 'true_name', 1, 100)
    const lieu = await createEntity(world, 'place', 1)
    await addLabel(world, lieu, 'Village de Fuchsia', 'true_name', 1, 100)
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

    const beats = at(await read(1, 1, 4), 1, 'entree')

    expect(beats.map((beat) => beat.text)).toEqual([
      'Monkey D. Luffy',
      'Village de Fuchsia',
      'Gomu Gomu no Pistol',
    ])
  })
})
