import { describe, expect, it } from 'vitest'
import {
  auditStorySnapshot,
  type AuditEntity,
  type AuditLabel,
  type AuditSnapshot,
} from '@/domains/review/audit.ts'

/**
 * Les identités qu'aucune œuvre ne peut produire, et que le graphe porte.
 *
 * `identitiesWithAMember` demandait qu'une appartenance existe déjà à côté, ce
 * qui la rendait sûre et rare : la bibliothèque porte « Sham member_of Nyaban
 * Brothers » une fois sur cinq, et les quatre autres passaient. Ces règles-ci
 * lisent les deux types, que la publication a validés contre l'ontologie, et
 * n'ont besoin de rien d'autre.
 *
 * Les exemples viennent de défauts relevés en lisant le Mode histoire de la
 * bibliothèque de référence. Ils sont ici des **données**, et rien de ce que
 * les règles savent ne les nomme : la même règle, sur une autre œuvre, trouvera
 * ses propres duos confondus avec leur moitié.
 */

const EMPTY: AuditSnapshot = {
  entities: [],
  identities: [],
  memberships: [],
  events: [],
  firstWritten: new Map(),
  mysteries: [],
  resolutions: [],
  provenance: [],
}

function label(input: Partial<AuditLabel> & { id: string; label: string }): AuditLabel {
  return {
    normalized: input.label.toLowerCase(),
    kind: 'true_name',
    revealedInChapter: 1,
    precedence: 100,
    ...input,
  }
}

function entity(input: Partial<AuditEntity> & { id: string; name: string }): AuditEntity {
  return {
    nodeType: 'character',
    firstSeenChapter: 1,
    labels: [label({ id: `l-${input.id}`, label: input.name })],
    ...input,
  }
}

function identity(input: {
  id?: string
  subject: string
  object: string
  chapter?: number
}): AuditSnapshot['identities'][number] {
  return {
    assertionId: input.id ?? `a-${input.subject}-${input.object}`,
    subjectEntityId: input.subject,
    objectEntityId: input.object,
    knowledgeFromChapter: input.chapter ?? 1,
  }
}

describe('une question donnée pour quelqu’un', () => {
  /*
   * « Une voix inconnue » et Koza, à Alabasta. La question est un nœud, la
   * personne en est un autre, et ce que le chapitre écrit entre les deux est
   * une réponse — « résout le mystère », de la scène vers la question — jamais
   * une identité. Fusionnés, la question disparaît du fil et le lecteur perd
   * la réponse avec elle.
   */
  const snapshot: AuditSnapshot = {
    ...EMPTY,
    entities: [
      entity({
        id: 'voix',
        name: 'Qui est la voix que Vivi a entendue ?',
        nodeType: 'mystery',
        firstSeenChapter: 190,
        labels: [
          label({
            id: 'l-voix',
            label: 'Qui est la voix que Vivi a entendue ?',
            kind: 'alias',
            revealedInChapter: 190,
          }),
        ],
      }),
      entity({ id: 'koza', name: 'Koza', firstSeenChapter: 190 }),
    ],
    identities: [identity({ id: 'a-voix', subject: 'voix', object: 'koza', chapter: 197 })],
  }

  it('la refuse, et propose de retirer la relation', () => {
    const found = auditStorySnapshot(snapshot).filter(
      (finding) => finding.kind === 'identite_avec_un_mystere',
    )

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-voix' })
    expect(found[0]?.detail).toContain('résout le mystère')
  })

  it('ne dit rien de deux questions rapprochées : ce n’est pas ce défaut', () => {
    const found = auditStorySnapshot({
      ...snapshot,
      entities: snapshot.entities.map((node) =>
        node.id === 'koza' ? { ...node, nodeType: 'mystery' } : node,
      ),
    }).filter((finding) => finding.kind === 'identite_avec_un_mystere')

    expect(found).toEqual([])
  })
})

describe('un groupe donné pour l’un de ses membres', () => {
  /*
   * « Nyaban Brothers » et Sham. Le duo est Buchi *et* Sham, et l'identité fait
   * disparaître le duo derrière la moitié de lui-même. Aucune appartenance
   * n'est écrite à côté — c'est précisément le cas que l'ancienne règle
   * laissait passer.
   */
  const snapshot: AuditSnapshot = {
    ...EMPTY,
    entities: [
      entity({
        id: 'nyaban',
        name: 'Nyaban Brothers',
        nodeType: 'group',
        firstSeenChapter: 31,
        labels: [label({ id: 'l-nyaban', label: 'Nyaban Brothers', revealedInChapter: 31 })],
      }),
      entity({
        id: 'sham',
        name: 'Sham',
        firstSeenChapter: 31,
        labels: [label({ id: 'l-sham', label: 'Sham', revealedInChapter: 31 })],
      }),
    ],
    identities: [identity({ id: 'a-nyaban', subject: 'nyaban', object: 'sham', chapter: 31 })],
  }

  it('la refuse sans avoir besoin d’une appartenance écrite à côté', () => {
    const found = auditStorySnapshot(snapshot).filter(
      (finding) => finding.kind === 'identite_de_types_incompatibles',
    )

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-nyaban' })
  })

  it('laisse la règle voisine parler seule quand l’appartenance est écrite', () => {
    const findings = auditStorySnapshot({
      ...snapshot,
      memberships: [
        { subjectEntityId: 'sham', objectEntityId: 'nyaban', predicate: 'member_of' },
      ],
    })

    // Un seul constat, un seul correctif : deux lignes proposant le même
    // retrait feraient échouer la seconde et croire à un défaut de plus.
    expect(findings.filter((finding) => finding.kind === 'identite_avec_un_membre')).toHaveLength(
      1,
    )
    expect(
      findings.filter((finding) => finding.kind === 'identite_de_types_incompatibles'),
    ).toEqual([])
  })
})

describe('une scène donnée pour quelqu’un', () => {
  it('refuse de confondre ce qui se raconte avec ce qui existe', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'combat',
          name: 'Zoro affronte Mihawk',
          nodeType: 'battle',
          firstSeenChapter: 51,
          labels: [
            label({
              id: 'l-combat',
              label: 'Zoro affronte Mihawk',
              kind: 'alias',
              revealedInChapter: 51,
            }),
          ],
        }),
        entity({ id: 'zoro', name: 'Zoro', firstSeenChapter: 3, labels: [label({ id: 'l-zoro', label: 'Zoro', revealedInChapter: 3 })] }),
      ],
      identities: [identity({ id: 'a-combat', subject: 'combat', object: 'zoro', chapter: 51 })],
    }).filter((finding) => finding.kind === 'identite_de_types_incompatibles')

    expect(found).toHaveLength(1)
    expect(found[0]?.detail).toContain('scène')
  })

  it('laisse tranquilles deux scènes rapprochées entre elles', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({ id: 'a', name: 'Une bataille', nodeType: 'battle', firstSeenChapter: 5 }),
        entity({ id: 'b', name: 'Un voyage', nodeType: 'voyage', firstSeenChapter: 5 }),
      ],
      identities: [identity({ subject: 'a', object: 'b', chapter: 5 })],
    }).filter((finding) => finding.kind === 'identite_de_types_incompatibles')

    expect(found).toEqual([])
  })
})

describe('une identité qui referme une boucle', () => {
  const trois = [
    entity({ id: 'a', name: 'Alpha', firstSeenChapter: 1 }),
    entity({ id: 'b', name: 'Beta', firstSeenChapter: 1 }),
    entity({ id: 'c', name: 'Gamma', firstSeenChapter: 1 }),
  ]

  it('signale la dernière arête, jamais celles qui étaient déjà là', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: trois,
      identities: [
        identity({ id: 'a-1', subject: 'a', object: 'b', chapter: 10 }),
        identity({ id: 'a-2', subject: 'b', object: 'c', chapter: 12 }),
        identity({ id: 'a-3', subject: 'c', object: 'a', chapter: 14 }),
      ],
    }).filter((finding) => finding.kind === 'identite_en_boucle')

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-3' })
  })

  it('signale la seconde écriture d’une même paire', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: trois.slice(0, 2),
      identities: [
        identity({ id: 'a-1', subject: 'a', object: 'b', chapter: 10 }),
        identity({ id: 'a-2', subject: 'b', object: 'a', chapter: 11 }),
      ],
    }).filter((finding) => finding.kind === 'identite_en_boucle')

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-2' })
  })

  it('se tait sur une chaîne qui ne se referme pas', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: trois,
      identities: [
        identity({ id: 'a-1', subject: 'a', object: 'b', chapter: 10 }),
        identity({ id: 'a-2', subject: 'b', object: 'c', chapter: 12 }),
      ],
    }).filter((finding) => finding.kind === 'identite_en_boucle')

    expect(found).toEqual([])
  })
})

describe('une identité datée avant l’un de ses bouts', () => {
  const silhouette = entity({
    id: 'silhouette',
    name: 'Silhouette au sommet',
    firstSeenChapter: 138,
    labels: [
      label({
        id: 'l-sil',
        label: 'Silhouette au sommet',
        kind: 'placeholder',
        revealedInChapter: 138,
        precedence: 10,
      }),
    ],
  })

  const chopper = entity({
    id: 'chopper',
    name: 'Tony Tony Chopper',
    firstSeenChapter: 138,
    labels: [label({ id: 'l-chopper', label: 'Tony Tony Chopper', revealedInChapter: 140 })],
  })

  it('signale la date, sans proposer de retirer une relation peut-être vraie', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [silhouette, chopper],
      identities: [
        identity({ id: 'a-tot', subject: 'silhouette', object: 'chopper', chapter: 138 }),
      ],
    }).filter((finding) => finding.kind === 'identite_anachronique')

    expect(found).toHaveLength(1)
    expect(found[0]?.title).toContain('avant le 140')
    // Retirer une relation vraie pour corriger sa date serait corriger par une
    // perte : la date se reprend sur la fiche, qui la propose depuis les sources.
    expect(found[0]?.fix).toBeNull()
  })

  it('se tait quand la date est celle du chapitre qui nomme', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [silhouette, chopper],
      identities: [
        identity({ id: 'a-juste', subject: 'silhouette', object: 'chopper', chapter: 140 }),
      ],
    }).filter((finding) => finding.kind === 'identite_anachronique')

    expect(found).toEqual([])
  })

  it('ne compte pas une graphie que rien n’affiche', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [
        silhouette,
        {
          ...chopper,
          labels: [
            label({ id: 'l-chopper', label: 'Tony Tony Chopper', revealedInChapter: 138 }),
            // Rangée sous le rang d'affichage : gardée pour la recherche, jamais
            // montrée, donc sans effet sur la date à laquelle la fiche est lisible.
            label({
              id: 'l-en',
              label: 'Tony Tony Chopper (en)',
              revealedInChapter: 400,
              precedence: 5,
            }),
          ],
        },
      ],
      identities: [
        identity({ id: 'a-juste', subject: 'silhouette', object: 'chopper', chapter: 138 }),
      ],
    }).filter((finding) => finding.kind === 'identite_anachronique')

    expect(found).toEqual([])
  })
})
