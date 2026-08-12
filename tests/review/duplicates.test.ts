import { describe, expect, it } from 'vitest'
import { duplicateKeyOf, groupDuplicates } from '@/domains/review/duplicates.ts'

/**
 * Grouping the copies one run proposes of the same thing.
 *
 * The property that matters is not "similar proposals are grouped" — it is the
 * opposite one. Two appearances the source has not identified with each other
 * must stay two proposals, because the extraction prompt asks for exactly that
 * and the whole revelation history depends on it. So these tests pin both
 * directions: the same thing twice is one group, and anything short of the same
 * thing is not.
 */

function entity(
  label: string,
  nodeType = 'character',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { label, node_type: nodeType, label_kind: 'alias', local_id: 'e1', ...extra }
}

describe('duplicateKeyOf', () => {
  it('gives two copies of one entity the same key, across accents and case', () => {
    expect(duplicateKeyOf('entity', entity('Zoro'))).toBe(
      duplicateKeyOf('entity', entity('  zoro ')),
    )
    expect(duplicateKeyOf('entity', entity('Chapeau de Paille'))).toBe(
      duplicateKeyOf('entity', entity('chapeau de paille')),
    )
  })

  it('keeps a ship and a character of the same name apart', () => {
    expect(duplicateKeyOf('entity', entity('Vogue Merry', 'character'))).not.toBe(
      duplicateKeyOf('entity', entity('Vogue Merry', 'vessel')),
    )
  })

  it('groups two copies that quote the same source wording under different labels', () => {
    /*
     * The case that made this necessary. « Red Hair Pirates » came back from
     * one slice as « Équipage des cheveux rouges » and from another as
     * « Équipage du Roux » — the same words, translated twice, which is the
     * failure the glossary exists to stop and the one a label comparison
     * cannot see.
     */
    const proposed = entity('Équipage des cheveux rouges', 'group', {
      source_term: 'Red Hair Pirates',
    })
    const translated = entity('Équipage du Roux', 'group', {
      source_term: 'Red Hair Pirates',
      label_kind: 'translation',
    })

    expect(duplicateKeyOf('entity', proposed)).toBe(duplicateKeyOf('entity', translated))
  })

  it('keeps the same wording apart when it names two kinds of thing', () => {
    // « Straw Hat » is a hat and a crew. Same quoted words, two entities.
    expect(
      duplicateKeyOf('entity', entity('Chapeau de paille', 'object', { source_term: 'Straw Hat' })),
    ).not.toBe(
      duplicateKeyOf('entity', entity('Chapeau de paille', 'group', { source_term: 'Straw Hat' })),
    )
  })

  it('falls back to the label when the source wording is the label', () => {
    // Null source_term means the model produced no French of its own — a
    // French source, or a name identical in both languages. The label is then
    // just as stable as a quote, so nothing is lost.
    expect(
      duplicateKeyOf('entity', entity('Luffy', 'character', { source_term: null })),
    ).toBe(duplicateKeyOf('entity', entity('luffy')))
  })

  it('does not group two look-alike designations', () => {
    // The prompt asks for two distinct entities when the source does not
    // establish the identity. Treating those as copies would train the reviewer
    // to dismiss the warning on the cases where it costs the most.
    expect(duplicateKeyOf('entity', entity('l’homme au foulard rayé'))).not.toBe(
      duplicateKeyOf('entity', entity('l’homme au foulard')),
    )
  })

  it('keys an assertion on its triple, not on its evidence', () => {
    const base = { subject: 'e1', predicate: 'member_of', object: 'e2', object_value: null }
    expect(duplicateKeyOf('assertion', { ...base, evidence: [{ ref: 'p1c1' }] })).toBe(
      duplicateKeyOf('assertion', { ...base, evidence: [{ ref: 'p4c2' }] }),
    )
    expect(duplicateKeyOf('assertion', base)).not.toBe(
      duplicateKeyOf('assertion', { ...base, object: 'e3' }),
    )
  })

  it('returns null rather than throwing on a payload with nothing to key on', () => {
    expect(duplicateKeyOf('entity', { label: '' })).toBeNull()
    expect(duplicateKeyOf('entity', null)).toBeNull()
    expect(duplicateKeyOf('quarantine', entity('Zoro'))).toBeNull()
  })
})

describe('groupDuplicates', () => {
  const rows = [
    { id: 'a', category: 'entity', payload: entity('Zoro'), status: 'proposed' },
    { id: 'b', category: 'entity', payload: entity('zoro'), status: 'accepted' },
    { id: 'c', category: 'entity', payload: entity('Nami'), status: 'proposed' },
    { id: 'd', category: 'entity', payload: entity('Zoro'), status: 'rejected' },
  ]

  it('reports the copies of an item, itself excluded', () => {
    const groups = groupDuplicates(rows)
    const a = groups.get('a')

    expect(a?.total).toBe(3)
    expect(a?.rank).toBe(1)
    expect(a?.others).toEqual({ pending: 0, accepted: 1, rejected: 1, deferred: 0 })
  })

  it('counts a copy accepted in an earlier batch — the one no longer in the queue', () => {
    // This is the whole point: the dangerous copy is the published one, which a
    // queue filtered to pending items cannot show.
    expect(groupDuplicates(rows).get('a')?.others.accepted).toBe(1)
  })

  it('leaves an item with no copy out of the map entirely', () => {
    expect(groupDuplicates(rows).has('c')).toBe(false)
  })

  it('ranks copies in the order they are given, so numbering matches the queue', () => {
    const groups = groupDuplicates(rows)
    expect(groups.get('b')?.rank).toBe(2)
    expect(groups.get('d')?.rank).toBe(3)
  })
})
