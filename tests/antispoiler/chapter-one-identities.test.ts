import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addAssertion,
  addEvent,
  addLabel,
  addPortrait,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { getNarrativeDelta } from '@/domains/temporal/timeline.ts'
import { displayLabel } from '@/domains/temporal/projection.ts'

/**
 * Apparaître n'est pas être nommé.
 *
 * Le chapitre 1 de One Piece montre trois pirates de l'équipage du Roux sans
 * en nommer un seul. Deux d'entre eux ne sont nommés que dans le SBS du tome 5,
 * que le lecteur atteint au chapitre 42 ; le troisième au chapitre 25 ; le
 * maire du village, jamais — son nom vient d'un databook, et cette
 * bibliothèque ne rattache les databooks à aucun chapitre.
 *
 * Le graphe savait déjà dater un nom. Ce qu'il ne savait pas, c'est qu'un nom
 * puisse n'avoir aucune date du tout, et le seul moyen de ranger un tel nom
 * était de lui en inventer une. Ces tests portent sur les deux moitiés de la
 * réparation : la règle, ci-dessous, et son application au chapitre 1, plus
 * bas, en lançant le script sur une bibliothèque qui porte le défaut.
 */

const exec = promisify(execFile)

describe('un nom qu’aucun chapitre ne donne', () => {
  let world: SeededWorld
  let mayor: string

  beforeAll(async () => {
    await resetDatabase()
    world = await seedWorld([1, 25, 42])

    mayor = await createEntity(world, 'character', 1)
    await addLabel(world, mayor, 'Maire du village de Fuchsia', 'placeholder', 1, 10)
    await addLabel(
      world,
      mayor,
      'Woop Slap',
      'true_name',
      null,
      100,
      'databook officiel — hors de la chronologie des chapitres',
    )
  })

  it('n’est affiché à aucune frontière, pas même au-delà de la bibliothèque', async () => {
    for (const boundary of [1, 42, 1000]) {
      const shown = await displayLabel(world.userId, boundary, mayor)
      expect(shown?.label).toBe('Maire du village de Fuchsia')
    }
  })

  it('est retenu par la politique et non par le code qui la lit', async () => {
    /*
     * Lu à travers `withBoundary`, donc par le rôle `authenticated` et sa
     * politique. Un test qui n'interrogerait que `displayLabel` passerait aussi
     * bien si la règle était un `ORDER BY` bien choisi — et un `ORDER BY` ne
     * protège pas la requête que quelqu'un écrira dans six mois.
     */
    const sheet = await getEntitySheet(world.userId, 1000, mayor)
    expect(sheet?.displayLabel).toBe('Maire du village de Fuchsia')
    expect(sheet?.labels.map((label) => label.label)).not.toContain('Woop Slap')
  })

  it('reste dans la table : rien n’est supprimé pour être caché', async () => {
    const rows = await raw<Array<{ label: string; reveal_source: string | null }>>`
      SELECT label, reveal_source FROM entity_labels
       WHERE entity_id = ${mayor} AND revealed_in_chapter IS NULL
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('Woop Slap')
    expect(rows[0]!.reveal_source).toMatch(/databook/)
  })

  it('doit dire d’où il vient : la base refuse un nom sans date et sans source', async () => {
    await expect(
      raw`
        INSERT INTO entity_labels
          (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
        VALUES (${mayor}, ${world.userId}, 'Sans provenance', 'sans provenance',
                'true_name', NULL, 100)
      `,
    ).rejects.toThrow(/entity_labels_unrevealed_needs_source/)
  })
})

describe('un nom donné par le SBS, à la date où le lecteur l’ouvre', () => {
  let world: SeededWorld
  let roux: string

  beforeAll(async () => {
    await resetDatabase()
    world = await seedWorld([1, 42])

    // Il entre en scène au 1 — c'est le corps —, il se nomme au 42.
    roux = await createEntity(world, 'character', 1)
    await addLabel(world, roux, 'Pirate corpulent mangeant de la viande', 'placeholder', 1, 10)
    await addLabel(world, roux, 'Lucky Roux', 'true_name', 42, 100, 'SBS du tome 5')
  })

  it('tient la désignation descriptive au chapitre 1', async () => {
    const shown = await displayLabel(world.userId, 1, roux)
    expect(shown?.label).toBe('Pirate corpulent mangeant de la viande')
    expect(shown?.kind).toBe('placeholder')
  })

  it('donne le nom au chapitre 42, avec sa provenance', async () => {
    const sheet = await getEntitySheet(world.userId, 42, roux)
    expect(sheet?.displayLabel).toBe('Lucky Roux')
    expect(sheet?.labels.find((l) => l.label === 'Lucky Roux')?.revealSource).toBe(
      'SBS du tome 5',
    )
  })

  it('le compte parmi les entrées en scène du chapitre 1, sous sa description', async () => {
    /*
     * Les deux dates, vues par la page qui les mélangeait. « Ce qu'apporte le
     * chapitre 1 » liste les entités dont c'est la première apparition : il doit
     * y être, et il doit y être anonyme. C'est exactement le point où le défaut
     * se voyait — soit le pirate manquait au chapitre 1, soit il y figurait sous
     * un nom lu quarante et un chapitres plus tard.
     */
    const delta = await getNarrativeDelta(world.userId, 1)
    const labels = delta?.newEntities.map((entity) => entity.label) ?? []
    expect(labels).toContain('Pirate corpulent mangeant de la viande')
    expect(labels).not.toContain('Lucky Roux')

    // Et le nom est annoncé au 42, où il arrive, et nulle part avant.
    const later = await getNarrativeDelta(world.userId, 42)
    expect(later?.newNames.map((name) => name.label)).toContain('Lucky Roux')
  })
})

describe('la relecture du chapitre 1, appliquée', () => {
  let world: SeededWorld
  let crew: string
  let mayor: string
  let beckman: string

  beforeAll(async () => {
    await resetDatabase()
    world = await seedWorld([1, 25, 42])

    const shanks = await createEntity(world, 'character', 1)
    await addLabel(world, shanks, 'Shanks', 'true_name', 1, 100)

    crew = await createEntity(world, 'group', 1)
    await addLabel(world, crew, 'Équipage du Roux', 'alias', 1, 50)
    await addAssertion(world, {
      subject: shanks,
      predicate: 'leads',
      object: crew,
      knowledgeFrom: 1,
    })

    /*
     * La bibliothèque telle que la publication l'avait laissée : les deux
     * pirates portent leur nom dès le chapitre 1, Yasopp n'existe pas, et le
     * maire est rangé sous le nom d'un databook.
     */
    const roux = await createEntity(world, 'character', 1)
    await addLabel(world, roux, 'Lucky Roux', 'true_name', 1, 100)
    // Un portrait rapproché par ce nom, à l'époque où il était daté du 1.
    await addPortrait(world, roux, { matchedLabel: 'Lucky Roux', revealedIn: 1 })

    /*
     * Beckman en deux nœuds joints par une identité — la forme que la
     * bibliothèque a réellement, et celle qui a fait rater la correction.
     *
     * Le nom va délibérément sur le nœud de plus **grand** identifiant. Les
     * uuid sont tirés au hasard, donc laisser l'ordre décider ferait passer ce
     * test une fois sur deux — ce qui est exactement ce qui est arrivé : vert
     * ici, rouge en CI, sur un défaut bien réel. Le cas défavorable est donc
     * construit, pas espéré.
     */
    const pair = [
      await createEntity(world, 'character', 1),
      await createEntity(world, 'character', 1),
    ].sort()
    beckman = pair[0]!
    await addLabel(world, beckman, 'Ben Beckman', 'alias', 1, 5)
    await addLabel(world, pair[1]!, 'Benn Beckman', 'true_name', 1, 100)
    await addAssertion(world, {
      subject: beckman,
      predicate: 'same_as',
      object: pair[1]!,
      knowledgeFrom: 1,
      epistemic: 'user_validated',
      proposedBy: 'user',
      locked: true,
    })

    mayor = await createEntity(world, 'character', 1)
    await addLabel(world, mayor, 'Hoop Slap', 'true_name', 1, 100)

    for (const name of ['Makino', 'Higuma', 'Monkey D. Luffy', 'Gold Roger']) {
      const id = await createEntity(world, 'character', 1)
      await addLabel(world, id, name, 'true_name', 1, 100)
    }

    const scene = await createEntity(world, 'event', 1)
    await addLabel(world, scene, 'Beckman neutralise seul la bande d’Higuma.', 'alias', 1, 10)
    await addEvent(world, scene, {
      summary: 'Beckman neutralise seul la bande d’Higuma.',
      shownIn: 1,
    })

    await exec('pnpm', ['repair:chapitre-1'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })
  }, 120_000)

  it('rend les deux pirates anonymes au chapitre 1 et nommés au 42', async () => {
    /*
     * Lu par la fiche, pas par `displayLabel`.
     *
     * La distinction a coûté une CI rouge et vaut d'être écrite ici. Une
     * personne rangée en deux nœuds n'a pas ses libellés sur les deux : la
     * désignation descriptive est posée une fois, sinon « Noms connus » la
     * lirait en double. `displayLabel` interroge *une* entité et répond donc
     * « rien » sur la moitié qui ne la porte pas — ce que le lecteur ne voit
     * jamais, parce que toute vue passe par la composante. Assertion sur ce que
     * le lecteur voit, donc, et pas sur une brique interne.
     */
    for (const [before, after] of [
      ['Pirate corpulent mangeant de la viande', 'Lucky Roux'],
      ['Pirate aux cheveux noirs de l’équipage de Shanks', 'Benn Beckman'],
    ]) {
      const [row] = await raw<Array<{ entity_id: string }>>`
        SELECT entity_id FROM entity_labels
         WHERE user_id = ${world.userId} AND label = ${after!}
      `
      expect(row, after).toBeDefined()

      for (const boundary of [1, 41]) {
        const sheet = await getEntitySheet(world.userId, boundary, row!.entity_id)
        expect(sheet?.displayLabel, `${after} au ch${boundary}`).toBe(before)
      }
      const named = await getEntitySheet(world.userId, 42, row!.entity_id)
      expect(named?.displayLabel).toBe(after)
    }
  })

  it('déplace aussi les autres graphies, sans les promouvoir', async () => {
    // « Ben Beckman » au chapitre 1 rendrait la correction inutile : le nom
    // s'afficherait sous son autre forme. Redatée, donc — et laissée à la
    // précédence que la publication lui avait donnée.
    const [row] = await raw<Array<{ revealed_in_chapter: number; precedence: number }>>`
      SELECT revealed_in_chapter, precedence FROM entity_labels
       WHERE entity_id = ${beckman} AND label = 'Ben Beckman'
    `
    expect(row?.revealed_in_chapter).toBe(42)
    expect(row?.precedence).toBe(5)
  })

  it('fait entrer Yasopp au chapitre 1 sans le nommer avant le 25', async () => {
    const [row] = await raw<Array<{ entity_id: string; first_seen_chapter: number }>>`
      SELECT l.entity_id, e.first_seen_chapter
        FROM entity_labels l JOIN entities e ON e.id = l.entity_id
       WHERE l.user_id = ${world.userId} AND l.label = 'Yasopp'
    `
    expect(row?.first_seen_chapter).toBe(1)
    expect((await displayLabel(world.userId, 1, row!.entity_id))?.label).toBe(
      'Pirate au bandeau de l’équipage de Shanks',
    )
    expect((await displayLabel(world.userId, 25, row!.entity_id))?.label).toBe('Yasopp')
  })

  it('laisse le maire sous sa fonction, à tous les chapitres', async () => {
    for (const boundary of [1, 25, 42]) {
      expect((await displayLabel(world.userId, boundary, mayor))?.label).toBe(
        'Maire du village de Fuchsia',
      )
    }
  })

  it('donne l’appartenance à l’équipage à la date où elle se lit', async () => {
    /*
     * Le nom cherché sur la composante du sujet, pas sur son seul nœud : la
     * relation est écrite sur le nœud qui porte le nom, mais rien ne garantit
     * que ce soit celui-là dans une bibliothèque déjà fusionnée, et un test qui
     * en dépendrait mesurerait un tri d'identifiants.
     */
    const rows = await raw<Array<{ label: string; knowledge_from_chapter: number }>>`
      WITH RECURSIVE component(root, id) AS (
        SELECT a.subject_entity_id, a.subject_entity_id
          FROM assertions a
         WHERE a.user_id = ${world.userId} AND a.predicate = 'member_of'
           AND a.object_entity_id = ${crew} AND a.review_status = 'accepted'
        UNION
        SELECT c.root,
               CASE WHEN s.subject_entity_id = c.id
                    THEN s.object_entity_id ELSE s.subject_entity_id END
          FROM assertions s JOIN component c
            ON c.id IN (s.subject_entity_id, s.object_entity_id)
         WHERE s.predicate = 'same_as' AND s.review_status = 'accepted'
           AND s.object_entity_id IS NOT NULL
      )
      SELECT (SELECT l.label FROM entity_labels l
               WHERE l.entity_id IN (SELECT id FROM component WHERE root = a.subject_entity_id)
                 AND l.kind = 'true_name'
               ORDER BY l.precedence DESC LIMIT 1) AS label,
             a.knowledge_from_chapter
        FROM assertions a
       WHERE a.user_id = ${world.userId} AND a.predicate = 'member_of'
         AND a.object_entity_id = ${crew} AND a.review_status = 'accepted'
    `
    const byName = new Map(rows.map((row) => [row.label, row.knowledge_from_chapter]))
    // Les deux pirates du chapitre 1 sont debout au milieu de l'équipage : leur
    // appartenance est sur la page même si leur nom n'y est pas.
    expect(byName.get('Lucky Roux')).toBe(1)
    expect(byName.get('Benn Beckman')).toBe(1)
    // Celle de Yasopp n'est établie qu'au 25, et rien ne l'annonce plus tôt.
    expect(byName.get('Yasopp')).toBe(25)
  })

  it('réécrit la scène qui nommait, et ajoute celle qui manquait', async () => {
    const summaries = (
      await raw<Array<{ summary: string }>>`
        SELECT summary FROM events
         WHERE user_id = ${world.userId} AND shown_in_chapter = 1
      `
    ).map((row) => row.summary)

    expect(summaries).toContain(
      'Un pirate aux cheveux noirs de l’équipage de Shanks neutralise presque ' +
        'toute la bande d’Higuma.',
    )
    expect(summaries).toContain(
      'Un pirate corpulent de l’équipage de Shanks abat l’un des bandits ' +
        'd’Higuma d’un coup de pistolet.',
    )
    expect(summaries.join(' ')).not.toMatch(/Beckman/)
  })

  it('ne touche pas aux cinq que le chapitre nomme lui-même', async () => {
    const shown = await Promise.all(
      ['Makino', 'Shanks', 'Higuma', 'Monkey D. Luffy', 'Gold Roger'].map(async (name) => {
        const [row] = await raw<Array<{ entity_id: string }>>`
          SELECT entity_id FROM entity_labels
           WHERE user_id = ${world.userId} AND label = ${name}
        `
        return (await displayLabel(world.userId, 1, row!.entity_id))?.label
      }),
    )
    expect(shown).toEqual(['Makino', 'Shanks', 'Higuma', 'Monkey D. Luffy', 'Gold Roger'])
  })

  it('corrige les deux moitiés d’une personne rangée en deux nœuds', async () => {
    /*
     * La fiche lit la composante d'identité entière et affiche le meilleur
     * libellé qu'elle y trouve — c'est ce qui fait qu'un personnage fusionné
     * s'affiche sous son vrai nom plutôt que sous la silhouette qui a trié
     * première. Le revers : il suffit d'une moitié laissée en arrière pour que
     * le nom du futur revienne, et la fiche est alors exactement aussi fausse
     * qu'avant la correction, à un `LIMIT 1` près.
     */
    const [row] = await raw<Array<{ entity_id: string }>>`
      SELECT entity_id FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Benn Beckman'
    `
    const sheet = await getEntitySheet(world.userId, 1, row!.entity_id)
    expect(sheet?.memberIds.length).toBeGreaterThan(1)
    expect(sheet?.displayLabel).toBe('Pirate aux cheveux noirs de l’équipage de Shanks')
    expect(sheet?.labels.map((label) => label.label)).not.toContain('Benn Beckman')

    /*
     * Et une seule fois chacun, au chapitre où tout est lisible. Corriger deux
     * nœuds, c'est écrire deux fois — le nom sur chaque moitié, la désignation
     * sur chaque moitié — et « Noms connus » liste la composante entière.
     */
    const whole = await getEntitySheet(world.userId, 42, row!.entity_id)
    const names = whole?.labels.map((label) => label.label) ?? []
    expect(names.filter((name) => name === 'Benn Beckman')).toHaveLength(1)
    expect(
      names.filter((name) => name === 'Pirate aux cheveux noirs de l’équipage de Shanks'),
    ).toHaveLength(1)
  })

  it('fait suivre le portrait trouvé par le nom', async () => {
    /*
     * Une illustration porte la révélation du *libellé qui l'a trouvée* — voir
     * la migration 0012 —, et ce libellé vient de bouger. Le visage rapproché
     * par « Lucky Roux » alors que ce nom était daté du chapitre 1 y serait
     * resté : la fiche du chapitre 1 dirait « Pirate corpulent mangeant de la
     * viande » au-dessus d'une image que seul le nom du tome 5 a su trouver.
     */
    const rows = await raw<Array<{ matched_label: string; revealed_in_chapter: number }>>`
      SELECT matched_label, revealed_in_chapter FROM entity_images
       WHERE user_id = ${world.userId}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.matched_label).toBe('Lucky Roux')
    expect(rows[0]!.revealed_in_chapter).toBe(42)
  })

  it('est rejouable : une seconde exécution n’écrit rien', async () => {
    const before = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM events WHERE user_id = ${world.userId}
    `
    const { stdout } = await exec('pnpm', ['repair:chapitre-1'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })
    const after = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM events WHERE user_id = ${world.userId}
    `

    expect(after[0]!.n).toBe(before[0]!.n)
    expect(stdout).toMatch(/Rien à corriger\./)
  }, 120_000)
})
