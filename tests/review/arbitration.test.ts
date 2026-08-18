import { describe, expect, it } from 'vitest'
import type { Arbitration } from '@/domains/ai/schemas.ts'
import {
  arbitrationResult,
  briefsFor,
  settle,
  slices,
  statementOf,
  type Guards,
  type PendingCard,
} from '@/domains/review/arbitration.ts'

/**
 * Ce qu'un second modèle a le droit de trancher, et sur quelle preuve.
 *
 * Sans base et sans appel, parce que c'est là tout l'intérêt d'avoir séparé la
 * règle : ce fichier est le seul endroit où l'on vérifie qu'une passe qui décide
 * à la place du lecteur refuse de le faire quand elle n'a pas de quoi.
 *
 * Les scénarios sont les défauts observés d'un modèle à qui l'on tend une page :
 * il cite une phrase qui n'y est pas, il cite trois mots qui y sont partout, il
 * tranche une identité qu'on ne lui a pas demandé de trancher, et il écrit un
 * nom « presque » comme la page l'écrit.
 */

const PAGE = {
  language: 'fr',
  text: [
    '## Résumé approfondi',
    "Luffy quitte le Village de Fuchsia à bord d'une petite barque.",
    'Le Baron Alberto est capturé par les habitants du village.',
    '## Notes',
    'Première apparition de Shanks.',
  ].join('\n\n'),
}

function card(over: Partial<PendingCard> & { itemId: string }): PendingCard {
  return {
    category: 'assertion',
    payload: {},
    fingerprint: `f-${over.itemId}`,
    confidence: 0.4,
    requiresExplicitReview: false,
    ...over,
  }
}

function reply(...verdicts: Arbitration['verdicts']): Arbitration {
  return { verdicts }
}

function settled(cards: PendingCard[], answer: Arbitration, guards: Guards = {}) {
  const briefs = briefsFor(cards, {}, 0.75)
  return settle(answer, briefs, [PAGE], guards)
}

describe('un verdict ne vaut que sa citation', () => {
  it('applique un verdict dont la phrase est dans la page, mot pour mot', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: "Luffy quitte le Village de Fuchsia à bord d'une petite barque.",
        reason: 'La page le dit.',
      }),
    )

    expect(one!.record.applied).toBe(true)
    expect(one!.record.verdict).toBe('accept')
    expect(one!.record.held).toBeNull()
  })

  it('retient un verdict dont la phrase ne figure pas dans la page', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: 'Luffy quitte le village en compagnie de Shanks, qui le félicite.',
        reason: 'La page le dit.',
      }),
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.held).toMatch(/introuvable/i)
    // Le verdict est gardé : la carte affiche ce que l'arbitrage aurait fait.
    expect(one!.record.verdict).toBe('accept')
  })

  it('ignore les retours à la ligne, jamais les mots', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: "Luffy quitte le Village de Fuchsia\n   à bord d'une petite barque.",
        reason: 'La page le dit.',
      }),
    )

    expect(one!.record.applied).toBe(true)
  })

  it('refuse une citation trop courte pour prouver quoi que ce soit', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({ card: 'c1', verdict: 'accept', quote: 'Luffy', reason: 'La page le dit.' }),
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.held).toMatch(/trop courte/i)
  })

  it("n'exige rien d'une abstention", () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({
        card: 'c1',
        verdict: 'undecided',
        quote: '',
        reason: 'La page ne parle pas de cette scène.',
      }),
    )

    expect(one!.record.verdict).toBe('undecided')
    expect(one!.record.applied).toBe(false)
    // Une abstention n'est pas un refus : rien n'a été écarté.
    expect(one!.record.held).toBeNull()
  })
})

describe('ce que l’arbitrage ne décide pas', () => {
  it('rend un avis sur un rapprochement, et ne le décide pas', () => {
    const [one] = settled(
      [card({ itemId: 'a', category: 'resolution', requiresExplicitReview: true })],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: 'Le Baron Alberto est capturé par les habitants du village.',
        reason: "C'est la même personne.",
      }),
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.verdict).toBe('accept')
    expect(one!.record.held).toMatch(/identité/i)
  })

  it('rend un avis sur une contradiction, et ne la décide pas', () => {
    const [one] = settled(
      [card({ itemId: 'a', category: 'conflict', requiresExplicitReview: true })],
      reply({
        card: 'c1',
        verdict: 'reject',
        quote: 'Le Baron Alberto est capturé par les habitants du village.',
        reason: 'La page dit le contraire.',
      }),
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.held).toMatch(/contradiction/i)
  })

  it('décide une révélation que la page attribue à ce chapitre', () => {
    const [one] = settled(
      [card({ itemId: 'a', requiresExplicitReview: true })],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: 'Le Baron Alberto est capturé par les habitants du village.',
        reason: 'La page le dit.',
      }),
    )

    // Ce que la passe automatique accepte déjà sur un chapitre qui se relit
    // lui-même — mais ici sur une phrase citée plutôt que sur un score.
    expect(one!.record.applied).toBe(true)
  })
})

describe('une question de nom se tranche sur la graphie', () => {
  const naming = (label: string): PendingCard =>
    card({
      itemId: 'a',
      category: 'entity',
      requiresExplicitReview: true,
      payload: { local_id: 'e1', label, node_type: 'place', naming_confident: false },
    })

  it('accepte la forme que la page écrit', () => {
    const [one] = settled(
      [naming('Village de Fuchsia')],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: "Luffy quitte le Village de Fuchsia à bord d'une petite barque.",
        reason: 'La page française écrit ce nom ainsi.',
      }),
    )

    expect(one!.record.applied).toBe(true)
  })

  it('refuse une graphie voisine, qui ferait une seconde entité', () => {
    const [one] = settled(
      [naming('Village de Foosha')],
      reply({
        card: 'c1',
        verdict: 'accept',
        quote: "Luffy quitte le Village de Fuchsia à bord d'une petite barque.",
        reason: "C'est le même village.",
      }),
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.held).toMatch(/graphie/i)
  })
})

describe('un rejet ne casse pas ce qui pointe vers lui', () => {
  it("laisse en file l'entité qu'une autre carte nomme", () => {
    const entity = card({
      itemId: 'a',
      category: 'entity',
      payload: { local_id: 'e1', label: 'Baron Alberto', node_type: 'character' },
    })

    const [one] = settled(
      [entity],
      reply({
        card: 'c1',
        verdict: 'reject',
        quote: 'Le Baron Alberto est capturé par les habitants du village.',
        reason: 'La page ne le mentionne pas ainsi.',
      }),
      { protectedIds: new Set(['e1']) },
    )

    expect(one!.record.applied).toBe(false)
    expect(one!.record.held).toMatch(/nomme/i)
  })
})

describe('la réponse est recoupée avec ce qui a été demandé', () => {
  it('laisse en file une carte dont le modèle n’a rien dit', () => {
    const answers = settled([card({ itemId: 'a' }), card({ itemId: 'b' })], reply())

    expect(answers).toHaveLength(2)
    expect(answers.every((one) => one.record.verdict === 'undecided')).toBe(true)
    expect(answers[0]!.record.reason).toMatch(/rien répondu/i)
  })

  it('ignore un identifiant que le modèle a formé', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply({
        card: 'c42',
        verdict: 'accept',
        quote: 'Le Baron Alberto est capturé par les habitants du village.',
        reason: 'La page le dit.',
      }),
    )

    expect(one!.record.verdict).toBe('undecided')
    expect(one!.record.applied).toBe(false)
  })

  it('retient le premier verdict quand le modèle se contredit', () => {
    const [one] = settled(
      [card({ itemId: 'a' })],
      reply(
        {
          card: 'c1',
          verdict: 'accept',
          quote: 'Le Baron Alberto est capturé par les habitants du village.',
          reason: 'La page le dit.',
        },
        {
          card: 'c1',
          verdict: 'reject',
          quote: 'Le Baron Alberto est capturé par les habitants du village.',
          reason: 'Finalement non.',
        },
      ),
    )

    expect(one!.record.verdict).toBe('accept')
  })
})

describe('le compte rendu', () => {
  it('sépare ce qui a été décidé de ce qui remonte au lecteur', () => {
    const answers = settled(
      [
        card({ itemId: 'a' }),
        card({ itemId: 'b', category: 'resolution', requiresExplicitReview: true }),
        card({ itemId: 'c' }),
      ],
      reply(
        {
          card: 'c1',
          verdict: 'accept',
          quote: "Luffy quitte le Village de Fuchsia à bord d'une petite barque.",
          reason: 'La page le dit.',
        },
        {
          card: 'c2',
          verdict: 'accept',
          quote: 'Le Baron Alberto est capturé par les habitants du village.',
          reason: "C'est la même personne.",
        },
        { card: 'c3', verdict: 'undecided', quote: '', reason: 'La page se tait.' },
      ),
    )

    const result = arbitrationResult(answers, [PAGE])

    expect(result.submitted).toBe(3)
    expect(result.accepted).toBe(1)
    expect(result.undecided).toBe(2)
    expect(result.advisory).toBe(1)
    expect(result.pages).toEqual(['fr'])
  })
})

describe('les cartes soumises au modèle', () => {
  it('nomme les bouts d’une relation plutôt que leurs identifiants', () => {
    const statement = statementOf(
      card({
        itemId: 'a',
        payload: { subject: 'e1', predicate: 'located_at', object: 'e2' },
      }),
      { e1: 'Monkey D. Luffy', e2: 'Village de Fuchsia' },
    )

    expect(statement).toContain('Monkey D. Luffy')
    expect(statement).toContain('Village de Fuchsia')
    expect(statement).not.toContain('e1')
  })

  it('part en tranches plutôt qu’en un seul appel démesuré', () => {
    const many = Array.from({ length: 95 }, (_, index) => index)
    expect(slices(many, 40).map((one) => one.length)).toEqual([40, 40, 15])
  })
})
