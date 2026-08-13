import { describe, expect, it } from 'vitest'
import {
  buildAnchorSources,
  filterExtraction,
  refileMisfiled,
  type OntologyView,
} from '@/domains/ai/anchoring.ts'
import { extractionSystem } from '@/domains/ai/prompts.ts'
import type { Extraction } from '@/domains/ai/schemas.ts'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'
import { namespaceLocalIds, renderOntology } from '@/domains/pipeline/steps/extract.ts'
// The function publication itself uses to answer « quelle sorte de scène » —
// asserted here rather than reimplemented, since that is the contract refiling
// has to hand over to.
import { occurrenceType } from '@/domains/review/publish.ts'

/**
 * A scene proposed as a character, and everything that follows from it.
 *
 * The extraction returns four lists and the ontology also carries `event` and
 * `mystery` as node *types*, because a relation has to be able to point at one.
 * Nothing said which was which — the prompt's ontology block listed the
 * predicates and never the types — so a chapter's events arrived as entities of
 * type `event`, each with a sentence for a name.
 *
 * Every check downstream agreed with them: the type is real, the evidence
 * anchors, the review card says « entité » and shows a sentence, which is
 * exactly what an event card shows. The damage is only visible two screens
 * later, where the chronology reads the `events` table and finds nothing, and
 * story mode announces six scenes as six characters walking on.
 */

const ONTOLOGY: OntologyView = {
  nodeTypes: new Set(NODE_TYPES.map((t) => t.key)),
  predicates: new Set(PREDICATES.map((p) => p.key)),
  literalObjects: new Set(),
}

const PASSAGE =
  'Buggy launches a Buggy ball that hits the Mayor’s house where Zoro was sleeping.'

const sources = buildAnchorSources({
  textBlocks: [{ ref: 'b1', text: PASSAGE }],
  descriptions: [],
  allowedRefs: ['b1'],
  tolerateNoise: false,
})

const cite = [{ ref: 'b1', kind: 'text' as const, excerpt: 'Buggy launches a Buggy ball' }]

function empty(): Extraction {
  return { entities: [], assertions: [], events: [], mysteries: [] }
}

function entity(overrides: Partial<Extraction['entities'][number]>): Extraction['entities'][number] {
  return {
    local_id: 'e1',
    node_type: 'character',
    label: 'Baggy',
    label_kind: 'alias',
    source_term: null,
    naming_confident: true,
    evidence: cite,
    confidence: 0.9,
    ...overrides,
  }
}

describe('a proposal that arrived under the wrong heading', () => {
  it('files an entity of type event as an event', () => {
    const { extraction, refiled } = refileMisfiled({
      ...empty(),
      entities: [
        entity({
          local_id: 'e7',
          node_type: 'event',
          label: 'Baggy tire un Buggy Ball sur la maison du maire.',
        }),
      ],
    })

    expect(refiled.events).toBe(1)
    expect(extraction.entities).toHaveLength(0)
    expect(extraction.events).toHaveLength(1)
    // The sentence is the summary: an event is named by what happens in it.
    expect(extraction.events[0]!.summary).toBe(
      'Baggy tire un Buggy Ball sur la maison du maire.',
    )
    // The id survives, so anything naming it still reaches it.
    expect(extraction.events[0]!.local_id).toBe('e7')
    expect(extraction.events[0]!.evidence).toEqual(cite)
  })

  it('files a combat and a voyage there too, keeping what they are', () => {
    /*
     * The hole the first version left. `battle` and `voyage` are node types in
     * the same ontology, offered in the same field, and a model that classifies
     * a scene *better* wrote one of them — so the more precise answer was the
     * one nothing caught. « Dix ans plus tard, Luffy quitte seul le Village de
     * Fuchsia pour prendre la mer » is a voyage, and it became a node with a
     * sentence for a name that later chapters could point a relation at.
     *
     * The kind travels with it: publication resolves an absent one by re-reading
     * the summary, and that reading never returns `voyage` — so dropping it here
     * would quietly demote the scene to an ordinary event.
     */
    const { extraction, refiled } = refileMisfiled({
      ...empty(),
      entities: [
        entity({
          local_id: 'e2',
          node_type: 'voyage',
          label:
            'Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour ' +
            'prendre la mer, sous le regard de Makino et des villageois.',
        }),
        entity({
          local_id: 'e3',
          node_type: 'battle',
          label: 'Zoro affronte Baggy en duel.',
        }),
      ],
    })

    expect(refiled.events).toBe(2)
    expect(extraction.entities).toHaveLength(0)
    expect(extraction.events.map((event) => event.kind)).toEqual(['voyage', 'battle'])
    expect(extraction.events.map((event) => event.local_id)).toEqual(['e2', 'e3'])
  })

  it('lets an ordinary event still be recognised as a combat', () => {
    /*
     * `event` is what publication falls back to when nobody said, and the
     * fallback re-reads the summary — which is how « affronte » and « duel »
     * are found. Stating `event` here would look like carrying the model's
     * answer over and would in fact take that reading away, so the field is
     * left empty and the scene keeps its chance to be a combat.
     */
    const { extraction } = refileMisfiled({
      ...empty(),
      entities: [
        entity({ node_type: 'event', label: 'Zoro affronte Baggy en duel.' }),
      ],
    })

    expect(extraction.events[0]!.kind).toBeUndefined()
    expect(occurrenceType(extraction.events[0]!)).toBe('battle')
  })

  it('does not claim a refiled scene is a memory', () => {
    /*
     * Nothing in an entity proposal ever said so. Guessing it from the wording
     * would put the scene at the wrong place on the story axis, which is the
     * one thing the two-axis timeline exists to get right.
     */
    const { extraction } = refileMisfiled({
      ...empty(),
      entities: [
        entity({
          node_type: 'event',
          label: 'Flashback : Shanks et Buggy se disputent.',
        }),
      ],
    })

    expect(extraction.events[0]!.is_flashback).toBe(false)
  })

  it('files an unnamed question as a mystery', () => {
    const { extraction, refiled } = refileMisfiled({
      ...empty(),
      entities: [
        entity({
          node_type: 'mystery',
          label: 'Pourquoi Nami vole-t-elle les pirates ?',
        }),
      ],
    })

    expect(refiled.mysteries).toBe(1)
    expect(extraction.entities).toHaveLength(0)
    expect(extraction.mysteries[0]!.question).toBe('Pourquoi Nami vole-t-elle les pirates ?')
  })

  it('leaves a question something points at where it is', () => {
    /*
     * A mystery carries no local id in the schema, so refiling one a relation
     * names would cut the edge in the name of tidiness. An event keeps its id
     * and has no such problem — hence the asymmetry.
     */
    const { extraction, refiled } = refileMisfiled({
      ...empty(),
      entities: [
        entity({ local_id: 'm1', node_type: 'mystery', label: 'Qui est cet homme ?' }),
      ],
      assertions: [
        {
          subject: 'aa000000-0000-4000-8000-000000000000',
          predicate: 'hints_at',
          object: 'm1',
          object_value: null,
          epistemic_status: 'explicit',
          evidence: cite,
          confidence: 0.8,
        },
      ],
    })

    expect(refiled.mysteries).toBe(0)
    expect(extraction.entities).toHaveLength(1)
    expect(extraction.mysteries).toHaveLength(0)
  })

  it('returns an ordinary extraction untouched', () => {
    const original = { ...empty(), entities: [entity({})] }
    const { extraction, refiled } = refileMisfiled(original)

    expect(extraction).toBe(original)
    expect(refiled).toEqual({ events: 0, mysteries: 0 })
  })
})

describe('an event is a node relations can reach', () => {
  it('resolves a relation naming an event proposed in the same response', () => {
    /*
     * `participates_in` takes an event, and until the event's local id joined
     * the resolvable set the relation was quarantined as `unknown_object` for
     * naming something this very response had declared. So the link between a
     * scene and the people in it could not be written by anyone.
     */
    const filtered = filterExtraction(
      {
        ...empty(),
        entities: [entity({ local_id: 'e1', label: 'Zoro' })],
        events: [
          {
            local_id: 'ev1',
            summary: 'La maison du maire est détruite.',
            participants: ['e1'],
            is_flashback: false,
            evidence: cite,
            confidence: 0.9,
          },
        ],
        assertions: [
          {
            subject: 'e1',
            predicate: 'participates_in',
            object: 'ev1',
            object_value: null,
            epistemic_status: 'explicit',
            evidence: cite,
            confidence: 0.9,
          },
        ],
      },
      sources,
      ONTOLOGY,
      new Set(),
    )

    expect(filtered.quarantined).toHaveLength(0)
    expect(filtered.accepted.assertions).toHaveLength(1)
    expect(filtered.accepted.events[0]!.participants).toEqual(['e1'])
  })

  it('still drops a participant nothing anchored', () => {
    const filtered = filterExtraction(
      {
        ...empty(),
        events: [
          {
            local_id: 'ev1',
            summary: 'Une maison est détruite.',
            participants: ['e9'],
            is_flashback: false,
            evidence: cite,
            confidence: 0.9,
          },
        ],
      },
      sources,
      ONTOLOGY,
      new Set(),
    )

    expect(filtered.accepted.events[0]!.participants).toEqual([])
  })
})

describe('participants across the slices of one run', () => {
  it('scopes them like any other reference to a proposal', () => {
    /*
     * Left alone, `e1` in a participant list matched no entity once every
     * entity had become `<clé>:e1` — so an event published from the second
     * slice of a chapter knew nobody. It is the same identifier as a relation's
     * two ends and it takes the same prefix.
     */
    const scoped = namespaceLocalIds(
      {
        ...empty(),
        entities: [entity({ local_id: 'e1', label: 'Nami' })],
        events: [
          {
            local_id: 'ev1',
            summary: 'Nami accepte d’aider Luffy.',
            participants: ['e1', 'aa000000-0000-4000-8000-000000000000'],
            is_flashback: false,
            evidence: cite,
            confidence: 0.9,
          },
        ],
      },
      'bbbb2222',
    )

    expect(scoped.events[0]!.participants).toEqual([
      'bbbb2222:e1',
      // A uuid is an entity already in the graph; prefixing it would turn a
      // valid reference into a dangling one.
      'aa000000-0000-4000-8000-000000000000',
    ])
  })
})

describe('what the model is told the ontology contains', () => {
  it('names the node types, not only the predicates', () => {
    const rendered = renderOntology(
      NODE_TYPES.map((t) => ({
        key: t.key,
        labelFr: t.labelFr,
        description: t.description,
      })),
      PREDICATES.map((p) => ({
        key: p.key,
        labelFr: p.labelFr,
        subjectTypes: [...p.subjectTypes],
        objectTypes: [...p.objectTypes],
        description: p.description,
      })),
    )

    expect(rendered).toContain('character (Personnage)')
    expect(rendered).toContain('event (Événement)')
    expect(rendered).toContain('appears_in (apparaît dans)')
  })

  it('says which list a scene and a question go in', () => {
    const system = extractionSystem('…', 'summary')

    expect(system).toContain('« events »')
    expect(system).toContain('« mysteries »')
    expect(system).toContain('jamais dans « entities »')
  })
})
