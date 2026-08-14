/**
 * Les détails relevés en relisant le fil, une fois le chapitre 1 remis d'aplomb.
 *
 *   pnpm repair:details -- --dry-run     # dit tout, n'écrit rien
 *   pnpm repair:details                  # applique
 *   TEST_DB=1 pnpm repair:details        # base de test
 *
 * Cinq sortes de corrections. Elles ont l'air disparates et elles ne le sont
 * pas : chacune est un endroit où la donnée dit autre chose que le manga, et
 * quatre des cinq sont le même défaut vu de quatre côtés.
 *
 *   1. Un nom que le lecteur n'a pas encore lu, dans la prose. « Kuro » est
 *      écrit dans les questions des chapitres 24 et 25 alors que le majordome
 *      s'appelle Klahadore jusqu'au 26 — c'est la relecture des chapitres 1 à
 *      42 qui l'a manqué, parce qu'elle réécrivait les résumés d'événements et
 *      jamais les questions. Le même correctif, sur la table qu'il oubliait.
 *
 *   2. Un nom écrit de deux façons. « Buggy » au chapitre 19 pour le Baggy de
 *      partout ailleurs, « Piiman » au 36 pour le Piment du 23. Ni l'un ni
 *      l'autre n'est une révélation : c'est la graphie de la source restée dans
 *      une phrase française.
 *
 *   3. Une entrée en scène datée de bien après. Zoro est nommé au chapitre 2 et
 *      dessiné au 3 ; le fil le fait entrer au 21, parce que c'est le premier
 *      chapitre dont l'extraction ait *déclaré* qu'il était sur la page. Les
 *      chapitres d'avant ne déclarent rien — ils sont antérieurs au champ — et
 *      le fil lit à juste titre cette absence comme une absence de réponse.
 *      Donc la réponse, à la main, comme pour la mention du chapitre 2.
 *
 *   4. Une personne rangée en plusieurs nœuds. « Zeff aux Pieds Rouges » et
 *      « Zeff aux Pieds rouges » sont le surnom de Zeff, l'un rangé en
 *      personnage et l'autre en concept.
 *
 *   5. Ce qu'un nœud est. Sham et Buchi sont deux personnages rangés en
 *      groupes ; le groupe, ce sont les Nyaban Brothers, et il existe déjà.
 *
 * Et une correction qui n'est pas dans cette liste parce qu'elle a d'abord été
 * écrite de travers, ce qui vaut d'être dit ici plutôt qu'oublié. « Soro » est
 * un nœud du chapitre 3 que la ressemblance des deux mots faisait prendre pour
 * Zoro mal transcrit ; il allait être replié dans Zoro. C'est Sorrow, le loup
 * d'Hermep — celui que Zoro tue et pour lequel il est arrêté. La fusion aurait
 * donc rangé un animal dans un personnage, irréversiblement du point de vue du
 * lecteur, et la fiche de Zoro aurait porté les faits du loup.
 *
 * Ce que ce nœud demande n'est pas une fusion mais une orthographe, et le dépôt
 * a déjà l'outil : `renameEntityLabel` corrige le mot, garde l'ancien trouvable
 * par la recherche, enregistre la correction au glossaire pour les chapitres
 * suivants et réécrit les phrases qui l'épellent. Une fusion n'est jamais la
 * réparation d'une ressemblance de noms — c'est une affirmation sur ce que deux
 * nœuds sont, et elle se vérifie ailleurs que dans l'orthographe.
 *
 * Rien n'est supprimé. Une entité en double est rejointe à sa jumelle par une
 * relation d'identité datée du chapitre — le mécanisme que le dépôt emploie
 * déjà pour les fusions — et reste donc lisible et défaisable.
 *
 * Une fusion déplace un libellé dans une composante, et la fiche affiche le
 * mieux classé de la composante : rejoindre « Soro » à Zoro sans rien d'autre
 * ferait afficher « Soro ». Les reclassements de la section 4 bis sont donc
 * indissociables des fusions et se lisent avec elles.
 *
 * Rejouable. Chaque opération vérifie d'abord si elle a déjà eu lieu.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'

const dryRun = process.argv.includes('--dry-run')
const testDb = process.env.TEST_DB === '1'
const url = testDb
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error(
    'Aucune connexion. Lancez avec TEST_DB=1 pour la base locale, ou renseignez DIRECT_URL.',
  )
  process.exit(1)
}

/**
 * Un mot pour un autre, dans la prose des résumés **et des questions**.
 *
 * `first`/`last` bornent ce qui est une révélation ; `Kuro` n'est prématuré
 * qu'entre 23 et 25, et le remplacer partout effacerait la révélation elle-même
 * au chapitre 26. Une graphie fautive, elle, n'a pas de date : « Buggy » et
 * « Piiman » sont faux partout, donc sans borne.
 */
const TERMS: ReadonlyArray<{
  from: string
  to: string
  first?: number
  last?: number
  why: string
}> = [
  {
    from: 'Kuro',
    to: 'Klahadore',
    first: 23,
    last: 25,
    why: 'le majordome s’appelle Klahadore jusqu’au 26',
  },
  { from: 'Buggy', to: 'Baggy', why: 'graphie de la source' },
  { from: 'Piiman', to: 'Piment', why: 'graphie de la source' },
]

/**
 * Vu, ou seulement nommé — là où la donnée ne peut pas répondre seule.
 *
 * Le pendant exact de « Zoro mentionné au chapitre 2 », écrit à la main par la
 * relecture précédente : celle-là disait qu'il n'était pas encore sur la page,
 * celle-ci dit à quel chapitre il y arrive.
 */
const PRESENCE: ReadonlyArray<{ label: string; chapter: number; kind: 'appearance' }> = [
  { label: 'Roronoa Zoro', chapter: 3, kind: 'appearance' },
]

/**
 * Deux nœuds pour une personne, nommément.
 *
 * Nommément, et pas par ressemblance : c'est la leçon de « Soro ». Ces deux-ci
 * tiennent parce que le texte des chapitres le dit — le 47 fait reconnaître
 * « Zeff aux Pieds Rouges » *en* Zeff, et le 48 raconte l'histoire de Zeff
 * « surnommé aux pieds rouges ». Ce sont les phrases qui l'établissent, pas
 * l'air de famille des libellés.
 */
const MERGES: ReadonlyArray<{ keep: string; drop: string; chapter: number }> = [
  { keep: 'Zeff', drop: 'Zeff aux Pieds Rouges', chapter: 47 },
  { keep: 'Zeff', drop: 'Zeff aux Pieds rouges', chapter: 48 },
]

/**
 * Un nom mal orthographié, corrigé sans rien fusionner.
 *
 * `renameEntityLabel` est ce que fait le bouton « Renommer » de la fiche, et il
 * fait plus qu'écrire un mot : il garde l'ancienne graphie trouvable par la
 * recherche — c'est par elle que les catalogues d'illustrations retrouvent un
 * personnage —, enregistre la correction au glossaire pour que les chapitres
 * suivants ne reposent pas la question, et réécrit les résumés et les questions
 * qui l'épellent en toutes lettres. Le chapitre de révélation ne bouge pas :
 * c'est le même nom, mieux écrit.
 */
const RENAMES: ReadonlyArray<{ from: string; to: string; why: string }> = [
  { from: 'Soro', to: 'Sorrow', why: 'le loup d’Hermep, au chapitre 3' },
]

/**
 * Ce qu'un libellé est, une fois la fusion faite.
 *
 * Sans ça, une fusion se retourne contre elle-même. Les deux libellés d'une
 * composante se disputent l'affichage à la précédence, et « Zeff aux Pieds
 * Rouges » — enregistré comme un vrai nom au chapitre 47 — battrait « Zeff »
 * révélé au 43. La fusion aurait donc pour effet visible de remplacer le nom
 * par le surnom.
 *
 * « Yassop » n'a rien à voir avec une fusion et se répare pareil : c'est la
 * graphie que la source emploie, gardée pour que les catalogues d'illustrations
 * retrouvent le personnage, et le fil l'annonçait comme une seconde révélation
 * au chapitre 25 — deux fois le même nom, à une lettre près.
 */
const RECLASSIFY: ReadonlyArray<{
  label: string
  kind: string
  precedence: number
  why: string
}> = [
  { label: 'Yassop', kind: 'alias', precedence: 5, why: 'graphie de la source' },
  {
    label: 'Zeff aux Pieds Rouges',
    kind: 'epithet',
    precedence: 70,
    why: 'un surnom, pas le nom',
  },
  {
    label: 'Zeff aux Pieds rouges',
    kind: 'epithet',
    precedence: 70,
    why: 'un surnom, pas le nom',
  },
]

/** Ce que la source montre comme un personnage et que le graphe range en groupe. */
const RETYPES: ReadonlyArray<{ label: string; to: string }> = [
  { label: 'Sham', to: 'character' },
  { label: 'Buchi', to: 'character' },
]

const NOTE =
  'Relecture du fil : détails relevés chapitre par chapitre, ' +
  'voir scripts/repair-details.ts.'

interface Work {
  id: string
  user_id: string
}

interface Counters {
  [key: string]: number
}

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  const done: Counters = {}
  const bump = (key: string, by = 1): number => (done[key] = (done[key] ?? 0) + by)

  try {
    const [work] = await sql<Work[]>`
      SELECT id, user_id FROM works ORDER BY created_at LIMIT 1
    `
    if (!work) {
      console.log('Aucune œuvre dans cette base : rien à réparer.')
      return
    }

    console.log(dryRun ? '— dry-run : rien ne sera écrit —\n' : '')

    console.log('NOMS DANS LA PROSE')
    for (const term of TERMS) await rewriteTerm(sql, work, term, bump)

    console.log('\nPRÉSENCES')
    for (const presence of PRESENCE) await statePresence(sql, work, presence, bump)

    console.log('\nORTHOGRAPHES')
    for (const rename of RENAMES) await renameLabel(sql, work, rename, bump)

    console.log('\nENTITÉS EN DOUBLE')
    for (const merge of MERGES) await mergeNamed(sql, work, merge, bump)

    console.log('\nCE QU’UN NOM EST')
    for (const entry of RECLASSIFY) await reclassify(sql, work, entry, bump)

    console.log('\nTYPES')
    await retypeAll(sql, work, bump)

    console.log('\n' + (dryRun ? '[dry-run] Rien écrit. ' : '') + summarise(done))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Un mot remplacé dans les résumés et dans les questions.
 *
 * Les deux tables, et c'est tout l'objet de ce script : la relecture
 * précédente écrivait la même correction et ne lisait que `events`, si bien que
 * « Kuro » a survécu dans les questions des chapitres 24 et 25, à l'écran, deux
 * chapitres avant sa révélation.
 *
 * Le mot entier, jamais un fragment. `\y` est la limite de mot de PostgreSQL et
 * `\b` celle de JavaScript : la sélection et le remplacement disent donc la
 * même chose, ce qui évite de retrouver une ligne qu'on ne sait pas réécrire.
 * Un événement porte aussi son texte dans son libellé d'entité, que lisent la
 * recherche et le fil ; réécrire l'un sans l'autre laisserait deux versions de
 * la même phrase.
 */
async function rewriteTerm(
  sql: postgres.Sql,
  work: Work,
  term: { from: string; to: string; first?: number; last?: number; why: string },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const pattern = '\\y' + term.from.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&') + '\\y'
  const first = term.first ?? 0
  const last = term.last ?? 2_147_483_647
  const span = term.first === undefined ? 'partout' : `ch${first}–${last}`

  const events = await sql<Array<{ entity_id: string; text: string }>>`
    SELECT entity_id, summary AS text FROM events
     WHERE user_id = ${work.user_id}
       AND coalesce(told_in_chapter, shown_in_chapter, 0) BETWEEN ${first} AND ${last}
       AND summary ~ ${pattern}
  `
  const questions = await sql<Array<{ entity_id: string; text: string }>>`
    SELECT entity_id, question AS text FROM mysteries
     WHERE user_id = ${work.user_id}
       AND opened_in_chapter BETWEEN ${first} AND ${last}
       AND question ~ ${pattern}
  `

  const total = events.length + questions.length
  console.log(
    `  ${term.from} → ${term.to} (${span}, ${term.why}) : ` +
      `${events.length} scène(s), ${questions.length} question(s)`,
  )
  if (dryRun || total === 0) return

  const swap = (text: string): string =>
    text.replace(new RegExp(`\\b${term.from}\\b`, 'g'), term.to)

  for (const row of events) {
    const next = swap(row.text)
    await sql`UPDATE events SET summary = ${next} WHERE entity_id = ${row.entity_id}`
    await mirrorLabel(sql, work, row.entity_id, next)
  }
  for (const row of questions) {
    const next = swap(row.text)
    await sql`UPDATE mysteries SET question = ${next} WHERE entity_id = ${row.entity_id}`
    await mirrorLabel(sql, work, row.entity_id, next)
  }
  bump('prose', total)
}

/** Une scène est nommée par sa propre phrase : le libellé suit le texte. */
async function mirrorLabel(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  text: string,
): Promise<void> {
  await sql`
    UPDATE entity_labels
       SET label = ${text.slice(0, 200)},
           normalized_label = app.normalize_text(${text.slice(0, 200)})
     WHERE entity_id = ${entityId} AND user_id = ${work.user_id}
  `
}

/**
 * Le chapitre où on le voit, déclaré.
 *
 * Le fil distingue « est mentionné » de « entre en scène » sur les occurrences
 * `stated`, et se rabat sur l'ancien comportement quand rien n'est déclaré —
 * ce qui est la bonne lecture d'un silence, et ce qui fait entrer Zoro au
 * chapitre 21 : c'est le premier dont l'extraction ait déclaré quoi que ce
 * soit. Une ligne à la main répond pour le chapitre 3, comme la relecture
 * précédente a répondu pour la mention du chapitre 2.
 */
async function statePresence(
  sql: postgres.Sql,
  work: Work,
  presence: { label: string; chapter: number; kind: 'appearance' },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const [row] = await sql<Array<{ entity_id: string; chapter_id: string }>>`
    SELECT l.entity_id, c.id AS chapter_id
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
      JOIN chapters c ON c.work_id = en.work_id AND c.number = ${presence.chapter}
     WHERE l.user_id = ${work.user_id} AND l.label = ${presence.label}
     LIMIT 1
  `
  if (!row) {
    console.log(`  ! « ${presence.label} » ou le chapitre ${presence.chapter} introuvable`)
    return
  }

  const [existing] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM occurrences
     WHERE entity_id = ${row.entity_id} AND chapter_id = ${row.chapter_id}
       AND stated AND kind = ${presence.kind}
  `
  if (existing && existing.n !== '0') {
    console.log(`  = ${presence.label} ch${presence.chapter} : déjà tranché`)
    return
  }

  console.log(`  → ${presence.label} ch${presence.chapter} : ${presence.kind}`)
  if (dryRun) return
  await sql`
    INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated, chapter_number)
    VALUES (${row.entity_id}, ${work.user_id}, ${row.chapter_id},
            ${presence.kind}, true, ${presence.chapter})
  `
  bump('présences')
}

/**
 * Un mot corrigé, par la fonction que le bouton « Renommer » appelle.
 *
 * Plutôt qu'un UPDATE : celui-ci n'écrirait que le libellé, et laisserait
 * l'ancienne graphie introuvable, le glossaire muet — donc la question reposée
 * au prochain chapitre — et les résumés qui épellent le nom inchangés. La
 * fonction du domaine fait les quatre, et elle est déjà testée.
 */
async function renameLabel(
  sql: postgres.Sql,
  work: Work,
  rename: { from: string; to: string; why: string },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const { renameEntityLabel, SEARCH_ONLY_PRECEDENCE } = await import(
    '../src/domains/knowledge/rename.ts'
  )

  /*
   * Le nom *affiché*, et pas la graphie gardée pour la recherche.
   *
   * C'est ce qui rend l'opération rejouable, et il a fallu une seconde
   * exécution pour le voir : renommer garde l'ancienne forme dans la table,
   * sous une précédence qui l'empêche de s'afficher. Une recherche par libellé
   * seul la retrouve donc au tour suivant et la renomme encore — le script
   * n'écrivait plus rien d'utile mais ne disait jamais « déjà fait ». La clause
   * de précédence dit ce qu'on cherche : le mot que la fiche montre.
   */
  const [row] = await sql<Array<{ id: string }>>`
    SELECT l.id
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND l.label = ${rename.from}
       AND l.precedence > ${SEARCH_ONLY_PRECEDENCE}
       AND en.review_status = 'accepted'
     LIMIT 1
  `
  if (!row) {
    const [already] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels
       WHERE user_id = ${work.user_id} AND label = ${rename.to}
    `
    console.log(
      already && already.n !== '0'
        ? `  = « ${rename.from} » → « ${rename.to} » déjà fait`
        : `  ! « ${rename.from} » introuvable`,
    )
    return
  }

  console.log(`  → « ${rename.from} » → « ${rename.to} » (${rename.why})`)
  if (dryRun) return

  const result = await renameEntityLabel(work.user_id, { labelId: row.id, label: rename.to })
  if (result.proseRewritten > 0) {
    console.log(`      ${result.proseRewritten} phrase(s) qui l’épelaient ont suivi`)
  }
  bump('orthographes')
}

/** Deux nœuds pour une personne, désignés par leurs libellés. */
async function mergeNamed(
  sql: postgres.Sql,
  work: Work,
  merge: { keep: string; drop: string; chapter: number },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const keep = await entityByLabel(sql, work, merge.keep)
  const drop = await entityByLabel(sql, work, merge.drop)

  if (!keep || !drop) {
    console.log(
      `  = « ${keep ? merge.drop : merge.keep} » introuvable (déjà fusionné ?)`,
    )
    return
  }
  if (keep === drop) {
    console.log(`  = « ${merge.drop} » est déjà un nom de « ${merge.keep} »`)
    return
  }

  console.log(`  → « ${merge.drop} » rejoint « ${merge.keep} » au ch${merge.chapter}`)
  if (dryRun) return
  await fold(sql, work, keep, drop, merge.chapter)
  bump('entités')
}

/** Un nœud accepté portant ce libellé, s'il y en a un. */
async function entityByLabel(
  sql: postgres.Sql,
  work: Work,
  label: string,
): Promise<string | null> {
  const [row] = await sql<Array<{ entity_id: string }>>`
    SELECT l.entity_id
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND l.label = ${label}
       AND en.review_status = 'accepted'
     LIMIT 1
  `
  return row?.entity_id ?? null
}

/**
 * Une entité rejointe à sa jumelle, et une seule des deux montrée.
 *
 * Deux écritures, parce qu'elles répondent à deux questions. Le `same_as` dit
 * *pourquoi* — daté du chapitre, écrit comme la parole du lecteur (`user`,
 * verrouillé, donc à l'abri d'une proposition ultérieure de l'IA), et c'est le
 * mécanisme que le dépôt emploie déjà pour unifier deux nœuds. Le
 * `review_status` dit *ce qui se voit* : la politique des entités n'admet que
 * « accepted », donc rejeter la copie la retire du graphe et du fil.
 *
 * Rien n'est supprimé : une ligne remise à « accepted » revient telle quelle.
 */
async function fold(
  sql: postgres.Sql,
  work: Work,
  a: string,
  b: string,
  chapter: number,
): Promise<void> {
  const [existing] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM assertions
     WHERE predicate = 'same_as' AND review_status = 'accepted'
       AND ((subject_entity_id = ${a} AND object_entity_id = ${b})
         OR (subject_entity_id = ${b} AND object_entity_id = ${a}))
  `
  if (!existing || existing.n === '0') {
    await sql`
      INSERT INTO assertions (
        work_id, user_id, subject_entity_id, predicate, object_entity_id,
        knowledge_from_chapter, observed_in_chapter, confidence,
        epistemic_status, review_status, proposed_by, locked
      ) VALUES (
        ${work.id}, ${work.user_id}, ${a}, 'same_as', ${b},
        ${chapter}, ${chapter}, 1,
        'user_validated', 'accepted', 'user', true
      )
    `
  }
  await sql`
    UPDATE entities SET review_status = 'rejected'
     WHERE id = ${b} AND user_id = ${work.user_id}
  `
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, 'entities_joined', 'entity', ${a},
            ${sql.json({ hidden: b, chapter, note: NOTE })})
  `
}

/**
 * Ce qu'un libellé est, sans toucher à sa date.
 *
 * La date reste : le lecteur a bien lu ce mot à ce chapitre-là, et la déplacer
 * ouvrirait dans le curseur un trou où le nom n'existait pas. Seuls sa nature
 * et son rang bougent — ce qui décide s'il s'affiche, pas s'il est connu.
 */
async function reclassify(
  sql: postgres.Sql,
  work: Work,
  entry: { label: string; kind: string; precedence: number; why: string },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const rows = await sql<Array<{ id: string; kind: string; precedence: number }>>`
    SELECT id, kind::text AS kind, precedence FROM entity_labels
     WHERE user_id = ${work.user_id} AND label = ${entry.label}
  `
  if (rows.length === 0) {
    console.log(`  ! « ${entry.label} » introuvable`)
    return
  }

  const wrong = rows.filter(
    (row) => row.kind !== entry.kind || row.precedence !== entry.precedence,
  )
  if (wrong.length === 0) {
    console.log(`  = « ${entry.label} » déjà ${entry.kind} (${entry.precedence})`)
    return
  }

  console.log(`  → « ${entry.label} » → ${entry.kind} (${entry.precedence}) — ${entry.why}`)
  if (dryRun) return
  for (const row of wrong) {
    await sql`
      UPDATE entity_labels
         SET kind = ${entry.kind}::label_kind, precedence = ${entry.precedence}
       WHERE id = ${row.id}
    `
  }
  bump('noms', wrong.length)
}

/**
 * Ce qu'un nœud est.
 *
 * `retypeEntity` change toute la composante d'identité, donc un nœud qu'une
 * fusion vient de rejoindre au premier est déjà du bon type, et le redemander
 * lèverait « c'est déjà son type ». D'où la relecture du type juste avant.
 */
async function retypeAll(
  sql: postgres.Sql,
  work: Work,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const { retypeEntity } = await import('../src/domains/knowledge/retype.ts')

  for (const retype of RETYPES) {
    const rows = await sql<Array<{ entity_id: string; node_type: string }>>`
      SELECT l.entity_id, en.node_type
        FROM entity_labels l
        JOIN entities en ON en.id = l.entity_id
       WHERE l.user_id = ${work.user_id} AND l.label = ${retype.label}
         AND en.review_status = 'accepted'
    `
    if (rows.length === 0) {
      console.log(`  ! « ${retype.label} » introuvable`)
      continue
    }
    if (rows.every((row) => row.node_type === retype.to)) {
      console.log(`  = « ${retype.label} » déjà ${retype.to}`)
      continue
    }

    for (const row of rows) {
      const [fresh] = await sql<Array<{ node_type: string }>>`
        SELECT node_type FROM entities WHERE id = ${row.entity_id}
      `
      if (!fresh || fresh.node_type === retype.to) continue
      console.log(`  → « ${retype.label} » ${fresh.node_type} → ${retype.to}`)
      if (dryRun) continue
      const result = await retypeEntity(work.user_id, {
        entityId: row.entity_id,
        nodeType: retype.to,
        confirm: true,
      })
      if (result.rejected > 0) {
        console.log(`      ${result.rejected} fait(s) rejeté(s) par le changement de type`)
      }
      bump('types')
    }
  }
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}

await main()
process.exit(0)
