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

  /**
   * The candidates for a revelation, where the model can find them.
   *
   * Asking for `same_as` when a chapter reveals who a figure was is worth
   * nothing if the figure is one line among a thousand named characters — and
   * unlike a name, a description is rescued by nothing downstream: the
   * exact-twin check at publication matches labels, and the resolution step
   * blocks on trigram similarity. So they come first, under a heading that says
   * what they are for.
   */
  it('puts the still-unnamed first, under their own heading', () => {
    const rendered = knownEntitiesList([
      { id: 'b1', label: 'Monkey D. Luffy', nodeType: 'character', group: 'other' },
      { id: 'b2', label: 'Silhouette au sommet', nodeType: 'character', group: 'unnamed' },
      { id: 'b3', label: 'Qui a brûlé Ohara ?', nodeType: 'mystery', group: 'question' },
    ])

    expect(rendered).toMatch(/ENCORE SANS NOM/)
    expect(rendered).toMatch(/same_as/)
    expect(rendered).toMatch(/QUESTIONS ENCORE OUVERTES/)

    // Order, not just presence: the group exists so the candidate is read before
    // the cast, and a heading below a thousand lines is a heading nobody reaches.
    expect(rendered.indexOf('Silhouette au sommet')).toBeLessThan(
      rendered.indexOf('Monkey D. Luffy'),
    )
  })

  /**
   * A cut list says it was cut.
   *
   * The projection refuses to truncate the graph in silence for the same reason:
   * a list quietly missing most of the cast looks exactly like a complete one.
   * Here the wrong inference is specific and costly — « absent from the list »
   * read as « does not exist » aims a relation at the nearest line there is.
   */
  it('says how many of how many when it shows a subset', () => {
    const rendered = knownEntitiesList(ENTITIES, 900)
    expect(rendered).toMatch(/tronquée/)
    expect(rendered).toMatch(/2 lignes sur 900/)
    expect(rendered).toMatch(/n’est donc pas une chose qui n’existe pas/)
  })

  it('says nothing about truncation when nothing was cut', () => {
    const rendered = knownEntitiesList(ENTITIES, ENTITIES.length)
    expect(rendered).not.toMatch(/tronquée/)
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

  /*
   * And says which end is which.
   *
   * Told that the open questions sit in the validated entity list and asked
   * which of them this chapter closes, the model pointed the relation from the
   * question to the question — « Qui a fait exploser le rhum de Dorry ? —
   * résout le mystère — Qui a fait exploser le rhum de Dorry ? » — and the
   * ontology, written with `ANY_ENTITY` for that subject, agreed. Accepting it
   * closed the question for ever, on nothing.
   */
  it('says that the subject of a resolution is what answers, never the question', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')
    expect(prompt).toMatch(/Le sujet est ce qui répond, jamais la question/)
    expect(prompt).toMatch(/ne se résout pas\s+elle-même/)
  })

  /*
   * `events.story_time` was in the schema from the first migration and no field
   * ever asked for it, so it was null in every library and the chronology
   * reported — accurately — that nothing had a position in story time.
   *
   * Asking is the easy half. A model asked when Ohara burned knows, and would
   * answer from memory, which is the one failure ADR 0003 exists to prevent. So
   * the prompt demands the chapter's own sentence, and says out loud that a
   * refused date costs the date and not the scene — an instruction that only
   * threatened the whole proposal would make the model hedge and date nothing.
   */
  it('asks when a scene happens, and demands the chapter’s own words for it', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')
    expect(prompt).toContain('story_time')
    expect(prompt).toMatch(/QUAND LA SCÈNE SE PASSE-T-ELLE/)
    expect(prompt).toMatch(/recopiée mot pour mot/)
    expect(prompt).toMatch(/la scène est publiée sans date/)
    // And the refusal to compute: « il y a longtemps » is not a number.
    expect(prompt).toMatch(/Ne convertissez pas, ne calculez pas/)
  })

  /**
   * The punctuation rule, and why a prompt has one at all.
   *
   * Everything the model writes rather than quotes is prose this site displays:
   * an event's summary, a mystery's question, an entity's label. It came back
   * using « — » as an aside two sentences out of three, which is the most
   * recognisable tell there is of text nobody wrote, on a site whose whole
   * register is a hand-drawn one. The excerpt is carved out by name because it
   * is a citation, checked character by character against the chapter.
   */
  it('keeps the em dash out of the French it writes, and out of nothing else', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')
    expect(prompt).toMatch(/Pas de tiret cadratin/)
    expect(prompt).toMatch(/ne touche pas le champ « excerpt »/)
  })

  it('carries a version that moved with the wording', () => {
    // Stored on every assertion the model proposes. Without a bump, a run
    // before this change and a run after it are indistinguishable in the record.
    expect(PROMPT_VERSION).toBe('14')
  })

  /**
   * « Kaloo blesse », and nothing after the verb.
   *
   * '5' ruled the sentence out of the object slot and left the empty slot
   * standing: both object fields null passed every check downstream and reached
   * the reviewer as a card that could not be accepted. The rule is enforced in
   * three places now; this is the one that stops it being written at all.
   */
  it('says that a relation always has an object, and where the fact goes when it has none', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')

    expect(prompt).toMatch(/toujours un objet/)
    expect(prompt).toMatch(/« events »/)
  })

  /**
   * Ask for the identity, and not only for the prudence.
   *
   * The prompt said twice to be careful — an identity needs direct proof, two
   * lookalikes are two entities — and never once said to do the thing. So the
   * model never did: « Homme mystérieux debout sur l'eau » and Wapol entered the
   * same chapter as two nodes and stayed two for the rest of the work, and
   * nothing downstream could join them, because the resolution step blocks on
   * trigram similarity between labels and a description resembles no name.
   *
   * Pinned here because the two halves have to travel together. Keeping only the
   * prudence is the bug this fixed; keeping only the instruction would invite
   * the merge the whole product exists to refuse.
   */
  it('asks for the identity when the chapter is the one that reveals it', () => {
    const prompt = extractionSystem('(ontologie)', 'summary')

    // The instruction, and the predicate it must name.
    expect(prompt).toMatch(/QUAND CE CHAPITRE EST CELUI QUI LA RÉVÈLE/)
    expect(prompt).toMatch(/same_as/)
    // What it costs to stay silent, so the rule has a reason and not just a tone.
    // `\s+` rather than a space: the prompt is a wrapped template literal, and
    // a sentence worth pinning is longer than one of its lines.
    expect(prompt).toMatch(/garde deux nœuds\s+pour une personne/)
    // And the prudence it does not replace.
    expect(prompt).toMatch(/créez DEUX entités distinctes/)
    expect(prompt).toMatch(/maybe_same_as/)
  })
})
