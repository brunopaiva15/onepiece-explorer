import { describe, expect, it } from 'vitest'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'
import {
  buildEntityProfile,
  roleLabel,
  type ProfileFact,
} from '@/domains/knowledge/profile.ts'

/**
 * A sheet reads by what its subject is.
 *
 * These tests hold two promises. The first is editorial: a crew opens on its
 * members, a character on their family and their crew, an island on who is
 * standing on it — because « Ce que l'on sait », one list of everything in
 * chapter order, is a record and not a reading.
 *
 * The second is the one that keeps the first honest: **no fact is lost**. A
 * summary that quietly drops the relations nobody thought to file would be a
 * worse page than the list it replaces, and it would fail invisibly — the
 * reader cannot miss what they were never shown. So the coverage test below
 * enumerates every relation the ontology permits for every type and insists it
 * has somewhere to go, and the catch-all is checked to actually catch.
 */

const fact = (over: Partial<ProfileFact> & { predicate: string }): ProfileFact => ({
  assertionId: `a-${over.predicate}-${over.otherId ?? over.direction ?? 'x'}`,
  direction: 'outgoing',
  otherId: 'other',
  otherLabel: 'Autre',
  otherType: 'character',
  literalValue: null,
  epistemicStatus: 'explicit',
  knowledgeFromChapter: 1,
  knowledgeUntilChapter: null,
  locked: false,
  evidence: [],
  ...over,
})

function titles(sections: ReturnType<typeof buildEntityProfile>): string[] {
  return sections.map((s) => s.key)
}

describe('a character’s sheet', () => {
  it('leads with family, then affiliations', () => {
    const sections = buildEntityProfile('character', [
      fact({ predicate: 'member_of', otherId: 'crew', otherType: 'group' }),
      fact({ predicate: 'child_of', otherId: 'dragon' }),
    ])

    expect(titles(sections)).toEqual(['famille', 'appartenances'])
    expect(sections[0]!.entries[0]!.role).toBe('parent')
    expect(sections[1]!.entries[0]!.role).toBe('membre de')
  })

  it('shows no heading for a section it has nothing to put under', () => {
    const sections = buildEntityProfile('character', [
      fact({ predicate: 'fights', otherId: 'higuma' }),
    ])

    expect(titles(sections)).toEqual(['adversaires'])
  })

  it('files an incoming fact by what it means, not by its direction', () => {
    // « Shanks protège Luffy » belongs among Luffy's proches, and reads from
    // his side. The old page called it « ce que l'on dit d'elle » and left the
    // reader to work out which way round it went.
    const sections = buildEntityProfile('character', [
      fact({ predicate: 'protects', direction: 'incoming', otherLabel: 'Shanks' }),
    ])

    expect(titles(sections)).toEqual(['proches'])
    expect(sections[0]!.entries[0]!.role).toBe('protégé par')
  })
})

describe('a group’s sheet', () => {
  it('leads with its members, captain first', () => {
    const sections = buildEntityProfile('group', [
      fact({ predicate: 'member_of', direction: 'incoming', otherId: 'zoro', knowledgeFromChapter: 3 }),
      fact({ predicate: 'leads', direction: 'incoming', otherId: 'luffy', knowledgeFromChapter: 2 }),
    ])

    expect(titles(sections)).toEqual(['membres'])
    expect(sections[0]!.entries.map((e) => e.role)).toEqual(['chef', 'membre'])
  })

  it('orders equals by the chapter that revealed them', () => {
    const sections = buildEntityProfile('group', [
      fact({ predicate: 'member_of', direction: 'incoming', otherId: 'b', knowledgeFromChapter: 9 }),
      fact({ predicate: 'member_of', direction: 'incoming', otherId: 'a', knowledgeFromChapter: 4 }),
    ])

    expect(sections[0]!.entries.map((e) => e.knowledgeFromChapter)).toEqual([4, 9])
  })
})

describe('a place’s sheet', () => {
  it('separates who stands there from what happens there', () => {
    // Both are an incoming `located_at`; only the type at the other end says
    // whether it is a person or a battle.
    const sections = buildEntityProfile('place', [
      fact({ predicate: 'located_at', direction: 'incoming', otherId: 'luffy', otherType: 'character' }),
      fact({ predicate: 'located_at', direction: 'incoming', otherId: 'combat', otherType: 'battle' }),
    ])

    expect(titles(sections)).toEqual(['presents', 'evenements'])
  })
})

describe('a mystery’s sheet', () => {
  it('opens on what raised it', () => {
    const sections = buildEntityProfile('mystery', [
      fact({ predicate: 'hints_at', direction: 'incoming', otherId: 'case', otherType: 'event' }),
      fact({ predicate: 'opens_mystery', direction: 'incoming', otherId: 'scene', otherType: 'event' }),
    ])

    expect(titles(sections)).toEqual(['ouvert-par', 'indices'])
  })
})

describe('the same relation asserted twice', () => {
  it('is one line, dated by the chapter you could first know it', () => {
    const sections = buildEntityProfile('character', [
      fact({
        assertionId: 'a1',
        predicate: 'fights',
        otherId: 'higuma',
        knowledgeFromChapter: 5,
      }),
      fact({
        assertionId: 'a2',
        predicate: 'fights',
        otherId: 'higuma',
        knowledgeFromChapter: 2,
      }),
    ])

    const entries = sections[0]!.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.knowledgeFromChapter).toBe(2)
    expect(entries[0]!.assertionIds).toEqual(['a1', 'a2'])
  })

  it('keeps the strongest of the two statuses, and its refutation window', () => {
    // A hypothesis and an explicit statement of the same thing: the reader
    // knows it explicitly. The reverse rule would let one stray low-confidence
    // duplicate demote an established fact.
    const sections = buildEntityProfile('character', [
      fact({
        assertionId: 'a1',
        predicate: 'child_of',
        otherId: 'dragon',
        epistemicStatus: 'hypothetical',
        knowledgeUntilChapter: 60,
      }),
      fact({
        assertionId: 'a2',
        predicate: 'child_of',
        otherId: 'dragon',
        epistemicStatus: 'explicit',
      }),
    ])

    expect(sections[0]!.entries[0]!.epistemicStatus).toBe('explicit')
    expect(sections[0]!.entries[0]!.knowledgeUntilChapter).toBeNull()
  })

  it('counts the evidence of every assertion it folded in', () => {
    const sections = buildEntityProfile('character', [
      fact({ assertionId: 'a1', predicate: 'knows', otherId: 'nami', evidence: [{}] }),
      fact({ assertionId: 'a2', predicate: 'knows', otherId: 'nami', evidence: [{}, {}] }),
    ])

    expect(sections[0]!.entries[0]!.evidenceCount).toBe(3)
  })
})

describe('a symmetric relation', () => {
  it('is shown once, whichever end the graph wrote first', () => {
    // `enemy_of` is symmetric: which of the two rows became the subject is an
    // accident of extraction order, and the sheet must not report it as two
    // enmities.
    const sections = buildEntityProfile('group', [
      fact({ predicate: 'enemy_of', direction: 'outgoing', otherId: 'baggy' }),
      fact({ predicate: 'enemy_of', direction: 'incoming', otherId: 'baggy' }),
    ])

    expect(sections[0]!.entries).toHaveLength(1)
    expect(sections[0]!.entries[0]!.role).toBe('ennemi')
  })
})

describe('a predicate whose object plays two roles', () => {
  it('is phrased by the section it lands in', () => {
    // `promises` accepts both the person promised to and the thing promised.
    // « Shanks lui a promis » is right on Luffy's sheet and wrong on the hat's.
    const person = buildEntityProfile('character', [
      fact({ predicate: 'promises', direction: 'incoming', otherLabel: 'Shanks' }),
    ])
    const thing = buildEntityProfile('object', [
      fact({ predicate: 'promises', direction: 'incoming', otherLabel: 'Shanks' }),
    ])

    expect(person[0]!.entries[0]!.role).toBe('lui a promis')
    expect(thing[0]!.entries[0]!.role).toBe('promis par')
  })
})

describe('nothing is lost', () => {
  it('catches a fact no section claims', () => {
    // A user-defined predicate: the ontology is data, so this file cannot know
    // every predicate the graph may hold.
    const sections = buildEntityProfile('character', [
      fact({ predicate: 'drinks_with', otherId: 'shanks' }),
    ])

    expect(titles(sections)).toEqual(['autres'])
    expect(sections[0]!.entries[0]!.role).toBe('drinks with')
  })

  it('files every relation the ontology permits, for every type', () => {
    // The test that keeps the table honest as the ontology grows. A predicate
    // added without a home would land in « Autres faits » — visible, but the
    // section is a safety net, not a filing system.
    const story = NODE_TYPES.filter(
      (type) => !['chapter', 'page', 'panel'].includes(type.key),
    )

    const unfiled: string[] = []

    for (const type of story) {
      for (const predicate of PREDICATES) {
        const subjects = predicate.subjectTypes as readonly string[]
        const objects = predicate.objectTypes as readonly string[]

        if (subjects.includes(type.key)) {
          for (const objectType of objects) {
            const [section] = buildEntityProfile(type.key, [
              fact({ predicate: predicate.key, direction: 'outgoing', otherType: objectType }),
            ])
            if (section!.key === 'autres') {
              unfiled.push(`${type.key} → ${predicate.key} → ${objectType}`)
            }
          }
        }

        if (objects.includes(type.key)) {
          for (const subjectType of subjects) {
            const [section] = buildEntityProfile(type.key, [
              fact({ predicate: predicate.key, direction: 'incoming', otherType: subjectType }),
            ])
            if (section!.key === 'autres') {
              unfiled.push(`${type.key} ← ${predicate.key} ← ${subjectType}`)
            }
          }
        }
      }
    }

    expect(unfiled).toEqual([])
  })
})

describe('naming one end of a fact', () => {
  it('has French for both ends of every predicate we ship', () => {
    for (const predicate of PREDICATES) {
      for (const direction of ['outgoing', 'incoming'] as const) {
        const role = roleLabel(predicate.key, direction)
        expect(role).not.toBe('')
        // A key showing through would be a key in the one place nobody looks
        // twice — under a heading, next to a name.
        expect(role).not.toContain('_')
      }
    }
  })

  it('makes an unknown predicate readable rather than inventing French', () => {
    expect(roleLabel('drinks_with', 'outgoing')).toBe('drinks with')
    expect(roleLabel('drinks_with', 'incoming')).toBe('drinks with')
  })
})
