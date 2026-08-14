import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  addPresence,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { getStoryPage } from '@/domains/temporal/story.ts'

/**
 * La relecture des chapitres 1 à 100.
 *
 * Chaque défaut est reproduit ici sous la forme que la bibliothèque a — deux
 * nœuds pour une personne, un nom écrit de deux façons, un résumé qui dit
 * l'inverse du chapitre, la même scène écrite deux fois, une scène rangée dans
 * le mauvais chapitre, une entrée en scène datée d'après, une question refermée
 * par une scène qui n'y répond pas. Le script est ensuite lancé pour de vrai,
 * et ce sont ses effets qui sont mesurés.
 *
 * Trois d'entre eux sont des spoilers et c'est pourquoi ce fichier est ici
 * plutôt que dans `tests/knowledge` : « Fille au sabre ressemblant à Kuina »
 * devenue Tashigi, la silhouette de Logue Town devenue Dragon, « Homme aux yeux
 * rouges » devenu Mihawk. Replier deux nœuds met leurs libellés dans la même
 * composante, et la fiche affiche le mieux classé — donc une fusion faite sans
 * s'occuper des rangs *avance* un nom de plusieurs chapitres. C'est la faute que
 * la réparation pourrait commettre en corrigeant, et les tests qui portent sur
 * le chapitre 96 sont là pour l'interdire.
 *
 * Un quatrième cas est testé pour ce qu'il ne fait *pas*. La seconde chute de
 * Krieg est racontée deux fois sans que les deux récits partagent leurs mots ;
 * aucune mesure de ressemblance ne les rapproche sans rapprocher aussi deux
 * scènes voisines mais distinctes. Le script les replie parce qu'elles sont
 * nommées une à une, jamais parce qu'elles se ressemblent — et la scène de la
 * chute finale, qui parle des mêmes gens dans le même chapitre, doit survivre.
 */

const exec = promisify(execFile)

let world: SeededWorld
let butler: string
let mihawk: string
let swordGirl: string
let mystery: string
let hatchan: string
let baggy: string

/** Une scène : l'entité, son libellé et sa ligne `events`, comme la publication. */
async function scene(
  chapter: number,
  summary: string,
  nodeType = 'event',
): Promise<string> {
  const id = await createEntity(world, nodeType, chapter)
  await addLabel(world, id, summary.slice(0, 200), 'alias', chapter, 10)
  await addEvent(world, id, { summary, shownIn: chapter })
  return id
}

/** Une question, et la scène qui la referme — quand elle la referme. */
async function question(
  chapter: number,
  text: string,
  closedBy?: { scene: string; chapter: number },
): Promise<string> {
  const id = await createEntity(world, 'mystery', chapter)
  await addLabel(world, id, text.slice(0, 200), 'alias', chapter, 10)
  await addMystery(world, id, {
    question: text,
    openedIn: chapter,
    state: closedBy ? 'resolved' : 'open',
    resolvedIn: closedBy?.chapter ?? null,
  })
  if (closedBy) {
    await addAssertion(world, {
      subject: closedBy.scene,
      predicate: 'resolves_mystery',
      object: id,
      knowledgeFrom: closedBy.chapter,
    })
  }
  return id
}

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld([
    5, 8, 9, 13, 23, 24, 25, 27, 31, 32, 33, 34, 37, 39, 41, 43, 48, 49, 56, 57,
    58, 60, 63, 65, 66, 69, 72, 73, 74, 75, 78, 79, 80, 81, 87, 88, 91, 94, 95,
    96, 97, 98, 99, 100,
  ])

  // --- Deux nœuds pour une personne, pour un bateau, pour une estrade --------
  butler = await createEntity(world, 'character', 24)
  await addLabel(world, butler, 'Merry', 'true_name', 24, 100)
  const secondButler = await createEntity(world, 'character', 27)
  await addLabel(world, secondButler, 'Second majordome de Kaya', 'true_name', 27, 100)

  mihawk = await createEntity(world, 'character', 48)
  await addLabel(world, mihawk, 'Dracule Mihawk', 'true_name', 48, 100)
  const redEyes = await createEntity(world, 'character', 49)
  await addLabel(world, redEyes, 'Homme aux yeux rouges', 'true_name', 49, 100)

  const orbite = await createEntity(world, 'object', 56)
  await addLabel(world, orbite, 'Orbite', 'true_name', 56, 100)
  const hobbit = await createEntity(world, 'object', 56)
  await addLabel(world, hobbit, 'Hobbit', 'true_name', 56, 100)

  const meuh = await createEntity(world, 'character', 73)
  await addLabel(world, meuh, 'Meuh-Meuh', 'true_name', 73, 100)
  const momoo = await createEntity(world, 'character', 74)
  await addLabel(world, momoo, 'Momoo', 'true_name', 74, 100)

  /*
   * La silhouette du 96 et le nom du 97, en deux nœuds.
   *
   * Le nœud anonyme est le plus ancien, et c'est ce qui rend la fusion
   * dangereuse : replier dans Tashigi voudrait dire rejeter la silhouette, donc
   * effacer du chapitre 96 quelqu'un que le lecteur y a rencontré.
   */
  swordGirl = await createEntity(world, 'character', 96)
  await addLabel(world, swordGirl, 'Fille au sabre ressemblant à Kuina', 'true_name', 96, 100)
  const tashigi = await createEntity(world, 'character', 97)
  await addLabel(world, tashigi, 'Tashigi', 'true_name', 97, 100)

  const rogerPlatform = await createEntity(world, 'place', 97)
  await addLabel(world, rogerPlatform, 'Plate-forme d’exécution de Roger', 'true_name', 97, 100)
  const loguePlatform = await createEntity(world, 'place', 99)
  await addLabel(
    world,
    loguePlatform,
    'Plateforme d’exécution de Loguetown',
    'true_name',
    99,
    100,
  )

  const stranger = await createEntity(world, 'character', 100)
  await addLabel(world, stranger, 'Personnage mystérieux de Logue Town', 'true_name', 100, 100)
  const dragon = await createEntity(world, 'character', 100)
  await addLabel(world, dragon, 'Dragon', 'true_name', 100, 100)

  // --- Une question qui parle de quelqu'un sous un nom qui n'existe pas ------
  await question(27, 'Second majordome de Kaya survivra-t-il à ses blessures ?')

  // --- Des résumés qui disent autre chose que le chapitre --------------------
  await scene(56, 'Sanji quitte le Hobbit et rejoint les cuisines du Baratie.')
  await scene(58, 'Zeff a caché toute la nourriture pour lui.')
  await scene(60, 'Don Krieg tire une bombe MH5 sur Luffy, qui se change en bombe-shuriken.')
  await scene(74, 'Luffy, Sanji, Yosaku et Zoro arrivent près d’Arlong Park, portés par Momoo.')
  await scene(88, 'Usopp bat Chew et remporte son combat.')
  await scene(91, 'Luffy brise les dents d’Arlong et se sert d’un homme-poisson comme bouclier.')
  await scene(94, 'Nami récupère son chapeau et son argent.')
  await scene(95, 'Nami rend l’argent volé aux villageois.')
  await scene(100, 'Le Chapitre de paille quitte Logue Town.')

  // --- La même scène écrite deux fois, en se ressemblant ---------------------
  await scene(5, 'Luffy traîne Hermep à l’intérieur de la base et l’utilise comme bouclier humain.')
  await scene(
    5,
    'Luffy traîne Hermep à l’intérieur de la base et l’utilise comme bouclier humain ' +
      'face aux Marines.',
  )
  await scene(43, 'Fullbody place une mouche dans son plat avant d’être corrigé par Sanji.')
  await scene(
    43,
    'Fullbody place une mouche dans son plat avant d’être corrigé par Sanji au Baratie.',
  )
  await scene(65, 'Luffy détruit l’armure de Don Krieg d’un coup de poing.')
  await scene(66, 'Luffy détruit l’armure de Don Krieg.')
  await scene(78, 'Arlong exécute Bell-mère devant Nami et Nojiko.')
  await scene(78, 'Arlong exécute Bell-mère sous les yeux de Nami et Nojiko.')

  /*
   * La même scène écrite deux fois, sans se ressembler.
   *
   * Et, dans le même chapitre, une troisième qui parle des mêmes gens : elle
   * est là pour que le test puisse dire que le script ne l'a pas emportée.
   */
  await scene(
    63,
    'Luffy esquive le canon d’épaule de Don Krieg et le fait tomber d’un coup de pied au cou.',
  )
  await scene(63, 'Don Krieg tombe une seconde fois.')
  await scene(63, 'Don Krieg se relève et repart à l’assaut du Baratie.')

  // --- Des scènes rangées dans le mauvais chapitre ---------------------------
  await scene(81, 'Nezumi confisque l’argent de Nami.')
  await scene(80, 'Nami affronte Arlong dans son bureau.')
  await scene(80, 'Nami frappe son tatouage à coups de dague.')
  await scene(80, 'Nami demande de l’aide à Luffy.')

  // --- Des entrées en scène datées d'après -----------------------------------
  hatchan = await createEntity(world, 'character', 73)
  await addLabel(world, hatchan, 'Hatchan', 'true_name', 73, 100)
  const kuroobi = await createEntity(world, 'character', 75)
  await addLabel(world, kuroobi, 'Kuroobi', 'true_name', 75, 100)
  const chew = await createEntity(world, 'character', 75)
  await addLabel(world, chew, 'Chew', 'true_name', 75, 100)
  const arlongCrew = await createEntity(world, 'group', 72)
  await addLabel(world, arlongCrew, 'Pirates d’Arlong', 'true_name', 72, 100)

  /*
   * Baggy, dont le retour était lu comme une première apparition.
   *
   * La forme est celle de la bibliothèque après la relecture des 1–42 : une
   * mention déclarée au 8, rien au 9, et une apparition déclarée au 98. Le fil
   * ne peut alors dire qu'une chose du chapitre 98 — il entre en scène.
   */
  baggy = await createEntity(world, 'character', 8)
  await addLabel(world, baggy, 'Baggy', 'true_name', 8, 100)
  await addPresence(world, baggy, { chapterNumber: 8, kind: 'mention' })
  await addPresence(world, baggy, { chapterNumber: 98, kind: 'appearance' })

  // --- Les scènes qui répondent, et celles qui ne répondaient pas ------------
  const wrongChouchou = await scene(87, 'Usopp met Chew hors de combat.')
  const wrongShip = await scene(34, 'Kaya soigne Usopp après le combat.')
  const merryGiven = await scene(41, 'L’équipage reçoit enfin le Vogue Merry.')
  const kuroBeaten = await scene(39, 'Kuro est définitivement vaincu et son plan échoue.')
  const wrongPlot = await scene(37, 'Luffy affronte Kuro sur la pente du village.')
  const swordsBack = await scene(33, 'Nami rend les sabres de Zoro à leur propriétaire.')
  const wrongSwords = await scene(32, 'Sham refuse de rendre les sabres et les jette à terre.')
  const wrongZeff = await scene(57, 'Sanji refuse de quitter le Baratie.')
  const wrongPromise = await scene(79, 'Arlong répète sa promesse devant ses hommes.')
  await scene(49, 'Zoro reconnaît en Dracule Mihawk le plus grand épéiste du monde.')

  await question(8, 'Qui est l’homme que Zoro cherche à travers les mers ?')
  mystery = await question(
    13,
    'Pourquoi Luffy, en tant que pirate, a-t-il aidé Chouchou en lui laissant de la nourriture ?',
    { scene: wrongChouchou, chapter: 87 },
  )
  await question(23, 'Kaya offrira-t-elle un navire à l’équipage ?', {
    scene: wrongShip,
    chapter: 34,
  })
  await question(25, 'Où se trouve réellement Yasopp aujourd’hui ?', {
    scene: merryGiven,
    chapter: 41,
  })
  await question(25, 'Que préparent Klahadore et Jango ?', { scene: wrongPlot, chapter: 37 })
  await question(28, 'Le plan de Kuro réussira-t-il ?', { scene: swordsBack, chapter: 33 })
  await question(31, 'Zoro récupérera-t-il ses sabres ?', { scene: wrongSwords, chapter: 32 })
  await question(56, 'Que s’est-il passé entre Sanji et Zeff sur le rocher ?', {
    scene: wrongZeff,
    chapter: 57,
  })
  await question(75, 'Arlong tiendra-t-il sa promesse envers Nami ?', {
    scene: wrongPromise,
    chapter: 79,
  })
  /*
   * Rien ne rattache la question du 56 à une scène : c'est la réécriture du
   * chapitre 58 qui écrit « en mangeant sa propre jambe », et c'est ce texte
   * — produit par ce script, quelques sections plus tôt — que la question va
   * trouver. Deux passes du même script dans le bon ordre, et le test le
   * mesure sans rien préparer.
   */
  void kuroBeaten

  await exec('pnpm', ['repair:chapitres-1-100'], {
    env: { ...process.env, TEST_DB: '1' },
    cwd: process.cwd(),
  })
}, 180_000)

/** Le texte des scènes acceptées d'un chapitre. */
async function summaries(chapter: number): Promise<string[]> {
  const rows = await raw<Array<{ summary: string }>>`
    SELECT e.summary FROM events e JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${world.userId} AND en.review_status = 'accepted'
       AND coalesce(e.shown_in_chapter, e.told_in_chapter) = ${chapter}
     ORDER BY e.summary
  `
  return rows.map((row) => row.summary)
}

describe('deux nœuds pour une personne', () => {
  it('replie le second majordome dans Merry', async () => {
    const sheet = await getEntitySheet(world.userId, 28, butler)
    expect(sheet?.memberIds.length).toBe(2)
    expect(sheet?.displayLabel).toBe('Merry')
  })

  it('fait nommer Merry par la question qui parlait de lui', async () => {
    const [row] = await raw<Array<{ question: string }>>`
      SELECT question FROM mysteries
       WHERE user_id = ${world.userId} AND opened_in_chapter = 27
    `
    expect(row?.question).toBe('Merry survivra-t-il à ses blessures ?')
  })

  it('garde « Dracule Mihawk » pour appeler l’homme aux yeux rouges', async () => {
    const sheet = await getEntitySheet(world.userId, 49, mihawk)
    expect(sheet?.memberIds.length).toBe(2)
    expect(sheet?.displayLabel).toBe('Dracule Mihawk')
  })
})

describe('une fusion ne doit pas avancer un nom', () => {
  it('laisse la silhouette anonyme au chapitre 96', async () => {
    const sheet = await getEntitySheet(world.userId, 96, swordGirl)
    expect(sheet?.displayLabel).toBe('Fille au sabre ressemblant à Kuina')
  })

  it('la nomme Tashigi au chapitre 97, et pas avant', async () => {
    const sheet = await getEntitySheet(world.userId, 97, swordGirl)
    expect(sheet?.displayLabel).toBe('Tashigi')
  })

  it('garde la silhouette du 96 visible : elle n’a pas été rejetée', async () => {
    // Replier dans Tashigi aurait rejeté le nœud le plus ancien, donc effacé du
    // chapitre 96 quelqu'un que le lecteur y rencontre. Le sens de la fusion
    // est vérifié par le script, pas supposé par la table.
    const [row] = await raw<Array<{ review_status: string }>>`
      SELECT review_status FROM entities WHERE id = ${swordGirl}
    `
    expect(row?.review_status).toBe('accepted')
  })
})

describe('un nom écrit de deux façons', () => {
  it('écrit Orbite là où le résumé disait Hobbit', async () => {
    expect(await summaries(56)).toEqual([
      'Sanji quitte le Orbite et rejoint les cuisines du Baratie.',
    ])
  })

  it('garde « Hobbit » trouvable, et jamais affiché', async () => {
    const [row] = await raw<Array<{ precedence: number }>>`
      SELECT precedence FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Hobbit'
    `
    expect(row?.precedence).toBe(5)
  })

  it('n’appelle plus le monstre marin Momoo', async () => {
    const [row] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM events
       WHERE user_id = ${world.userId} AND summary ~ '\\yMomoo\\y'
    `
    expect(row?.n).toBe('0')
  })
})

describe('un résumé qui dit autre chose que le chapitre', () => {
  it('dit que Zeff a tout donné, et non tout caché', async () => {
    expect(await summaries(58)).toContain(
      'Sanji découvre que Zeff lui avait donné toute la nourriture disponible. ' +
        'Le sac que Zeff avait gardé ne contenait que des trésors, et celui-ci a ' +
        'survécu en mangeant sa propre jambe.',
    )
  })

  it('rend le chapeau de paille à Luffy', async () => {
    expect(await summaries(94)).toEqual([
      'Nami rend son chapeau de paille à Luffy et récupère l’argent confisqué par Nezumi.',
    ])
  })

  it('écrit l’équipage là où le texte disait « le Chapitre de paille »', async () => {
    expect((await summaries(100))[0]).toMatch(/^L’Équipage du Chapeau de paille quitte/)
  })

  it('laisse Zoro rejoindre les autres par ses propres moyens', async () => {
    expect(await summaries(74)).toEqual([
      'Luffy, Sanji et Yosaku arrivent près d’Arlong Park après avoir été transportés ' +
        'par Meuh-Meuh, tandis que Zoro rejoint les autres séparément.',
    ])
  })
})

describe('la même scène écrite deux fois', () => {
  it('n’en garde qu’une au chapitre 5, la plus complète', async () => {
    const kept = await summaries(5)
    expect(kept.length).toBe(1)
    expect(kept[0]).toMatch(/face aux Marines/)
  })

  it('n’en garde qu’une au chapitre 43 et une au 78', async () => {
    expect((await summaries(43)).length).toBe(1)
    expect((await summaries(78)).length).toBe(1)
  })

  it('garde l’armure détruite au 65 et retire sa répétition du 66', async () => {
    expect((await summaries(65)).length).toBe(1)
    expect(await summaries(66)).toEqual([])
  })
})

describe('deux récits qui ne se ressemblent pas', () => {
  it('garde le récit détaillé de la chute de Krieg et replie le résumé', async () => {
    const kept = await summaries(63)
    expect(kept).toContain(
      'Luffy esquive le canon d’épaule de Don Krieg et le fait tomber d’un coup de pied au cou.',
    )
    expect(kept).not.toContain('Don Krieg tombe une seconde fois.')
  })

  it('ne touche pas à la scène voisine qui parle des mêmes gens', async () => {
    // Le garde-fou de tout ce fichier : les scènes sont repliées parce qu'elles
    // sont nommées une à une, jamais parce qu'un seuil les a trouvées proches.
    expect(await summaries(63)).toContain('Don Krieg se relève et repart à l’assaut du Baratie.')
  })
})

describe('une scène rangée dans le mauvais chapitre', () => {
  it('rend le vol de Nezumi au chapitre 80', async () => {
    expect(await summaries(80)).toEqual(['Nezumi confisque l’argent de Nami.'])
  })

  it('donne au chapitre 81 la confrontation, le tatouage et l’appel à Luffy', async () => {
    expect((await summaries(81)).length).toBe(3)
  })

  it('fait suivre le libellé, sans quoi la scène s’afficherait sans nom', async () => {
    const [row] = await raw<Array<{ revealed_in_chapter: number }>>`
      SELECT l.revealed_in_chapter
        FROM entity_labels l JOIN events e ON e.entity_id = l.entity_id
       WHERE l.user_id = ${world.userId} AND e.summary = 'Nami frappe son tatouage à coups de dague.'
    `
    expect(row?.revealed_in_chapter).toBe(81)
  })
})

describe('une entrée en scène datée d’après', () => {
  it('fait entrer Hatchan au chapitre 69', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 69,
      count: 1,
      ceiling: 100,
    })
    const entrance = page.beats.find(
      (beat) => beat.kind === 'entree' && beat.text === 'Hatchan',
    )
    expect(entrance?.chapter).toBe(69)
  })

  it('déplace le nom avec le corps, faute d’une autre date pour lui', async () => {
    const [row] = await raw<Array<{ revealed_in_chapter: number }>>`
      SELECT revealed_in_chapter FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Hatchan'
    `
    expect(row?.revealed_in_chapter).toBe(69)
    const [entity] = await raw<Array<{ first_seen_chapter: number }>>`
      SELECT first_seen_chapter FROM entities WHERE id = ${hatchan}
    `
    expect(entity?.first_seen_chapter).toBe(69)
  })

  it('fait entrer les trois hommes-poissons et l’équipage au 69', async () => {
    const rows = await raw<Array<{ first_seen_chapter: number }>>`
      SELECT en.first_seen_chapter
        FROM entities en JOIN entity_labels l ON l.entity_id = en.id
       WHERE l.user_id = ${world.userId}
         AND l.label IN ('Hatchan', 'Kuroobi', 'Chew', 'Pirates d’Arlong')
    `
    expect(rows.map((row) => row.first_seen_chapter)).toEqual([69, 69, 69, 69])
  })

  it('fait entrer Baggy au chapitre 9', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 9,
      count: 1,
      ceiling: 100,
    })
    expect(
      page.beats.some((beat) => beat.kind === 'entree' && beat.text === 'Baggy'),
    ).toBe(true)
  })

  it('ne le fait pas entrer une seconde fois au 98', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 98,
      count: 1,
      ceiling: 100,
    })
    expect(
      page.beats.some((beat) => beat.kind === 'entree' && beat.text === 'Baggy'),
    ).toBe(false)
    // Et le nœud n'a pas bougé : il est bien connu depuis le chapitre 8.
    const [row] = await raw<Array<{ first_seen_chapter: number }>>`
      SELECT first_seen_chapter FROM entities WHERE id = ${baggy}
    `
    expect(row?.first_seen_chapter).toBe(8)
  })
})

describe('une question refermée par la mauvaise scène', () => {
  it('rouvre celle sur Chouchou, que rien ne refermait', async () => {
    const [row] = await raw<Array<{ state: string; resolved_in_chapter: number | null }>>`
      SELECT state::text AS state, resolved_in_chapter FROM mysteries
       WHERE entity_id = ${mystery}
    `
    expect(row?.state).toBe('open')
    expect(row?.resolved_in_chapter).toBeNull()
  })

  it('rejette le lien fautif sans le supprimer', async () => {
    const [row] = await raw<Array<{ review_status: string }>>`
      SELECT review_status FROM assertions
       WHERE predicate = 'resolves_mystery' AND object_entity_id = ${mystery}
    `
    expect(row?.review_status).toBe('rejected')
  })

  it('laisse ouverte celle sur Yasopp, que le chapitre 41 ne tranche pas', async () => {
    const [row] = await raw<Array<{ resolved_in_chapter: number | null }>>`
      SELECT resolved_in_chapter FROM mysteries
       WHERE user_id = ${world.userId} AND question LIKE 'Où se trouve réellement Yasopp%'
    `
    expect(row?.resolved_in_chapter).toBeNull()
  })

  it('déplace les réponses au chapitre qui les donne', async () => {
    const rows = await raw<Array<{ opened_in_chapter: number; resolved_in_chapter: number }>>`
      SELECT opened_in_chapter, resolved_in_chapter FROM mysteries
       WHERE user_id = ${world.userId} AND opened_in_chapter IN (23, 28, 31, 56, 75)
       ORDER BY opened_in_chapter
    `
    expect(rows).toEqual([
      { opened_in_chapter: 23, resolved_in_chapter: 41 },
      { opened_in_chapter: 28, resolved_in_chapter: 39 },
      { opened_in_chapter: 31, resolved_in_chapter: 33 },
      { opened_in_chapter: 56, resolved_in_chapter: 58 },
      { opened_in_chapter: 75, resolved_in_chapter: 81 },
    ])
  })

  it('referme enfin celle du chapitre 8 sur l’homme que Zoro cherche', async () => {
    const [row] = await raw<Array<{ resolved_in_chapter: number; summary: string }>>`
      SELECT m.resolved_in_chapter, e.summary
        FROM mysteries m
        JOIN assertions a ON a.object_entity_id = m.entity_id
             AND a.predicate = 'resolves_mystery' AND a.review_status = 'accepted'
        JOIN events e ON e.entity_id = a.subject_entity_id
       WHERE m.user_id = ${world.userId} AND m.opened_in_chapter = 8
    `
    expect(row?.resolved_in_chapter).toBe(49)
    expect(row?.summary).toMatch(/Mihawk/)
  })

  it('date la réponse du chapitre qui la donne, pas de celui qui la pose', async () => {
    // Ce qui protège le lecteur : une résolution datée du 58 est invisible tant
    // qu'il n'y est pas, et la question du 56 reste une question.
    const [row] = await raw<Array<{ knowledge_from_chapter: number }>>`
      SELECT a.knowledge_from_chapter
        FROM assertions a JOIN mysteries m ON m.entity_id = a.object_entity_id
       WHERE a.predicate = 'resolves_mystery' AND a.review_status = 'accepted'
         AND m.opened_in_chapter = 56
    `
    expect(row?.knowledge_from_chapter).toBe(58)
  })
})

describe('rejouable', () => {
  it('n’écrit rien la seconde fois', async () => {
    const { stdout } = await exec('pnpm', ['repair:chapitres-1-100'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })
    expect(stdout).toMatch(/Rien à corriger\./)
  }, 180_000)
})
