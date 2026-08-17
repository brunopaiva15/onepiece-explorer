import { describe, expect, it } from 'vitest'
import {
  MAX_PASSES,
  MAX_SCENES_PER_QUESTION,
  resolvingScene,
  scanForResolution,
  scenePasses,
  tellableResolution,
  type Scene,
} from '@/domains/review/mystery-sweep.ts'

/**
 * The rule the backfill applies, exercised without a model or a database.
 *
 * Every case here is a way the sweep could quietly write a wrong date into the
 * reader's history — and a wrong date on a mystery is not a wrong fact among
 * others, it is a question that leaves « Sans réponse » before the chapter that
 * answers it, which is the spoiler the whole boundary machinery exists to stop.
 */

const SCENES: Scene[] = [
  { entityId: 'sc-16', chapter: 16, summary: 'Zoro se relève et défie Cabaji.' },
  { entityId: 'sc-17', chapter: 17, summary: 'Zoro achève Cabaji d’un Oni Giri.' },
  { entityId: 'sc-30', chapter: 30, summary: 'On rappelle la défaite de Cabaji.' },
]

describe('deciding that a question is closed', () => {
  it('takes the scene that answers it', () => {
    const verdict = resolvingScene(
      { insufficientData: false, citations: [{ assertionId: 'sc-17', chapter: 17 }] },
      SCENES,
      16,
    )

    expect(verdict).toEqual({ sceneId: 'sc-17', chapter: 17 })
  })

  it('keeps the earliest of several answers', () => {
    const verdict = resolvingScene(
      {
        insufficientData: false,
        citations: [
          { assertionId: 'sc-30', chapter: 30 },
          { assertionId: 'sc-17', chapter: 17 },
        ],
      },
      SCENES,
      16,
    )

    // The reader learned it at 17. Chapter 30 restating it is not when.
    expect(verdict).toEqual({ sceneId: 'sc-17', chapter: 17 })
  })

  it('closes nothing when the model says it does not know', () => {
    expect(
      resolvingScene(
        { insufficientData: true, citations: [{ assertionId: 'sc-17', chapter: 17 }] },
        SCENES,
        16,
      ),
    ).toBeNull()
  })

  it('ignores a citation of a scene that was never offered', () => {
    /*
     * The failure this exists for: a fluent answer citing an id in the right
     * shape, with a plausible chapter, that was not in the context. Accepted, it
     * would close a question on a scene nobody can open.
     */
    expect(
      resolvingScene(
        { insufficientData: false, citations: [{ assertionId: 'sc-99', chapter: 42 }] },
        SCENES,
        16,
      ),
    ).toBeNull()
  })

  it('refuses to be answered by the chapter that asked', () => {
    expect(
      resolvingScene(
        { insufficientData: false, citations: [{ assertionId: 'sc-16', chapter: 16 }] },
        SCENES,
        16,
      ),
    ).toBeNull()
  })

  it('dates the answer by the graph, not by the citation', () => {
    const verdict = resolvingScene(
      // The model misremembers which chapter the scene is from.
      { insufficientData: false, citations: [{ assertionId: 'sc-17', chapter: 900 }] },
      SCENES,
      16,
    )

    expect(verdict).toEqual({ sceneId: 'sc-17', chapter: 17 })
  })
})

function manyScenes(count: number): Scene[] {
  return Array.from({ length: count }, (_, index) => ({
    entityId: `sc-${index}`,
    chapter: index + 1,
    summary: `Scène ${index}`,
  }))
}

describe('choosing the scenes a question is weighed against', () => {
  it('cuts them into chronological windows rather than truncating', () => {
    // Passées à l'envers pour éprouver le tri, comme l'ancien test le faisait.
    const { passes, dropped } = scenePasses(
      [...manyScenes(MAX_SCENES_PER_QUESTION + 25)].reverse(),
    )

    // Earliest first: an answer usually comes soon after the question, and a
    // sweep reading the end of the story first would date resolutions late.
    expect(passes).toHaveLength(2)
    expect(passes[0]).toHaveLength(MAX_SCENES_PER_QUESTION)
    expect(passes[0]![0]!.chapter).toBe(1)
    expect(passes[0]!.at(-1)!.chapter).toBe(MAX_SCENES_PER_QUESTION)
    // Ce que la troncature jetait est maintenant la fenêtre suivante.
    expect(passes[1]).toHaveLength(25)
    expect(passes[1]![0]!.chapter).toBe(MAX_SCENES_PER_QUESTION + 1)
    expect(dropped).toBe(0)
  })

  it('still says what it left out, past the last window', () => {
    const reach = MAX_SCENES_PER_QUESTION * MAX_PASSES
    const { passes, dropped } = scenePasses(manyScenes(reach + 30))

    expect(passes).toHaveLength(MAX_PASSES)
    expect(dropped).toBe(30)
  })

  it('offers nothing when there is nothing after the question', () => {
    expect(scenePasses([])).toEqual({ passes: [], dropped: 0 })
  })
})

/*
 * Le parcours, qui est ce que la troncature remplaçait par un silence.
 *
 * Mesuré sur le balayage : « Où se trouve le trésor que Gold Roger a laissé
 * derrière lui ? », ouverte au chapitre 1, pesée contre les quatre cents scènes
 * les plus anciennes d'une bibliothèque qui en comptait neuf cents, déclarée
 * « laissée ouverte » — la réponse était dans les cinq cents non lues, et le
 * rapport avait l'aplomb d'une lecture complète.
 */
describe('scanning window by window', () => {
  const ANSWER_NOWHERE = { insufficientData: true, citations: [] }

  it('stops at the first window that answers, and pays for no more', async () => {
    const asked: number[] = []
    const passes = [manyScenes(3), manyScenes(3), manyScenes(3)]

    const scan = await scanForResolution(passes, 0, async (window) => {
      asked.push(window.length)
      return {
        refusal: false,
        answer: { insufficientData: false, citations: [{ assertionId: 'sc-1', chapter: 2 }] },
        costCents: 5,
      }
    })

    expect(asked).toHaveLength(1)
    expect(scan.resolution).toEqual({ sceneId: 'sc-1', chapter: 2 })
    expect(scan.costCents).toBe(5)
    expect(scan.passes).toBe(1)
  })

  it('goes on to the next window when the first has no answer', async () => {
    // Exactement le cas des questions du chapitre 1 : la réponse est loin.
    const early = manyScenes(2)
    const late: Scene[] = [{ entityId: 'sc-late', chapter: 812, summary: 'Le trésor est là.' }]

    let call = 0
    const scan = await scanForResolution([early, late], 1, async () => {
      call++
      return call === 1
        ? { refusal: false, answer: ANSWER_NOWHERE, costCents: 3 }
        : {
            refusal: false,
            answer: { insufficientData: false, citations: [{ assertionId: 'sc-late', chapter: 812 }] },
            costCents: 4,
          }
    })

    expect(scan.resolution).toEqual({ sceneId: 'sc-late', chapter: 812 })
    expect(scan.scene!.summary).toBe('Le trésor est là.')
    expect(scan.scenesRead).toBe(3)
    expect(scan.costCents).toBe(7)
    expect(scan.passes).toBe(2)
  })

  it('does not let one refused window end the scan', async () => {
    // Un refus n'est pas une réponse : les fenêtres suivantes méritent d'être
    // posées, et le refus n'est rapporté que s'il ne reste rien d'autre à dire.
    const scan = await scanForResolution([manyScenes(1), manyScenes(1)], 0, async () => ({
      refusal: true,
      answer: ANSWER_NOWHERE,
      costCents: 1,
    }))

    expect(scan.passes).toBe(2)
    expect(scan.refused).toBe(true)
    expect(scan.resolution).toBeNull()
  })

  it('never dates a resolution later than the earliest window that carries it', async () => {
    /*
     * La garantie que la troncature achetait, et qu'il fallait garder.
     *
     * Deux fenêtres contiennent chacune une scène qui répond. On s'arrête à la
     * première, donc la question est datée du plus tôt qu'elle pouvait l'être —
     * la seconde n'est même pas posée.
     */
    const first: Scene[] = [{ entityId: 'tot', chapter: 5, summary: 'Tôt.' }]
    const second: Scene[] = [{ entityId: 'tard', chapter: 500, summary: 'Tard.' }]

    const scan = await scanForResolution([first, second], 1, async (window) => ({
      refusal: false,
      answer: {
        insufficientData: false,
        citations: [{ assertionId: window[0]!.entityId, chapter: window[0]!.chapter }],
      },
      costCents: 1,
    }))

    expect(scan.resolution!.chapter).toBe(5)
    expect(scan.passes).toBe(1)
  })
})

/**
 * The half of the rule the button needed, and the script never did.
 *
 * A terminal prints to whoever ran the command; the page prints to a reader
 * sitting at a chapter, and the sweep has just read four hundred chapters past
 * them. Everything else on /mystères hides a resolution the reader has not
 * reached — this is what stops the report of their own button from being the
 * one place it leaks.
 */
describe('what the reader may be told about a resolution', () => {
  it('names the chapter once they have read it', () => {
    expect(tellableResolution(17, 59)).toBe(17)
  })

  it('names it on the very chapter they are on', () => {
    expect(tellableResolution(59, 59)).toBe(59)
  })

  it('withholds a chapter they have not reached', () => {
    // Written to the graph all the same — this is about the report, not the row.
    expect(tellableResolution(412, 59)).toBeNull()
  })
})
