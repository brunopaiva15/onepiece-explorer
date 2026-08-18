import { describe, expect, it } from 'vitest'
import {
  auditStorySnapshot,
  firstWrittenChapters,
  parseRelecture,
  relectureFinding,
  scenesMatching,
  type AuditEntity,
  type AuditLabel,
  type AuditSnapshot,
} from '@/domains/review/audit.ts'

/**
 * Ce que l'analyse de toute l'histoire reproche, et ce qu'elle refuse de
 * reprocher.
 *
 * Aucune base, aucun modèle, aucun appel payant : les règles sont dans un module
 * à part précisément pour qu'elles s'exercent ici. Elles écrivent dans le graphe
 * d'un clic — une entrée en scène déplacée, un nom redaté, une identité retirée
 * — et une règle capable de ça qu'on ne peut vérifier qu'en production est une
 * règle que personne ne vérifie.
 *
 * Les exemples viennent des vrais défauts relevés en relisant les chapitres 1 à
 * 145 : Oni Giri annoncé au 51 alors que Zoro le nomme au 17, « Igaram » affiché
 * au 106 alors que le nom arrive au 110, les Nyaban Brothers confondus avec
 * Buchi, la même scène écrite deux fois par deux passages du pipeline.
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

function entity(input: Partial<AuditEntity> & { id: string }): AuditEntity {
  return {
    nodeType: 'character',
    firstSeenChapter: 1,
    labels: [],
    ...input,
  }
}

describe('la même scène, deux fois dans un chapitre', () => {
  const snapshot: AuditSnapshot = {
    ...EMPTY,
    events: [
      {
        entityId: 'court',
        chapter: 2,
        summary: 'Luffy et Koby prennent la mer ensemble.',
        createdAt: 1,
      },
      {
        entityId: 'long',
        chapter: 2,
        summary:
          'Luffy et Koby prennent la mer ensemble, Koby parlant de Zoro à Luffy qui décide de le recruter.',
        createdAt: 2,
      },
    ],
  }

  it('garde la formulation la plus complète et rejette l’autre', () => {
    const [finding, ...rest] = auditStorySnapshot(snapshot)

    expect(rest).toHaveLength(0)
    expect(finding?.kind).toBe('scene_dupliquee')
    expect(finding?.chapter).toBe(2)
    expect(finding?.fix).toEqual({
      action: 'rejeter_entite',
      entityId: 'court',
      because: expect.stringContaining('Doublon'),
    })
  })

  it('ne replie pas deux scènes qui ne diffèrent que par qui les vit', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      events: [
        {
          entityId: 'a',
          chapter: 44,
          summary: 'Zoro tranche Kuroobi dans le hall du restaurant.',
          createdAt: 1,
        },
        {
          entityId: 'b',
          chapter: 44,
          summary: 'Zoro tranche Hachi dans le hall du restaurant.',
          createdAt: 2,
        },
      ],
    })

    expect(findings).toEqual([])
  })

  it('laisse une scène redite au chapitre suivant : c’est un souvenir', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      events: [
        { entityId: 'a', chapter: 78, summary: 'Arlong exécute Bell-mère.', createdAt: 1 },
        { entityId: 'b', chapter: 79, summary: 'Arlong exécute Bell-mère.', createdAt: 2 },
      ],
    })

    expect(findings).toEqual([])
  })
})

describe('un nom affiché avant le chapitre qui l’écrit', () => {
  it('le redate au premier chapitre dont le texte le porte', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'igaram',
          firstSeenChapter: 106,
          labels: [
            {
              id: 'l-igaram',
              label: 'Igaram',
              normalized: 'igaram',
              kind: 'true_name',
              revealedInChapter: 106,
              precedence: 100,
            },
          ],
        }),
      ],
      firstWritten: new Map([['igaram', 110]]),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('nom_premature')
    expect(findings[0]?.fix).toEqual({
      action: 'redater_nom',
      labelId: 'l-igaram',
      chapter: 110,
    })
  })

  it('se tait sur un nom qu’aucune source n’écrit : indatable, pas fautif', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'silhouette',
          firstSeenChapter: 115,
          labels: [
            {
              id: 'l-1',
              label: 'Silhouette géante',
              normalized: 'silhouette geante',
              kind: 'placeholder',
              revealedInChapter: 115,
              precedence: 10,
            },
          ],
        }),
      ],
    })

    expect(findings).toEqual([])
  })

  it('ignore une graphie que rien n’affiche', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'yassop',
          labels: [
            {
              id: 'l-source',
              label: 'Yassop',
              normalized: 'yassop',
              kind: 'alias',
              revealedInChapter: 1,
              // Sous tous les rangs : la graphie d'origine, gardée pour la
              // recherche et jamais montrée.
              precedence: 5,
            },
          ],
        }),
      ],
      firstWritten: new Map([['yassop', 4]]),
    })

    expect(findings).toEqual([])
  })
})

describe('une révélation racontée à l’envers', () => {
  const zeff = entity({
    id: 'zeff-court',
    firstSeenChapter: 47,
    labels: [
      {
        id: 'l-court',
        label: 'Zeff',
        normalized: 'zeff',
        kind: 'true_name',
        revealedInChapter: 47,
        precedence: 100,
      },
    ],
  })

  const zeffComplet = entity({
    id: 'zeff-complet',
    firstSeenChapter: 48,
    labels: [
      {
        id: 'l-complet',
        label: 'Zeff aux Pieds Rouges',
        normalized: 'zeff aux pieds rouges',
        kind: 'epithet',
        revealedInChapter: 48,
        precedence: 70,
      },
    ],
  })

  it('remet devant le nom révélé le plus tard', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [zeff, zeffComplet],
      identities: [
        {
          assertionId: 'a-1',
          subjectEntityId: 'zeff-court',
          objectEntityId: 'zeff-complet',
          knowledgeFromChapter: 48,
        },
      ],
    })

    const reversed = findings.filter((finding) => finding.kind === 'identite_a_l_envers')
    expect(reversed).toHaveLength(1)
    expect(reversed[0]?.fix).toEqual({ action: 'promouvoir_nom', labelId: 'l-complet' })
  })

  it('laisse tranquille une révélation dans le bon sens', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'silhouette',
          firstSeenChapter: 115,
          labels: [
            {
              id: 'l-silhouette',
              label: 'Silhouette géante',
              normalized: 'silhouette geante',
              kind: 'placeholder',
              revealedInChapter: 115,
              precedence: 10,
            },
          ],
        }),
        entity({
          id: 'brogy',
          firstSeenChapter: 116,
          labels: [
            {
              id: 'l-brogy',
              label: 'Brogy',
              normalized: 'brogy',
              kind: 'true_name',
              revealedInChapter: 116,
              precedence: 100,
            },
          ],
        }),
      ],
      identities: [
        {
          assertionId: 'a-2',
          subjectEntityId: 'silhouette',
          objectEntityId: 'brogy',
          knowledgeFromChapter: 116,
        },
      ],
    })

    expect(findings.filter((finding) => finding.kind === 'identite_a_l_envers')).toEqual([])
  })
})

describe('un groupe confondu avec l’un de ses membres', () => {
  it('retire l’identité, et seulement quand l’appartenance le prouve', () => {
    const nyaban = entity({
      id: 'nyaban',
      nodeType: 'group',
      firstSeenChapter: 31,
      labels: [
        {
          id: 'l-nyaban',
          label: 'Nyaban Brothers',
          normalized: 'nyaban brothers',
          kind: 'true_name',
          revealedInChapter: 31,
          precedence: 100,
        },
      ],
    })
    const buchi = entity({
      id: 'buchi',
      nodeType: 'group',
      firstSeenChapter: 31,
      labels: [
        {
          id: 'l-buchi',
          label: 'Buchi',
          normalized: 'buchi',
          kind: 'true_name',
          revealedInChapter: 31,
          precedence: 100,
        },
      ],
    })

    const identities = [
      {
        assertionId: 'a-3',
        subjectEntityId: 'nyaban',
        objectEntityId: 'buchi',
        knowledgeFromChapter: 31,
      },
    ]

    const withMembership = auditStorySnapshot({
      ...EMPTY,
      entities: [nyaban, buchi],
      identities,
      memberships: [
        { subjectEntityId: 'buchi', objectEntityId: 'nyaban', predicate: 'member_of' },
      ],
    })

    const found = withMembership.filter(
      (finding) => finding.kind === 'identite_avec_un_membre',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-3' })

    // Sans la relation d'appartenance, la règle ne devine pas qu'un libellé a
    // l'air d'un groupe : elle se tait.
    const withoutMembership = auditStorySnapshot({
      ...EMPTY,
      entities: [nyaban, buchi],
      identities,
    })
    expect(
      withoutMembership.filter((finding) => finding.kind === 'identite_avec_un_membre'),
    ).toEqual([])
  })
})

describe('entrer en scène après avoir été nommé', () => {
  it('ramène l’entrée au chapitre qui en parle', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'oni-giri',
          nodeType: 'power',
          firstSeenChapter: 51,
          labels: [
            {
              id: 'l-oni',
              label: 'Oni Giri',
              normalized: 'oni giri',
              kind: 'true_name',
              revealedInChapter: 51,
              precedence: 100,
            },
          ],
        }),
      ],
      firstWritten: new Map([['oni giri', 17]]),
    })

    expect(findings.map((finding) => finding.kind)).toContain('entree_tardive')
    expect(findings.find((finding) => finding.kind === 'entree_tardive')?.fix).toEqual({
      action: 'avancer_entree',
      entityId: 'oni-giri',
      chapter: 17,
    })
  })

  it('ne cherche pas dans les sources une désignation que la bibliothèque a écrite', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'homme',
          firstSeenChapter: 131,
          labels: [
            {
              id: 'l-homme',
              label: 'Homme mystérieux debout sur l’eau',
              normalized: 'homme mysterieux debout sur l eau',
              kind: 'placeholder',
              revealedInChapter: 131,
              precedence: 10,
            },
          ],
        }),
      ],
      firstWritten: new Map([['homme mysterieux debout sur l eau', 3]]),
    })

    expect(findings.filter((finding) => finding.kind === 'entree_tardive')).toEqual([])
  })
})

describe('deux graphies pour une chose', () => {
  const baggy = entity({
    id: 'baggy',
    firstSeenChapter: 9,
    labels: [
      {
        id: 'l-baggy',
        label: 'Baggy',
        normalized: 'baggy',
        kind: 'true_name',
        revealedInChapter: 9,
        precedence: 100,
      },
    ],
  })

  it('signale une lettre d’écart sans proposer de corriger', () => {
    const buggy = entity({
      id: 'buggy',
      firstSeenChapter: 97,
      labels: [
        {
          id: 'l-buggy',
          label: 'Buggy',
          normalized: 'buggy',
          kind: 'true_name',
          revealedInChapter: 97,
          precedence: 100,
        },
      ],
    })

    const findings = auditStorySnapshot({ ...EMPTY, entities: [baggy, buggy] })
    const variants = findings.filter((finding) => finding.kind === 'variantes_du_meme_nom')

    expect(variants).toHaveLength(1)
    // Fusionner deux fiches réécrit ce que le lecteur savait entre les deux :
    // aucune correction mécanique, jamais.
    expect(variants[0]?.fix).toBeNull()
  })

  it('se tait sur deux nœuds déjà rejoints', () => {
    const buggy = entity({
      id: 'buggy',
      firstSeenChapter: 97,
      labels: [
        {
          id: 'l-buggy',
          label: 'Buggy',
          normalized: 'buggy',
          kind: 'true_name',
          revealedInChapter: 97,
          precedence: 100,
        },
      ],
    })

    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [baggy, buggy],
      identities: [
        {
          assertionId: 'a-4',
          subjectEntityId: 'baggy',
          objectEntityId: 'buggy',
          knowledgeFromChapter: 97,
        },
      ],
    })

    expect(findings.filter((finding) => finding.kind === 'variantes_du_meme_nom')).toEqual([])
  })

  it('ne rapproche pas deux types différents portant le même genre de nom', () => {
    const navire = entity({
      id: 'orbit',
      nodeType: 'object',
      firstSeenChapter: 56,
      labels: [
        {
          id: 'l-orbit',
          label: 'Orbit',
          normalized: 'orbit',
          kind: 'true_name',
          revealedInChapter: 56,
          precedence: 100,
        },
      ],
    })
    const personne = entity({
      id: 'obit',
      firstSeenChapter: 56,
      labels: [
        {
          id: 'l-obit',
          label: 'Orbot',
          normalized: 'orbot',
          kind: 'true_name',
          revealedInChapter: 56,
          precedence: 100,
        },
      ],
    })

    const findings = auditStorySnapshot({ ...EMPTY, entities: [navire, personne] })
    expect(findings.filter((finding) => finding.kind === 'variantes_du_meme_nom')).toEqual([])
  })
})

describe('à quel chapitre les sources écrivent un nom', () => {
  const sources = [
    { chapter: 17, normalizedText: 'zoro annonce son oni giri et abat le pirate.' },
    { chapter: 51, normalizedText: 'oni giri tranche le second de l arlong park.' },
    { chapter: 60, normalizedText: 'vivienne regarde la mer, seule.' },
  ]

  it('rend le premier, jamais le plus récent', () => {
    expect(firstWrittenChapters(sources, ['oni giri']).get('oni giri')).toBe(17)
  })

  it('exige le mot entier : « vivi » dans « vivienne » n’est pas le nom', () => {
    expect(firstWrittenChapters(sources, ['vivi']).has('vivi')).toBe(false)
  })

  it('ne rapproche pas deux mots qu’une phrase n’a jamais mis côte à côte', () => {
    const scattered = [
      { chapter: 3, normalizedText: 'le merry est un navire, et vogue vers l est.' },
    ]
    expect(firstWrittenChapters(scattered, ['vogue merry']).has('vogue merry')).toBe(false)
  })
})

describe('ce qu’une relecture a le droit d’écrire', () => {
  const passages = [
    'Usopp quitte enfin sa maison et rejoint le Vogue Merry comme membre de l’équipage.',
  ]

  it('exige une phrase du chapitre, pas un raisonnement', () => {
    const finding = relectureFinding({
      chapter: 41,
      entityId: 'scene-41',
      summary: 'Usopp devient capitaine de l’équipage de Luffy.',
      objection: 'Le chapitre en fait un membre, pas le capitaine.',
      excerpt: 'Usopp est nommé capitaine par Luffy',
      passages,
      correction: 'Usopp rejoint le Vogue Merry et devient membre de l’équipage.',
    })

    expect(finding).toBeNull()
  })

  it('propose la phrase corrigée quand la citation est bien dans le chapitre', () => {
    const finding = relectureFinding({
      chapter: 41,
      entityId: 'scene-41',
      summary: 'Usopp devient capitaine de l’équipage de Luffy.',
      objection: 'Le chapitre en fait un membre, pas le capitaine.',
      excerpt: 'rejoint le Vogue Merry comme membre de l’équipage',
      passages,
      correction: 'Usopp rejoint le Vogue Merry et devient membre de l’équipage.',
    })

    expect(finding?.kind).toBe('relecture')
    expect(finding?.fix).toEqual({
      action: 'reecrire_scene',
      entityId: 'scene-41',
      summary: 'Usopp rejoint le Vogue Merry et devient membre de l’équipage.',
    })
  })

  it('garde le constat sans correction quand la réécriture ne change rien', () => {
    const finding = relectureFinding({
      chapter: 41,
      entityId: 'scene-41',
      summary: 'Usopp rejoint le Vogue Merry.',
      objection: 'Le chapitre dit autre chose.',
      excerpt: 'Usopp quitte enfin sa maison',
      passages,
      correction: 'Usopp rejoint le Vogue Merry.',
    })

    expect(finding).not.toBeNull()
    expect(finding?.fix).toBeNull()
  })
})

/**
 * L'incident du chapitre 41, en test.
 *
 * `repair:chronologie` a tourné une fois en production avec « usopp » et
 * « capitaine » pour désigner *la* phrase qui fait d'Usopp le capitaine. Les
 * quatre scènes ci-dessous sont celles que la bibliothèque portait vraiment ; la
 * deuxième dit exactement ce que le chapitre dit, et elle a été remplacée comme
 * les autres.
 *
 * Ce jeu de données est donc le témoin de l'incident : tant qu'il passe, une
 * correction ne peut plus s'appliquer à une scène qu'elle n'avait pas visée.
 */
describe('les scènes qu’une correction désigne', () => {
  const CHAPITRE_41 = [
    {
      summary:
        'Piment, Oignon et Carotte regardent partir le navire emmenant leur ancien capitaine Usopp, heureux qu\'il soit désormais entouré de compagnons forts.',
    },
    {
      summary:
        'Usopp arrive en roulant vers le navire. Luffy et Zoro l’arrêtent et l’invitent à embarquer avec eux. Usopp suppose qu’il deviendra le capitaine, mais Luffy lui rappelle qu’il occupe déjà ce rôle.',
    },
    {
      summary:
        'Usopp arrive en roulant vers le navire, Luffy et Zoro l\'arrêtent avec leurs pieds et l\'invitent à devenir capitaine à bord.',
    },
    {
      summary:
        'Usopp quitte enfin sa maison en la brisant, rejoint le Vogue Merry et devient officiellement capitaine de l\'équipage de Luffy, sous le regard de ses anciens compagnons et de Kaya.',
    },
  ]

  it('en désigne quatre sur des fragments trop larges — ce qui doit interdire d’écrire', () => {
    expect(scenesMatching(CHAPITRE_41, ['usopp', 'capitaine'])).toHaveLength(4)
  })

  it('n’en désigne qu’une sur le fragment de la phrase fautive', () => {
    const found = scenesMatching(CHAPITRE_41, ['devient officiellement capitaine'])

    expect(found).toHaveLength(1)
    expect(found[0]?.summary).toContain('sous le regard de ses anciens compagnons')
  })

  it('replie les accents et les apostrophes des deux côtés', () => {
    const found = scenesMatching(
      [{ summary: 'Bell-mère paie Arlong mais il l’exécute néanmoins devant elles.' }],
      ['execute neanmoins'],
    )

    expect(found).toHaveLength(1)
  })

  it('ne désigne rien plutôt que tout quand la liste de fragments est vide', () => {
    expect(scenesMatching(CHAPITRE_41, [])).toEqual([])
  })
})

describe('la réponse du modèle, ligne par ligne', () => {
  it('refuse un identifiant qu’il a formé plutôt que recopié', () => {
    const rows = parseRelecture(
      'scene-inventee | ce n’est pas dit | - | une phrase\nscene-41 | faux | - | une autre',
      ['scene-41'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.entityId).toBe('scene-41')
  })

  it('ne reproche pas deux fois la même scène', () => {
    const rows = parseRelecture(
      'scene-41 | premier reproche | - | phrase\nscene-41 | second reproche | - | phrase',
      ['scene-41'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.objection).toBe('premier reproche')
  })

  it('garde une citation qui contient une barre verticale', () => {
    const rows = parseRelecture('scene-41 | faux | - | il crie : « en avant | toute »', [
      'scene-41',
    ])

    expect(rows[0]?.excerpt).toBe('il crie : « en avant | toute »')
  })

  it('lit « - » comme une absence de correction', () => {
    const rows = parseRelecture('scene-41 | faux | - | phrase', ['scene-41'])
    expect(rows[0]?.correction).toBeNull()
  })

  it('ignore une réponse en prose, qui n’est pas le format demandé', () => {
    expect(parseRelecture('insufficient_data', ['scene-41'])).toEqual([])
  })
})

/**
 * Les libellés que la bibliothèque a déjà, et que l'extraction refuse désormais.
 *
 * « Escargophone utilisé par Crocodile pour contacter les Billions » est un nom
 * d'objet réel, tiré d'un vrai chapitre. Le défaut n'existe qu'au passé — les
 * cent soixante-douze chapitres importés avant que l'extraction sache lire la
 * grammaire d'un nom — et c'est le seul endroit qui puisse le rattraper, puisque
 * aucune règle voisine ne s'intéresse à un libellé bien daté, bien relié et
 * simplement bavard.
 */
describe('un libellé qui raconte au lieu de nommer', () => {
  const label = (input: Partial<AuditLabel> & { id: string; label: string }): AuditLabel => ({
    normalized: input.label.toLowerCase(),
    kind: 'placeholder',
    revealedInChapter: 173,
    precedence: 10,
    ...input,
  })

  it('propose la forme courte, sans jamais l’écrire seule', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'escargophone',
          nodeType: 'object',
          firstSeenChapter: 173,
          labels: [
            label({
              id: 'l-den-den',
              label: 'Escargophone utilisé par Crocodile pour contacter les Billions',
            }),
          ],
        }),
      ],
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('libelle_verbeux')
    expect(findings[0]?.chapter).toBe(173)
    expect(findings[0]?.fix).toEqual({
      action: 'raccourcir_libelle',
      labelId: 'l-den-den',
      label: 'Escargophone',
    })
  })

  it('garde le constat sans correction quand aucune coupe ne laisse un nom', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'navire',
          nodeType: 'object',
          labels: [
            label({
              id: 'l-navire',
              label: 'Grand navire de guerre noir aux voiles déchirées et à la proue brisée',
            }),
          ],
        }),
      ],
    })

    expect(findings).toHaveLength(1)
    // Le constat dit où regarder ; couper au sixième mot inventerait un nom.
    expect(findings[0]?.fix).toBeNull()
  })

  it('se tait sur une scène et sur un mystère, dont le nom EST une phrase', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'scene',
          nodeType: 'battle',
          labels: [
            label({
              id: 'l-scene',
              label: 'Les Bananawani sortent du bassin et poursuivent Vivi, qui leur échappe.',
              kind: 'alias',
            }),
          ],
        }),
        entity({
          id: 'mystere',
          nodeType: 'mystery',
          labels: [
            label({
              id: 'l-mystere',
              label: 'Qui a prévenu Crocodile pour qu’il attende l’équipage à Rainbase ?',
              kind: 'alias',
            }),
          ],
        }),
      ],
    })

    expect(findings).toEqual([])
  })

  it('ignore une graphie que rien n’affiche : la raccourcir ne changerait rien', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'escargophone',
          nodeType: 'object',
          labels: [
            label({
              id: 'l-anglais',
              label: 'Den Den Mushi used by Crocodile to call the Billions',
              kind: 'alias',
              precedence: 5,
            }),
          ],
        }),
      ],
    })

    expect(findings).toEqual([])
  })

  it('retire la correction quand la forme courte est déjà le nom d’une autre fiche', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'la-marine',
          nodeType: 'group',
          labels: [
            label({ id: 'l-marine', label: 'la Marine', kind: 'alias', precedence: 50 }),
          ],
        }),
        entity({
          id: 'base-153',
          nodeType: 'place',
          labels: [
            label({ id: 'l-base', label: 'la Marine, 153e branche', kind: 'alias', precedence: 50 }),
          ],
        }),
      ],
    })

    const verbose = findings.filter((finding) => finding.kind === 'libelle_verbeux')
    expect(verbose).toHaveLength(1)
    // Écrire « la Marine » ici donnerait deux fiches du même nom : ou un
    // rapprochement, ou deux choses à distinguer, et les deux se choisissent.
    expect(verbose[0]?.fix).toBeNull()
    expect(verbose[0]?.detail).toContain('une autre fiche porte déjà ce nom')
  })

  it('laisse tranquilles les noms que l’œuvre emploie', () => {
    const findings = auditStorySnapshot({
      ...EMPTY,
      entities: [
        entity({
          id: 'vivi',
          labels: [label({ id: 'l-vivi', label: 'Nefertari Vivi', kind: 'true_name', precedence: 100 })],
        }),
        entity({
          id: 'equipage',
          nodeType: 'group',
          labels: [label({ id: 'l-eq', label: 'Équipage du Chapeau de Paille', kind: 'alias', precedence: 50 })],
        }),
        entity({
          id: 'silhouette',
          labels: [label({ id: 'l-sil', label: 'l’homme au foulard rayé' })],
        }),
      ],
    })

    expect(findings).toEqual([])
  })
})
