import { describe, expect, it } from 'vitest'
import {
  MAX_SCENES_PER_QUESTION,
  resolvingScene,
  scenesFor,
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

describe('choosing the scenes a question is weighed against', () => {
  it('reads them in order and says what it left out', () => {
    const many: Scene[] = Array.from({ length: MAX_SCENES_PER_QUESTION + 25 }, (_, index) => ({
      entityId: `sc-${index}`,
      chapter: index + 1,
      summary: `Scène ${index}`,
    }))

    const { offered, dropped } = scenesFor([...many].reverse())

    expect(offered).toHaveLength(MAX_SCENES_PER_QUESTION)
    expect(offered[0]!.chapter).toBe(1)
    // Earliest first: an answer usually comes soon after the question, and a
    // sweep reading the end of the story first would date resolutions late.
    expect(offered.at(-1)!.chapter).toBe(MAX_SCENES_PER_QUESTION)
    expect(dropped).toBe(25)
  })
})
