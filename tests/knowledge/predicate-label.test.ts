import { describe, expect, it } from 'vitest'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'
import { nodeTypeLabel, predicateLabel } from '@/domains/knowledge/predicate-label.ts'

/**
 * The graph is read in French, including its verbs.
 *
 * Every predicate has carried a `labelFr` since the ontology was written — it is
 * what the extraction prompt hands the model, which is how « part de » comes
 * back as `travels_from`. The interface then printed the key: « 1 promises →
 * Roi des Pirates », in a product whose every label was authored in French so
 * that nothing would have to be translated in the reader's head.
 */

describe('naming a predicate', () => {
  it('uses the ontology’s own French', () => {
    expect(predicateLabel('promises')).toBe('promet')
    expect(predicateLabel('protects')).toBe('protège')
    expect(predicateLabel('travels_from')).toBe('part de')
    expect(predicateLabel('speaks_to')).toBe('parle à')
  })

  it('has one for every predicate we ship', () => {
    // The check that keeps this honest as the ontology grows: a predicate added
    // without a French label would surface as a key in the interface, and the
    // interface is where nobody would notice it was a key.
    for (const predicate of PREDICATES) {
      expect(predicateLabel(predicate.key)).toBe(predicate.labelFr)
      expect(predicateLabel(predicate.key)).not.toBe(predicate.key)
    }
  })

  it('makes an unknown key readable rather than inventing French for it', () => {
    // A user-defined predicate, which lives in the database and not here.
    // Showing it plainly is honest; translating it would put a phrase nobody
    // wrote into the graph.
    expect(predicateLabel('drinks_with')).toBe('drinks with')
  })
})

describe('naming a node type', () => {
  it('uses the ontology’s own French, for every type we ship', () => {
    for (const type of NODE_TYPES) {
      expect(nodeTypeLabel(type.key)).toBe(type.labelFr)
    }
  })
})
