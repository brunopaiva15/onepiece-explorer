import { describe, expect, it } from 'vitest'
import {
  PROMPT_VERSION,
  extractionSystem,
  knownEntitiesList,
} from '@/domains/ai/prompts.ts'

/**
 * The list of validated entities, and the sentence it was missing.
 *
 * The header used to read « utilisez leur identifiant tel quel » and stop
 * there, which is an instruction to pick from the list. At chapter 41 the model
 * needed a group for the crew Luffy had just claimed to captain, had no node
 * for it — the story does not name that crew for another fifty chapters — and
 * picked the nearest one on offer: « Équipage du Capitaine Usopp ». The result
 * passed every mechanical check the pipeline has, because the predicate takes a
 * group and the object was a group.
 *
 * Prompts are advisory and these assertions are correspondingly modest: they
 * pin that both halves of the rule are stated, and that the version moves when
 * the wording does. What actually stops the bad edge reaching a reader is the
 * ontology trigger, the anchoring check and the review queue — none of which
 * had anything to say here, which is exactly why the wording had to change.
 */

const ENTITIES = [
  { id: 'a1', label: 'Monkey D. Luffy', nodeType: 'character' },
  { id: 'a2', label: 'Équipage du Capitaine Usopp', nodeType: 'group' },
]

describe('the entities the model is shown', () => {
  it('lists each one with its id, type and label', () => {
    const rendered = knownEntitiesList(ENTITIES)
    expect(rendered).toContain('a1 · character · « Monkey D. Luffy »')
    expect(rendered).toContain('a2 · group · « Équipage du Capitaine Usopp »')
  })

  it('says the list is not a menu of allowed answers', () => {
    const rendered = knownEntitiesList(ENTITIES)
    // Both halves, because either one alone is the bug: "reuse the id" without
    // "declare what is missing" is what aimed a relation at the nearest crew.
    expect(rendered).toMatch(/reprenez l’identifiant/i)
    expect(rendered).toMatch(/se déclare dans « entities »/i)
  })

  it('says so plainly when the graph is still empty', () => {
    expect(knownEntitiesList([])).toBe('Aucune entité déjà validée à ce stade.')
  })
})

describe('the extraction prompt', () => {
  it('tells the model to declare a group nobody has named yet', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')
    expect(prompt).toContain('JAMAIS LA PLUS PROCHE')
    expect(prompt).toMatch(/placeholder/)
  })

  /*
   * The mysteries of earlier chapters were in the list of validated entities
   * from the day it was written, and « résout le mystère » was in the ontology
   * from the day *it* was written — but nothing ever said that closing one was
   * part of reading a chapter. Seventy-one questions stood open across
   * fifty-nine chapters, including ones the next chapter answered on the page.
   */
  it('asks the chapter to close the questions it answers', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')
    expect(prompt).toContain('resolves_mystery')
    expect(prompt).toMatch(/SE REFERMENT ICI/)
    // And the other half, without which the instruction is an invitation to
    // close a question on a scene that merely approaches its answer.
    expect(prompt).toMatch(/Répondre n'est pas approcher/)
  })

  it('carries a version that moved with the wording', () => {
    // Stored on every assertion the model proposes. Without a bump, a run
    // before this change and a run after it are indistinguishable in the record.
    expect(PROMPT_VERSION).toBe('8')
  })
})
