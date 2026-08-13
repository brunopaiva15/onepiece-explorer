import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BATTLE_WORDS,
  battlePattern,
  classifyOccurrence,
} from '@/domains/knowledge/occurrence.ts'
import { OCCURRENCE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'

/**
 * Reading a fight back out of a summary written before anyone asked.
 *
 * The fixtures here are real: they are the summaries a ten-chapter library
 * actually holds, the ones whose « Combat » filter came back empty. Made-up
 * sentences would prove that the regex matches the regex.
 */

const COMBATS = [
  'Zoro affronte Baggy en duel et le découpe en morceaux, sous les regards choqués de Luffy et Nami, tandis que l’équipage de Baggy se contente de rire.',
  'Après avoir vaincu Morgan, Zoro s’effondre d’épuisement pendant que les Marines célèbrent leur libération.',
  'Alvida détruit le bateau de Koby et s’en prend à lui ; Luffy protège Koby et met Alvida hors de combat d’un coup de Gomu Gomu no Pistol.',
  'Beckman neutralise seul la bande de Higuma.',
  'Zoro sauve trois naufragés de l’équipage de Baggy qui tentaient de lui voler son bateau, et les bat après leur avoir révélé qui il est.',
  'Luffy assomme les Marines dont les épées sont bloquées contre celles de Zoro, tandis que Morgan menace ses propres hommes et que Luffy le défie ouvertement.',
  'La jeune fille prétend que Luffy est son chef pour fuir les pirates ; Luffy les bat après qu’ils ont touché son chapeau, puis elle se présente comme Nami.',
]

/**
 * Scenes that must stay ordinary events.
 *
 * Each one is a false positive the word list was narrowed to avoid, and the
 * narrowing is the whole design: a combat missed reads as what it read
 * yesterday, a quiet scene promoted to « Combat » is a wrong claim about the
 * story drawn in red on the graph.
 */
const NOT_COMBATS = [
  'Shanks sauve Luffy du Seigneur de la Côte et perd son bras gauche.',
  'Hermep, furieux d’avoir été frappé par Luffy, est emmené par des soldats en jurant que Luffy mourra ; Rika défend Luffy et Zoro devant sa mère.',
  'Rika révèle que Zoro a été arrêté pour avoir tué le loup de Hermep alors qu’il la protégeait.',
  'Luffy prend la mer seul à bord d’une petite embarcation pour former son équipage et rencontre un tourbillon.',
  'Zoro et Luffy, perdus en mer et affamés faute de navigation, discutent de leur situation ; Zoro révèle qu’il cherchait un homme avant de devenir chasseur de primes.',
  'Nami révèle son projet d’amasser 100 000 000 pour acheter un village en dépouillant les pirates du Grand Line grâce à la carte volée.',
  'Luffy raconte à Nami l’histoire de son chapeau ; elle accepte de l’aider s’il l’accompagne voir Baggy, puis le ligote en chemin.',
  'Gold Roger est exécuté publiquement après avoir révélé l’existence de son trésor caché, marquant le début de la Grande Ère de la Piraterie.',
]

describe('a scene that nobody classified', () => {
  it.each(COMBATS)('is read as a combat: %s', (summary) => {
    expect(classifyOccurrence(summary)).toBe('battle')
  })

  it.each(NOT_COMBATS)('stays an ordinary event: %s', (summary) => {
    expect(classifyOccurrence(summary)).toBe('event')
  })

  /*
   * The boundary that carries the whole list.
   *
   * « bat » without one matches « bateau », and this is a work of pirates: half
   * the library would have been filed under Combat by a pattern that looked
   * exactly as reasonable as this one.
   */
  it('does not find a fight inside a longer word', () => {
    expect(classifyOccurrence('Zoro rame pour suivre le bateau de Luffy.')).toBe('event')
    expect(classifyOccurrence('Le débat sur la prime tourne court.')).toBe('event')
  })

  it('reads accented forms as the same word', () => {
    expect(classifyOccurrence('Nami est attaquée par les pirates de Baggy.')).toBe('battle')
    expect(classifyOccurrence('Luffy a affronté le capitaine.')).toBe('battle')
  })

  /*
   * A departure is never guessed. « prend la mer », « quitte », « arrive »
   * describe this work's setting as often as they describe a scene, so there is
   * no prudent list to write — and a bad one would file half the library as a
   * voyage. New chapters get voyages because the model is asked for one.
   */
  it('never guesses a voyage', () => {
    for (const summary of [...COMBATS, ...NOT_COMBATS]) {
      expect(classifyOccurrence(summary)).not.toBe('voyage')
    }
  })
})

/**
 * The two readers of one word list.
 *
 * `classifyOccurrence` applies it to proposals published from now on; migration
 * 0022 applies it to what is already in the graph, in SQL, because no
 * TypeScript runs during a migration. Two copies of a regex is two things to
 * keep in step and one that will silently stop being kept — so the copy is
 * asserted rather than trusted.
 */
describe('the migration and the code', () => {
  it('match on exactly the same words', async () => {
    const sql = await readFile(
      path.join(process.cwd(), 'drizzle', '0022_combats_have_a_type.sql'),
      'utf8',
    )

    // Just the alternation: everything the migration concatenates between the
    // opening `\y(` and the closing `)\y`, minus the separators.
    const between = sql.slice(
      sql.indexOf("'\\y(' ||") + "'\\y(' ||".length,
      sql.indexOf("')\\y')"),
    )
    const fromSql = [...between.matchAll(/'([^']+)'/g)]
      .map((match) => match[1]!)
      .filter((word) => word !== '|')

    expect(fromSql).toEqual([...BATTLE_WORDS])
    expect(battlePattern()).toBe(`(${fromSql.join('|')})`)
  })

  it('folds the same accents on both sides', async () => {
    const sql = await readFile(
      path.join(process.cwd(), 'drizzle', '0022_combats_have_a_type.sql'),
      'utf8',
    )
    expect(sql).toContain("'àâäéèêëîïôöùûüç'")
    expect(sql).toContain("'aaaeeeeiioouuuc'")
  })

  /*
   * Promoting an event to a battle must not invalidate anything already
   * written about it. The type-check trigger fires on an assertion's insert,
   * never on an entity's update, so a reclassification that narrowed what the
   * ontology accepts would leave broken edges behind in silence — no error, no
   * trace, just a graph that would refuse to rebuild itself.
   *
   * Stated as an implication rather than an equivalence, because the three are
   * not symmetric and should not be: `travels_from` and `travels_to` take a
   * `voyage` and nothing else, which is the one thing a voyage is for. What
   * has to hold is the other direction — anywhere an `event` fits, a `battle`
   * and a `voyage` fit too — so classifying a scene more precisely can only
   * ever widen what may be said about it.
   */
  it('never narrows what can be said about a scene by classifying it', () => {
    for (const predicate of PREDICATES) {
      for (const list of [
        predicate.subjectTypes as readonly string[],
        predicate.objectTypes as readonly string[],
      ]) {
        if (!list.includes('event')) continue
        for (const type of OCCURRENCE_TYPES) {
          expect(
            list,
            `« ${predicate.key} » accepte un event mais pas un ${type}`,
          ).toContain(type)
        }
      }
    }
  })
})
