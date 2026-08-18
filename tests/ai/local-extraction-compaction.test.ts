import { describe, expect, it } from 'vitest'
import { compactLocalExtraction } from '@/domains/ai/local-extraction.ts'
import type { Extraction } from '@/domains/ai/schemas.ts'

const evidence = [{ ref: 'b1', kind: 'text' as const, excerpt: 'Luffy is carried out.' }]

function entity(local_id: string, label: string, node_type = 'character') {
  return {
    local_id,
    node_type,
    label,
    label_kind: 'true_name' as const,
    source_term: null,
    naming_confident: true,
    presence: 'appearance' as const,
    evidence,
    confidence: 0.95,
  }
}

describe('local extraction compaction', () => {
  it('reuses exact known and previous-slice entities instead of reviewing them again', () => {
    const extraction: Extraction = {
      entities: [entity('new-luffy', 'Luffy'), entity('new-hina', 'Hina')],
      assertions: [
        {
          subject: 'new-luffy',
          predicate: 'meets',
          object: 'new-hina',
          object_value: null,
          epistemic_status: 'explicit',
          evidence,
          confidence: 0.9,
        },
      ],
      events: [
        {
          local_id: 'event-1',
          summary: 'Luffy rencontre Hina.',
          participants: ['new-luffy', 'new-hina'],
          is_flashback: false,
          evidence,
          confidence: 0.9,
        },
      ],
      mysteries: [],
    }

    const result = compactLocalExtraction(extraction, {
      knownEntities: [{ id: 'known-luffy', label: 'Luffy', nodeType: 'character' }],
      proposedSoFar: [{ id: 'previous-hina', label: 'Hina', nodeType: 'character' }],
    })

    expect(result.value.entities).toEqual([])
    expect(result.value.assertions[0]).toMatchObject({
      subject: 'known-luffy',
      object: 'previous-hina',
    })
    expect(result.value.events[0]?.participants).toEqual(['known-luffy', 'previous-hina'])
    expect(result.stats.reusedEntities).toBe(2)
  })

  it('deduplicates exact entity identities and rewrites their references', () => {
    const extraction: Extraction = {
      entities: [entity('c1', 'Cobra'), entity('c2', 'Cobra')],
      assertions: [
        {
          subject: 'c2',
          predicate: 'leads',
          object: 'army',
          object_value: null,
          epistemic_status: 'explicit',
          evidence,
          confidence: 0.9,
        },
      ],
      events: [],
      mysteries: [],
    }

    const result = compactLocalExtraction(extraction, { knownEntities: [] })

    expect(result.value.entities.map((candidate) => candidate.local_id)).toEqual(['c1'])
    expect(result.value.assertions[0]?.subject).toBe('c1')
    expect(result.stats.duplicateEntities).toBe(1)
  })

  it('removes duplicate relations, same-proof event paraphrases and repeated mysteries', () => {
    const extraction: Extraction = {
      entities: [],
      assertions: [
        {
          subject: 'luffy',
          predicate: 'member_of',
          object: 'crew',
          object_value: null,
          epistemic_status: 'explicit',
          evidence,
          confidence: 0.95,
        },
        {
          subject: 'luffy',
          predicate: 'member_of',
          object: 'crew',
          object_value: null,
          epistemic_status: 'explicit',
          evidence: [{ ...evidence[0]!, excerpt: 'Luffy is carried out.' }],
          confidence: 0.91,
        },
      ],
      events: [
        {
          local_id: 'ev1',
          summary: 'Mr 2 tente de s’échapper.',
          participants: ['mr2'],
          is_flashback: false,
          evidence,
          confidence: 0.95,
        },
        {
          local_id: 'ev2',
          summary: 'Tentative d’évasion de Mr 2.',
          participants: ['mr2'],
          is_flashback: false,
          evidence,
          confidence: 0.93,
        },
      ],
      mysteries: [
        {
          question: 'Mr 2 parviendra-t-il à s’échapper ?',
          evidence,
          confidence: 0.9,
        },
        {
          question: 'Mr 2 parviendra-t-il à s’échapper ?',
          evidence,
          confidence: 0.88,
        },
      ],
    }

    const result = compactLocalExtraction(extraction, { knownEntities: [] })

    expect(result.value.assertions).toHaveLength(1)
    expect(result.value.events).toHaveLength(1)
    expect(result.value.mysteries).toHaveLength(1)
    expect(result.stats).toMatchObject({
      duplicateAssertions: 1,
      duplicateEvents: 1,
      duplicateMysteries: 1,
    })
  })
})
