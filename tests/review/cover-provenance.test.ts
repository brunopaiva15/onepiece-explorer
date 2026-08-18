import { describe, expect, it } from 'vitest'
import { auditStorySnapshot, type AuditSnapshot } from '@/domains/review/audit.ts'
import {
  parseProvenanceVerdicts,
  provenanceFinding,
  provenanceInputs,
  provenanceQuestion,
} from '@/domains/review/provenance.ts'

/**
 * Ce qui vient du récit, et ce qui vient d'à côté.
 *
 * Une couverture de chapitre raconte sa propre histoire, sur des mois, à côté
 * du récit. Rangée dans la chronologie principale, elle fait apparaître au
 * chapitre 146 quelqu'un que le récit avait laissé ailleurs, et le lecteur
 * croit avoir manqué une page.
 *
 * Les deux scènes ci-dessous — un danseur au 146, une capitaine au 171 — sont
 * des **données**, et le test qui compte est le troisième : sans provenance
 * dans le graphe, la règle se tait. Elle ne devine pas qu'une scène est une
 * couverture parce qu'elle connaît l'œuvre ; elle lit `pages.kind` et
 * `evidence.kind`, ou elle ne dit rien.
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

const JANGO = {
  entityId: 's-146',
  chapter: 146,
  summary: 'Jango danse devant une foule conquise et emmène tout le monde avec lui.',
}

const HINA = {
  entityId: 's-171',
  chapter: 171,
  summary: 'Hina arrête une bande de pirates et les emprisonne dans ses anneaux.',
}

describe('une scène dont toute la preuve vient d’une couverture', () => {
  it('est signalée, sans correction mécanique', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      provenance: [
        { ...JANGO, pageKinds: ['cover'], evidenceKinds: ['cover'], structured: true },
        { ...HINA, pageKinds: ['cover'], evidenceKinds: ['cover'], structured: true },
      ],
    }).filter((finding) => finding.kind === 'scene_hors_recit')

    expect(findings.map((finding) => finding.chapter)).toEqual([146, 171])
    // Ce que devient une scène de couverture — écartée du fil, redatée — est un
    // choix éditorial, et rien dans le graphe ne le porte encore.
    expect(findings.every((finding) => finding.fix === null)).toBe(true)
  })

  it('accepte aussi une page bonus', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      provenance: [
        { ...JANGO, pageKinds: ['bonus'], evidenceKinds: ['cover'], structured: true },
      ],
    }).filter((finding) => finding.kind === 'scene_hors_recit')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('bonus')
  })
})

describe('ce que la règle refuse de conclure', () => {
  it('se tait quand une seule preuve vient du récit', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      provenance: [
        {
          ...JANGO,
          pageKinds: ['cover', 'narrative'],
          evidenceKinds: ['cover', 'dialogue'],
          structured: true,
        },
      ],
    }).filter((finding) => finding.kind === 'scene_hors_recit')

    expect(findings).toEqual([])
  })

  it('se tait sur un chapitre importé en résumé, sans provenance à lire', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      provenance: [
        { ...JANGO, pageKinds: [], evidenceKinds: [], structured: false },
        { ...HINA, pageKinds: [], evidenceKinds: [], structured: false },
      ],
    }).filter((finding) => finding.kind === 'scene_hors_recit')

    expect(findings).toEqual([])
  })

  it('se tait quand le chapitre a des pages mais que la scène n’a aucune preuve', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      provenance: [{ ...HINA, pageKinds: [], evidenceKinds: [], structured: true }],
    }).filter((finding) => finding.kind === 'scene_hors_recit')

    expect(findings).toEqual([])
  })
})

/**
 * Le soupçon, pour les chapitres qui n'ont pas de provenance du tout.
 *
 * Ce qu'un modèle peut voir dans un texte de résumé est une mention explicite.
 * Ce qu'il ne peut pas faire est conclure de sa connaissance de l'œuvre : le
 * test qui compte ici est celui où la phrase citée n'est pas dans le texte, et
 * où rien n'est écrit.
 */
describe('un soupçon sur un chapitre sans provenance', () => {
  const passages = [
    'En couverture de ce chapitre, Jango poursuit sa carrière de danseur loin de l’équipage.',
    'Sur l’île, l’équipage reprend sa route vers le prochain port.',
  ]

  it('signale la scène, et ne propose jamais de correction', () => {
    const [row] = parseProvenanceVerdicts(
      's-146 | cover_or_bonus | En couverture de ce chapitre, Jango poursuit sa carrière de danseur | Le texte le dit.',
      ['s-146'],
    )

    const finding = provenanceFinding({
      row: row!,
      chapter: 146,
      summary: JANGO.summary,
      passages,
    })

    expect(finding?.kind).toBe('scene_hors_recit_soupcon')
    expect(finding?.chapter).toBe(146)
    expect(finding?.fix).toBeNull()
    expect(finding?.detail).toContain('pas une correction')
  })

  it('n’écrit rien quand la phrase citée n’est pas dans le texte', () => {
    const [row] = parseProvenanceVerdicts(
      's-171 | cover_or_bonus | Hina apparaît en couverture de ce chapitre | de mémoire',
      ['s-171'],
    )

    expect(
      provenanceFinding({ row: row!, chapter: 171, summary: HINA.summary, passages }),
    ).toBeNull()
  })

  it('n’écrit rien sur main_story ni sur insufficient_data', () => {
    for (const verdict of ['main_story', 'insufficient_data']) {
      const [row] = parseProvenanceVerdicts(
        `s-146 | ${verdict} | En couverture de ce chapitre, Jango poursuit | rien`,
        ['s-146'],
      )

      expect(
        provenanceFinding({ row: row!, chapter: 146, summary: JANGO.summary, passages }),
      ).toBeNull()
    }
  })

  it('refuse une scène que le modèle a formée', () => {
    expect(
      parseProvenanceVerdicts('s-inventee | cover_or_bonus | phrase | raison', ['s-146']),
    ).toEqual([])
  })
})

describe('la consigne', () => {
  it('interdit explicitement de se servir de sa connaissance de l’œuvre', () => {
    const question = provenanceQuestion(146)

    expect(question).toContain('Ne vous servez jamais de ce que vous savez de cette œuvre')
    expect(question).toContain('cover_or_bonus')
    expect(question).toContain('insufficient_data')
  })
})

describe('ce qui décide de relire un chapitre', () => {
  const scenes = [{ entityId: 's-146', summary: JANGO.summary }]

  it('ne change pas quand rien n’a changé', () => {
    expect(provenanceInputs(scenes, ['un passage'])).toEqual(
      provenanceInputs(scenes, ['un passage']),
    )
  })

  it('change quand le texte du chapitre change', () => {
    expect(provenanceInputs(scenes, ['un autre passage'])).not.toEqual(
      provenanceInputs(scenes, ['un passage']),
    )
  })
})
