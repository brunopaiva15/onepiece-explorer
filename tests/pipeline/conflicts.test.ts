import { describe, expect, it } from 'vitest'
import type { CandidateAssertion } from '@/domains/ai/schemas.ts'
import { detectConflict } from '@/domains/pipeline/steps/conflicts.ts'

/**
 * Which accepted belief a proposal actually collides with.
 *
 * The step itself is a database round trip; this is the decision inside it, and
 * the decision is where the review queue is won or lost. A detector that flags
 * one belief too many does not cost one card — the caller runs it against every
 * accepted assertion in the world, so being too broad is multiplied by the
 * whole graph before the reader sees it.
 */

function proposal(fields: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    subject: 'zoro',
    predicate: 'refutes',
    object: null,
    object_value: null,
    epistemic_status: 'explicit',
    evidence: [
      {
        ref: 'block:7',
        kind: 'text',
        excerpt:
          'Zoro states that he will not join a pirate crew and become a criminal.',
      },
    ],
    confidence: 0.9,
    ...fields,
  }
}

function accepted(fields: {
  subject?: string
  predicate: string
  object?: string | null
  objectValue?: unknown
}) {
  return {
    subject: fields.subject ?? 'zoro',
    predicate: fields.predicate,
    object: fields.object ?? null,
    objectValue: fields.objectValue ?? null,
  }
}

const LABELS = { subject: 'Roronoa Zoro', object: 'Équipage du Chapeau de Paille', since: 2, now: 3 }

describe('a refutation', () => {
  /*
   * The regression, in the shape the reader met it: chapter 3 proposed that
   * Zoro refutes one thing, and the review centre asked the same question seven
   * times — once per accepted assertion that happened to be about Zoro, each
   * card word for word identical because the sentence knew only the subject and
   * a chapter number.
   */
  it('does not fan out across everything known about its subject', () => {
    const world = [
      accepted({ predicate: 'member_of', object: 'crew' }),
      accepted({ predicate: 'fights', object: 'helmeppo' }),
      accepted({ predicate: 'speaks_to', object: 'luffy' }),
      accepted({ predicate: 'protects', object: 'rika' }),
      accepted({ predicate: 'seeks', object: 'dream' }),
      accepted({ predicate: 'captures', object: 'morgan' }),
      accepted({ predicate: 'travels_to', object: 'shells_town' }),
    ]

    const candidate = proposal({ predicate: 'refutes', object: 'crew' })
    const flagged = world.filter((existing) => detectConflict(candidate, existing) !== null)

    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.predicate).toBe('member_of')
  })

  it('names both ends, so two surviving cards cannot read alike', () => {
    const existing = accepted({ predicate: 'member_of', object: 'crew' })
    const conflict = detectConflict(proposal({ object: 'crew' }), existing)

    expect(conflict?.kind).toBe('explicit_refutation')
    expect(conflict?.explain(LABELS)).toContain('Roronoa Zoro')
    expect(conflict?.explain(LABELS)).toContain('Équipage du Chapeau de Paille')
    expect(conflict?.explain(LABELS)).toContain('member_of')
  })

  it('finds its target whichever way the accepted belief was stored', () => {
    // `contradicts` is symmetric in the ontology, and even a directed `refutes`
    // has no say in how the belief it contests was written down.
    const reversed = accepted({ subject: 'crew', predicate: 'member_of', object: 'zoro' })

    expect(detectConflict(proposal({ object: 'crew' }), reversed)).not.toBeNull()
    expect(
      detectConflict(proposal({ predicate: 'contradicts', object: 'crew' }), reversed),
    ).not.toBeNull()
  })

  it('raises nothing when it points at a literal rather than an entity', () => {
    // Nothing identifiable to contest. The proposal is not lost: `refutes` is
    // flagged requiresExplicitReview, so it reaches the queue on its own card.
    const candidate = proposal({ object: null, object_value: 'ne rejoindra aucun équipage' })

    expect(detectConflict(candidate, accepted({ predicate: 'member_of', object: 'crew' }))).toBeNull()
  })
})

describe('the two other shapes', () => {
  // They match on the subject, and the refutation branch now returns before
  // that check — this is the guard that it returns *only* for refutations.
  it('still flags a character acting after their death', () => {
    const conflict = detectConflict(
      proposal({ predicate: 'fights', object: 'helmeppo' }),
      accepted({ predicate: 'dies_at', objectValue: 'shells_town' }),
    )

    expect(conflict?.kind).toBe('death_after_action')
    expect(conflict?.explain(LABELS)).toContain('Roronoa Zoro')
  })

  it('still flags a second answer to a single-valued predicate', () => {
    const conflict = detectConflict(
      proposal({ predicate: 'dies_at', object: null, object_value: 'loguetown' }),
      accepted({ predicate: 'dies_at', objectValue: 'shells_town' }),
    )

    expect(conflict?.kind).toBe('same_predicate_different_object')
  })

  it('says nothing about a predicate that legitimately holds twice', () => {
    const conflict = detectConflict(
      proposal({ predicate: 'member_of', object: 'crew' }),
      accepted({ predicate: 'member_of', object: 'bounty_hunters' }),
    )

    expect(conflict).toBeNull()
  })
})
