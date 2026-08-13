/**
 * Les corrections relevées à la lecture des chapitres 1 à 42.
 *
 *   pnpm repair:chapitres-1-42 -- --dry-run     # dit tout, n'écrit rien
 *   pnpm repair:chapitres-1-42                  # applique
 *   TEST_DB=1 pnpm repair:chapitres-1-42        # base de test
 *
 * Six sortes de corrections, et elles ne sont pas de même nature — ce qui est
 * la raison d'être des sections ci-dessous plutôt que d'une longue liste :
 *
 *   1. Des résumés qui disent autre chose que le chapitre. « les coffres sont
 *      vides depuis toujours, déjà pillés » est contradictoire ; « Nami envoie
 *      ses sabres à Zoro » donne les sabres à Nami.
 *   2. Un nom écrit de deux façons. Le maire est « Buddle » onze fois et
 *      « Boodle » cinq fois, dans la même bibliothèque.
 *   3. Un nom que le lecteur n'a pas encore lu. Le majordome est « Klahadore »
 *      jusqu'au chapitre 26 et « Kuro » ensuite ; la source le dit ainsi et le
 *      graphe l'appelle « Kuro » dès le chapitre 23.
 *   4. La même scène écrite deux fois. Retrouvées par `findEcho`, la fonction
 *      qui empêche aujourd'hui le cas de se reproduire, pour que réparation et
 *      prévention aient la même définition de « c'est la même scène ».
 *   5. Deux entités pour une. Le chapitre 8 a été publié deux fois, avant que
 *      la publication ne sache rejoindre une entité existante.
 *   6. Une présence que la donnée ne permet pas de déduire. Zoro au chapitre 2
 *      et Baggy au chapitre 8 sont mentionnés, pas vus ; leurs propositions
 *      datent d'avant le champ qui l'aurait dit, donc c'est écrit ici à la main
 *      plutôt que rattrapé par la migration 0025.
 *
 * Rien n'est supprimé. Une scène en double est rejointe à sa jumelle par une
 * relation d'identité datée du chapitre — le mécanisme que le dépôt utilise
 * déjà pour les fusions — et reste donc lisible et défaisable.
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
 * Un résumé qui dit autre chose que le chapitre.
 *
 * Repéré par un fragment du texte actuel plutôt que par un identifiant : un
 * identifiant est propre à une bibliothèque et rend le script invérifiable
 * ailleurs, tandis qu'un fragment se lit et se contrôle contre le manga. Le
 * fragment doit désigner exactement une scène ; deux, et le script s'arrête
 * plutôt que d'en réécrire une au hasard.
 */
const REWRITES: ReadonlyArray<{ chapter: number; find: string; to: string }> = [
  {
    chapter: 22,
    find: 'vides depuis toujours',
    to:
      'Luffy et Nami découvrent que les cinq coffres avaient déjà été vidés ' +
      'avant que Gaimon ne puisse récupérer leur contenu.',
  },
  {
    chapter: 25,
    find: 'complot meurtrier contre le maître du manoir',
    to:
      'Klahadore rencontre secrètement Jango afin de préparer l’assassinat ' +
      'd’une personne liée au manoir.',
  },
  {
    chapter: 32,
    find: 'les jette à terre pour combattre lui-même',
    to:
      'Sham refuse de rendre les sabres de Zoro et les jette à terre. Zoro ' +
      'attaque Sham et croit l’avoir vaincu, mais découvre que celui-ci n’a ' +
      'pas été blessé.',
  },
  {
    chapter: 33,
    find: 'Nami envoie ses sabres à Zoro',
    to:
      'Nami rend les sabres de Zoro à leur propriétaire. Une fois armé de ses ' +
      'trois lames, Zoro vainc Sham et Buchi en un seul mouvement, puis ' +
      'menace Kuro.',
  },
  {
    chapter: 40,
    find: 'Luffy vainc Kuro et le renvoie à son équipage',
    to:
      'Après avoir vaincu Kuro, Luffy projette son corps inconscient vers son ' +
      'équipage et leur ordonne de quitter l’île pour toujours.',
  },
  {
    chapter: 41,
    find: 'l’invitent à embarquer comme capitaine',
    to:
      'Usopp arrive en roulant vers le navire. Luffy et Zoro l’arrêtent et ' +
      'l’invitent à embarquer avec eux. Usopp suppose qu’il deviendra le ' +
      'capitaine, mais Luffy lui rappelle qu’il occupe déjà ce rôle.',
  },
]

/** La question du chapitre 1, qui affirme ce que le chapitre ne dit pas. */
const QUESTION_REWRITES: ReadonlyArray<{ find: string; to: string }> = [
  {
    find: 'ne reviendra-t-il jamais au village',
    to: 'L’équipage du Roux reviendra-t-il un jour au village ?',
  },
]

/**
 * Un mot pour un autre, dans la prose des résumés et des questions.
 *
 * `Kuro` est borné aux chapitres 23 à 25 : c'est là que le nom est prématuré,
 * et le remplacer partout effacerait la révélation elle-même au chapitre 26.
 */
const TERMS: ReadonlyArray<{ from: string; to: string; first: number; last: number }> = [
  { from: 'Boodle', to: 'Buddle', first: 1, last: 42 },
  { from: 'Kuro', to: 'Klahadore', first: 23, last: 25 },
]

/**
 * Deux fois la même scène, quand les deux versions ne se ressemblent pas assez.
 *
 * `findEcho` retrouve les copies quasi mot pour mot — c'est ce qu'il faut pour
 * empêcher une republication d'écrire deux fois la même phrase, et c'est ce
 * qu'il a été écrit pour faire. Un chapitre découpé en morceaux produit autre
 * chose : deux récits du même geste, rédigés séparément, qui partagent la
 * moitié de leurs mots. « Luffy coince une pierre dans une griffe » raconté
 * deux fois de deux façons passe sous n'importe quel seuil qui ne fusionnerait
 * pas aussi deux scènes voisines mais distinctes.
 *
 * Donc à la main, et nommément. Baisser le seuil pour les attraper aurait
 * fusionné des scènes que rien ne permet de recoller, ce qui est la faute que
 * ce script est censé réparer, dans l'autre sens.
 */
const MERGES: ReadonlyArray<{ chapter: number; keep: string; drop: string }> = [
  {
    chapter: 26,
    keep: 'révèlent leur complot pour assassiner Kaya',
    drop: 'Usopp échappe à l’effet mais Luffy s’endort',
  },
  {
    chapter: 37,
    keep: 'attaque de nouveau Luffy, qui coince une pierre',
    drop: 'puis brise les lames de cette griffe',
  },
  {
    chapter: 37,
    keep: 'Luffy est incapable de prendre l’avantage face à la rapidité',
    drop: 'se révèle plus rapide et agile, l’assommant d’un coup de pied',
  },
  {
    chapter: 38,
    keep: 'pour effacer toute trace de sa véritable identité',
    drop: 'tout son ancien équipage jusqu’au dernier',
  },
]

/** Vu, ou seulement nommé — là où la donnée ne peut pas répondre seule. */
const PRESENCE: ReadonlyArray<{ label: string; chapter: number; kind: 'mention' }> = [
  { label: 'Roronoa Zoro', chapter: 2, kind: 'mention' },
  { label: 'Baggy', chapter: 8, kind: 'mention' },
]

/** Ce que la source montre comme un groupe et que le graphe range en personnage. */
const RETYPES: ReadonlyArray<{ label: string; to: string }> = [
  { label: 'Freaky Domingos', to: 'group' },
  { label: 'Nyaban Brothers', to: 'group' },
]

/**
 * Des appartenances mises en quarantaine faute d'un nœud où pointer.
 *
 * Le même trou que « Luffy dirige l'Équipage du Capitaine Usopp », vu par
 * l'autre bout. L'équipage de Luffy n'existait pas, alors le modèle a écrit ce
 * qu'il pouvait au bout de la relation : une fois le nom en toutes lettres
 * (« Équipage de Luffy », refusé comme `literal_object`), une fois un
 * placeholder (refusé comme `unknown_object`). La quarantaine a eu raison des
 * deux — l'objet d'une relation est une entité, pas une phrase — et Zoro s'est
 * retrouvé avec quatorze « affronte » et pas une appartenance.
 *
 * Le nœud existe maintenant. Ces propositions sont donc republiées telles
 * quelles, avec leur extrait d'origine : ce n'est pas une affirmation écrite ici,
 * c'est celle que le modèle avait tirée de la page et que rien n'avait pu
 * ranger. Désignées par leur extrait plutôt que par un identifiant de ligne,
 * pour la même raison que les réécritures : un extrait se relit contre le manga.
 *
 * L'objet est « le groupe que Luffy dirige » et non un nom : le nœud a déjà été
 * renommé une fois, et un script qui le retrouverait par son libellé cesserait
 * de fonctionner au prochain renommage.
 */
const RELEASES: ReadonlyArray<{ subject: string; excerpt: string }> = [
  { subject: 'Roronoa Zoro', excerpt: 'Zoro accepts Luffy’s offer to join his crew' },
  { subject: 'Roronoa Zoro', excerpt: 'he has already declared he will join him after this' },
]

/**
 * Le nom que le lecteur lit, à la date où il le lit.
 *
 * Le nœud a été renommé « Équipage du Chapeau de paille », ce que la source
 * autorise : elle écrit « the Straw Hats » — pour l'équipage, pas pour le
 * couvre-chef — au chapitre 23. Mais le renommage a gardé la date du libellé
 * qu'il remplaçait, le chapitre 5, si bien que la fiche donne ce nom dix-huit
 * chapitres avant que le lecteur ne le rencontre. C'est la règle que toute
 * cette relecture applique, appliquée au nom du groupe lui-même.
 *
 * Donc deux libellés plutôt qu'un : la description au chapitre 5, où le groupe
 * se forme et n'a pas de nom, et le nom au chapitre 23, où la source le donne.
 * C'est le mécanisme employé pour Klahadore et Kuro, et il n'y a pas de raison
 * que le groupe en soit dispensé.
 */
const CREW_LABELS: ReadonlyArray<{ label: string; kind: string; chapter: number; precedence: number }> = [
  { label: 'Équipage de Luffy', kind: 'placeholder', chapter: 5, precedence: 10 },
  { label: 'Équipage du Chapeau de paille', kind: 'alias', chapter: 23, precedence: 50 },
]

const NOTE =
  'Relecture des chapitres 1 à 42 : correction saisie à la main, ' +
  'voir scripts/repair-chapitres-1-42.ts.'

/**
 * L'apostrophe, des deux façons dont elle est écrite.
 *
 * La prose importée porte l'apostrophe droite, celle écrite ici la
 * typographique, et un fragment qui contient « l'invitent » ne trouve rien dans
 * un résumé qui dit « l’invitent ». Plutôt que de retenir laquelle va où, les
 * deux côtés sont ramenés à la même — en JavaScript pour le fragment, en SQL
 * pour la colonne, avec `replace(…, '’', chr(39))`.
 */
function straight(value: string): string {
  return value.replace(/[’']/g, "'")
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
    const [work] = await sql<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id FROM works ORDER BY created_at LIMIT 1
    `
    if (!work) {
      console.log('Aucune œuvre dans cette base : rien à réparer.')
      return
    }

    console.log(dryRun ? '— dry-run : rien ne sera écrit —\n' : '')

    // ---- 1. Les résumés qui disent autre chose --------------------------------
    console.log('RÉSUMÉS')
    for (const rewrite of REWRITES) {
      const rows = await sql<Array<{ entity_id: string; summary: string }>>`
        SELECT e.entity_id, e.summary
          FROM events e
          JOIN entities en ON en.id = e.entity_id
         WHERE e.user_id = ${work.user_id}
           AND e.shown_in_chapter = ${rewrite.chapter}
           AND replace(e.summary, '’', chr(39)) LIKE ${'%' + straight(rewrite.find) + '%'}
      `
      if (rows.length === 0) {
        const [already] = await sql<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM events
           WHERE user_id = ${work.user_id} AND summary = ${rewrite.to}
        `
        console.log(
          already && already.n !== '0'
            ? `  = ch${rewrite.chapter} « ${rewrite.find} » déjà réécrit`
            : `  ! ch${rewrite.chapter} « ${rewrite.find} » introuvable`,
        )
        continue
      }
      if (rows.length > 1) {
        throw new Error(
          `ch${rewrite.chapter} : « ${rewrite.find} » désigne ${rows.length} scènes. ` +
            'Précisez le fragment plutôt que d’en réécrire une au hasard.',
        )
      }
      console.log(`  → ch${rewrite.chapter} ${rows[0]!.summary.slice(0, 70)}…`)
      if (!dryRun) await rewriteEvent(sql, work.user_id, rows[0]!.entity_id, rewrite.to)
      bump('résumés')
    }

    // ---- 2. La question qui affirme -------------------------------------------
    console.log('\nQUESTIONS')
    for (const rewrite of QUESTION_REWRITES) {
      const rows = await sql<Array<{ entity_id: string; question: string }>>`
        SELECT entity_id, question FROM mysteries
         WHERE user_id = ${work.user_id}
           AND replace(question, '’', chr(39)) LIKE ${'%' + straight(rewrite.find) + '%'}
      `
      if (rows.length === 0) {
        console.log(`  = « ${rewrite.find} » déjà réécrite ou absente`)
        continue
      }
      console.log(`  → ${rows[0]!.question.slice(0, 70)}…`)
      if (!dryRun) {
        await sql`
          UPDATE mysteries SET question = ${rewrite.to} WHERE entity_id = ${rows[0]!.entity_id}
        `
        await sql`
          UPDATE entity_labels
             SET label = ${rewrite.to}, normalized_label = app.normalize_text(${rewrite.to})
           WHERE entity_id = ${rows[0]!.entity_id}
        `
      }
      bump('questions')
    }

    // ---- 3. Un nom écrit de deux façons, et un nom trop tôt -------------------
    console.log('\nNOMS DANS LA PROSE')
    for (const term of TERMS) {
      const rows = await sql<Array<{ entity_id: string; summary: string }>>`
        SELECT entity_id, summary FROM events
         WHERE user_id = ${work.user_id}
           AND shown_in_chapter BETWEEN ${term.first} AND ${term.last}
           AND summary ~ ${'\\y' + term.from + '\\y'}
      `
      console.log(`  ${term.from} → ${term.to} : ${rows.length} résumé(s)`)
      if (dryRun || rows.length === 0) continue
      for (const row of rows) {
        const next = row.summary.replace(
          new RegExp(`\\b${term.from}\\b`, 'g'),
          term.to,
        )
        await rewriteEvent(sql, work.user_id, row.entity_id, next)
      }
      bump('prose', rows.length)
    }

    // ---- 4. Le majordome, sous le nom que le lecteur connaît ------------------
    console.log('\nKLAHADORE / KURO')
    await repairKlahadore(sql, work, dryRun, bump)

    // ---- 5. La même scène écrite deux fois ------------------------------------
    console.log('\nSCÈNES EN DOUBLE, NOMMÉMENT')
    for (const merge of MERGES) {
      const keep = await sceneByFragment(sql, work.user_id, merge.chapter, merge.keep)
      const drop = await sceneByFragment(sql, work.user_id, merge.chapter, merge.drop)
      if (!keep || !drop) {
        console.log(
          `  = ch${merge.chapter} « ${(keep ? merge.drop : merge.keep).slice(0, 40)}… » ` +
            'introuvable (déjà fusionnée ?)',
        )
        continue
      }
      console.log(`  → ch${merge.chapter} ${drop.text.slice(0, 62)}…`)
      if (!dryRun) await fold(sql, work, keep.entity_id, drop.entity_id, merge.chapter)
      bump('scènes')
    }

    console.log('\nSCÈNES ET QUESTIONS EN DOUBLE (détectées)')
    await mergeEchoes(sql, work, dryRun, bump)

    // ---- 6. Deux entités pour une ---------------------------------------------
    console.log('\nENTITÉS EN DOUBLE')
    await mergeTwins(sql, work, dryRun, bump)

    // ---- 6 bis. L'équipage, son nom et ses membres ----------------------------
    console.log('\nÉQUIPAGE DE LUFFY')
    await repairCrew(sql, work, dryRun, bump)

    // ---- 7. Vu, ou seulement nommé --------------------------------------------
    console.log('\nPRÉSENCES')
    for (const presence of PRESENCE) {
      const [row] = await sql<Array<{ entity_id: string; chapter_id: string }>>`
        SELECT l.entity_id, c.id AS chapter_id
          FROM entity_labels l
          JOIN entities en ON en.id = l.entity_id
          JOIN chapters c ON c.work_id = en.work_id AND c.number = ${presence.chapter}
         WHERE l.user_id = ${work.user_id} AND l.label = ${presence.label}
         LIMIT 1
      `
      if (!row) {
        console.log(`  ! « ${presence.label} » introuvable`)
        continue
      }
      const [existing] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM occurrences
         WHERE entity_id = ${row.entity_id} AND chapter_id = ${row.chapter_id} AND stated
      `
      if (existing && existing.n !== '0') {
        console.log(`  = ${presence.label} ch${presence.chapter} : déjà tranché`)
        continue
      }
      console.log(`  → ${presence.label} ch${presence.chapter} : ${presence.kind}`)
      if (!dryRun) {
        await sql`
          INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated, chapter_number)
          VALUES (${row.entity_id}, ${work.user_id}, ${row.chapter_id},
                  ${presence.kind}, true, ${presence.chapter})
        `
      }
      bump('présences')
    }

    // ---- 8. Ce qui est un groupe ----------------------------------------------
    console.log('\nTYPES')
    const { retypeEntity } = await import('../src/domains/knowledge/retype.ts')
    for (const retype of RETYPES) {
      const rows = await sql<Array<{ entity_id: string; node_type: string }>>`
        SELECT l.entity_id, en.node_type
          FROM entity_labels l
          JOIN entities en ON en.id = l.entity_id
         WHERE l.user_id = ${work.user_id} AND l.label = ${retype.label}
      `
      const wrong = rows.filter((row) => row.node_type !== retype.to)
      if (wrong.length === 0) {
        console.log(`  = « ${retype.label} » déjà ${retype.to}`)
        continue
      }
      for (const row of wrong) {
        // Relu maintenant : `retypeEntity` change toute la composante
        // d'identité, donc le nœud qu'une fusion vient de rejoindre au premier
        // est déjà du bon type, et le redemander lèverait « c'est déjà son type ».
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

    console.log('\n' + (dryRun ? '[dry-run] Rien écrit. ' : '') + summarise(done))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Un événement porte son texte à deux endroits : la ligne `events`, que lisent
 * la chronologie et le mode récit, et son libellé d'entité, que lisent la
 * recherche et toute vue qui nomme un nœud. Réécrire l'un sans l'autre laisse
 * la bibliothèque avec deux versions de la même phrase.
 */
async function rewriteEvent(
  sql: postgres.Sql,
  userId: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await sql`UPDATE events SET summary = ${summary} WHERE entity_id = ${entityId}`
  await sql`
    UPDATE entity_labels
       SET label = ${summary.slice(0, 200)},
           normalized_label = app.normalize_text(${summary.slice(0, 200)})
     WHERE entity_id = ${entityId} AND user_id = ${userId}
  `
}

/**
 * Le majordome porte le nom que le lecteur lui connaît, à la date où il le lui
 * connaît.
 *
 * Le mécanisme est déjà là et n'a pas été employé : un libellé porte son
 * chapitre de révélation, et la fiche montre le mieux classé parmi ceux que le
 * lecteur a lus. « Klahadore » révélé au 23 et « Kuro » révélé au 26 donnent
 * donc Klahadore de 23 à 25 et Kuro ensuite, sans rien cacher ni rien inventer
 * — c'est exactement ce que le chapitre 26 fait au lecteur.
 */
async function repairKlahadore(
  sql: postgres.Sql,
  work: { id: string; user_id: string },
  dry: boolean,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const [kuro] = await sql<Array<{ entity_id: string; revealed_in_chapter: number }>>`
    SELECT l.entity_id, l.revealed_in_chapter
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND l.label = 'Kuro' AND en.node_type = 'character'
     LIMIT 1
  `
  if (!kuro) {
    console.log('  ! aucune entité « Kuro »')
    return
  }

  const [klahadore] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM entity_labels
     WHERE entity_id = ${kuro.entity_id} AND label = 'Klahadore'
  `
  const hasAlias = klahadore !== undefined && klahadore.n !== '0'

  if (hasAlias && kuro.revealed_in_chapter === 26) {
    console.log('  = déjà : Klahadore au 23, Kuro au 26')
    return
  }

  console.log(
    `  → « Klahadore » révélé au ch23${hasAlias ? ' (déjà présent)' : ''}, ` +
      `« Kuro » déplacé du ch${kuro.revealed_in_chapter} au ch26`,
  )
  if (dry) return

  if (!hasAlias) {
    await sql`
      INSERT INTO entity_labels
        (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
      VALUES (${kuro.entity_id}, ${work.user_id}, 'Klahadore',
              app.normalize_text('Klahadore'), 'true_name', 23, 100)
    `
  }
  // Le nœud lui-même entre en scène au 23 : c'est le majordome que le lecteur
  // rencontre, pas la révélation. Seul le nom bouge.
  await sql`
    UPDATE entity_labels SET revealed_in_chapter = 26
     WHERE entity_id = ${kuro.entity_id} AND label = 'Kuro'
  `
  bump('noms')
}

/**
 * Deux fois la même scène, retrouvées comme la publication les retrouverait.
 *
 * `findEcho` est la fonction qui empêche aujourd'hui une scène d'être écrite
 * deux fois ; l'employer ici donne à la réparation et à la prévention la même
 * définition de « c'est la même scène », et évite d'inventer un second seuil
 * qui dériverait du premier. Le résultat est filtré sur le chapitre : une scène
 * qui ressemble à une scène d'un autre chapitre est un rappel, pas un doublon.
 */
async function mergeEchoes(
  sql: postgres.Sql,
  work: { id: string; user_id: string },
  dry: boolean,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const { withIngest } = await import('../src/db/boundary.ts')
  const { findEcho, ECHO_TOO_CLOSE } = await import('../src/domains/review/echoes.ts')

  const scenes = await sql<
    Array<{ entity_id: string; text: string; chapter: number; node_type: string }>
  >`
    SELECT e.entity_id, e.summary AS text, e.shown_in_chapter AS chapter, en.node_type
      FROM events e JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id} AND en.review_status = 'accepted'
       AND e.shown_in_chapter BETWEEN 1 AND 42
    UNION ALL
    SELECT m.entity_id, m.question, m.opened_in_chapter, en.node_type
      FROM mysteries m JOIN entities en ON en.id = m.entity_id
     WHERE m.user_id = ${work.user_id} AND en.review_status = 'accepted'
       AND m.opened_in_chapter BETWEEN 1 AND 42
  `

  const merged = new Set<string>()
  for (const scene of scenes) {
    if (merged.has(scene.entity_id) || !scene.text) continue

    const echo = await withIngest((db) =>
      findEcho(db, {
        workId: work.id,
        userId: work.user_id,
        nodeTypes:
          scene.node_type === 'mystery'
            ? ['mystery']
            : ['event', 'battle', 'voyage'],
        text: scene.text,
        chapterNumber: scene.chapter,
        excludeEntityIds: [scene.entity_id, ...merged],
      }),
    )

    if (!echo || echo.overlap < ECHO_TOO_CLOSE) continue
    if (echo.chapterNumber !== scene.chapter) continue

    console.log(
      `  → ch${scene.chapter} ${Math.round(echo.overlap * 100)} % : ` +
        `${scene.text.slice(0, 58)}…`,
    )
    if (!dry) await fold(sql, work, echo.entityId, scene.entity_id, scene.chapter)
    merged.add(scene.entity_id)
    bump('scènes')
  }
  if (merged.size === 0) console.log('  = aucune scène en double')
}

/** Deux entités portant exactement le même nom au même type : le chapitre 8. */
async function mergeTwins(
  sql: postgres.Sql,
  work: { id: string; user_id: string },
  dry: boolean,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const twins = await sql<
    Array<{ label: string; node_type: string; ids: string[]; chapter: number }>
  >`
    SELECT l.label, en.node_type,
           array_agg(DISTINCT en.id::text) AS ids,
           min(en.first_seen_chapter) AS chapter
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id}
       AND en.review_status = 'accepted'
       AND en.node_type NOT IN ('event', 'battle', 'voyage', 'mystery')
       AND en.first_seen_chapter BETWEEN 1 AND 42
     GROUP BY l.label, en.node_type
    HAVING count(DISTINCT en.id) > 1
  `

  if (twins.length === 0) {
    console.log('  = aucune entité en double')
    return
  }

  /*
   * Un même couple de nœuds apparaît une fois par libellé commun : les deux
   * Freaky Domingos partagent leur nom *et* leur alias, donc le groupement en
   * sort deux lignes pour une seule fusion. Dédoublonné sur le couple lui-même,
   * sans quoi la seconde ligne rejouerait la première sur un nœud déjà masqué.
   */
  const seen = new Set<string>()
  for (const twin of twins) {
    const [keep, ...rest] = twin.ids
    for (const other of rest) {
      const pair = [keep!, other].sort().join('|')
      if (seen.has(pair)) continue
      seen.add(pair)
      console.log(`  → « ${twin.label} » (${twin.node_type})`)
      if (dry) continue
      await fold(sql, work, keep!, other, twin.chapter)
      bump('entités')
    }
  }
}

/**
 * Une scène rejointe à sa jumelle, et une seule des deux montrée.
 *
 * Deux écritures, parce qu'elles répondent à deux questions. Le `same_as` dit
 * *pourquoi* — il est daté du chapitre, écrit comme la parole du lecteur
 * (`user`, verrouillé, donc à l'abri d'une proposition ultérieure de l'IA), et
 * c'est le mécanisme que le dépôt emploie déjà pour unifier deux nœuds. Le
 * `review_status` dit *ce qui se voit* : la politique RLS des entités n'admet
 * que « accepted », donc rejeter la copie la retire de la fiche, du graphe, de
 * la recherche et du fil du chapitre d'un seul coup.
 *
 * Le `same_as` seul n'aurait pas suffi, et c'est le piège de cette réparation :
 * il replie bien les deux nœuds sur la fiche, mais le fil d'un chapitre liste
 * les lignes de `events`, où la scène en double reste une ligne. Elle serait
 * restée affichée deux fois — exactement le symptôme à corriger.
 *
 * Rien n'est supprimé : « rejected » est le même mécanisme que le changement de
 * type emploie pour écarter un fait, et une ligne remise à « accepted » revient
 * telle quelle.
 */
async function fold(
  sql: postgres.Sql,
  work: { id: string; user_id: string },
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
  if (existing && existing.n !== '0') return

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

/** Une scène d'un chapitre, désignée par un fragment de son texte. */
async function sceneByFragment(
  sql: postgres.Sql,
  userId: string,
  chapter: number,
  fragment: string,
): Promise<{ entity_id: string; text: string } | null> {
  const rows = await sql<Array<{ entity_id: string; text: string }>>`
    SELECT e.entity_id, e.summary AS text
      FROM events e JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${userId} AND e.shown_in_chapter = ${chapter}
       AND en.review_status = 'accepted'
       AND replace(e.summary, '’', chr(39)) LIKE ${'%' + straight(fragment) + '%'}
    UNION ALL
    SELECT m.entity_id, m.question
      FROM mysteries m JOIN entities en ON en.id = m.entity_id
     WHERE m.user_id = ${userId} AND m.opened_in_chapter = ${chapter}
       AND en.review_status = 'accepted'
       AND replace(m.question, '’', chr(39)) LIKE ${'%' + straight(fragment) + '%'}
  `
  if (rows.length > 1) {
    throw new Error(
      `ch${chapter} : « ${fragment} » désigne ${rows.length} scènes. Précisez le fragment.`,
    )
  }
  return rows[0] ?? null
}

/**
 * Le nœud de l'équipage : son nom daté, et les appartenances qui l'attendaient.
 *
 * Retrouvé par la relation plutôt que par le libellé — « le groupe que Luffy
 * dirige » reste vrai après un renommage, un nom non.
 */
async function repairCrew(
  sql: postgres.Sql,
  work: { id: string; user_id: string },
  dry: boolean,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const [crew] = await sql<Array<{ id: string }>>`
    SELECT a.object_entity_id AS id
      FROM assertions a
      JOIN entity_labels l ON l.entity_id = a.subject_entity_id
     WHERE a.user_id = ${work.user_id} AND a.predicate = 'leads'
       AND a.review_status = 'accepted' AND l.label = 'Monkey D. Luffy'
     LIMIT 1
  `
  if (!crew) {
    console.log('  ! aucun groupe dirigé par Luffy : lancez d’abord repair:luffy-crew')
    return
  }

  for (const wanted of CREW_LABELS) {
    const [held] = await sql<Array<{ revealed_in_chapter: number }>>`
      SELECT revealed_in_chapter FROM entity_labels
       WHERE entity_id = ${crew.id} AND label = ${wanted.label}
    `
    if (held && held.revealed_in_chapter === wanted.chapter) {
      console.log(`  = « ${wanted.label} » déjà au ch${wanted.chapter}`)
      continue
    }
    console.log(
      held
        ? `  → « ${wanted.label} » ch${held.revealed_in_chapter} → ch${wanted.chapter}`
        : `  → « ${wanted.label} » ajouté au ch${wanted.chapter}`,
    )
    if (dry) continue
    if (held) {
      await sql`
        UPDATE entity_labels
           SET revealed_in_chapter = ${wanted.chapter}, precedence = ${wanted.precedence},
               kind = ${wanted.kind}::label_kind
         WHERE entity_id = ${crew.id} AND label = ${wanted.label}
      `
    } else {
      await sql`
        INSERT INTO entity_labels
          (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
        VALUES (${crew.id}, ${work.user_id}, ${wanted.label},
                app.normalize_text(${wanted.label}), ${wanted.kind}::label_kind,
                ${wanted.chapter}, ${wanted.precedence})
      `
    }
    bump('noms')
  }

  for (const release of RELEASES) {
    const [row] = await sql<
      Array<{ id: string; chapter_id: string; number: number; payload: Record<string, unknown> }>
    >`
      SELECT q.id, q.chapter_id, c.number, q.payload
        FROM quarantine q JOIN chapters c ON c.id = q.chapter_id
       WHERE q.user_id = ${work.user_id}
         AND q.payload->>'predicate' = 'member_of'
         AND replace(q.payload->'evidence'->0->>'excerpt', '’', chr(39))
             LIKE ${'%' + straight(release.excerpt) + '%'}
       LIMIT 1
    `
    if (!row) {
      console.log(`  = « ${release.excerpt.slice(0, 44)}… » plus en quarantaine`)
      continue
    }

    const [subject] = await sql<Array<{ entity_id: string }>>`
      SELECT entity_id FROM entity_labels
       WHERE user_id = ${work.user_id} AND label = ${release.subject} LIMIT 1
    `
    if (!subject) {
      console.log(`  ! « ${release.subject} » introuvable`)
      continue
    }

    console.log(`  → ${release.subject} membre au ch${row.number} (levée de quarantaine)`)
    if (dry) continue

    const excerpt = String(
      (row.payload['evidence'] as Array<Record<string, string>>)[0]?.excerpt ?? '',
    )
    /*
     * Le bloc source retrouvé par son texte, pas par la référence « b9 » du
     * payload : celle-ci n'a de sens que dans la table de références du run qui
     * l'a produite. Le trigger d'ancrage revalide de toute façon que l'extrait
     * est bien dans le bloc cité.
     */
    const [block] = await sql<Array<{ id: string; page_id: string }>>`
      SELECT id, page_id FROM text_blocks
       WHERE chapter_id = ${row.chapter_id}
         AND normalized_text LIKE '%' || app.normalize_text(${excerpt}) || '%'
       LIMIT 1
    `
    if (!block) {
      console.log('      ! extrait introuvable dans le chapitre, laissé en quarantaine')
      continue
    }

    const [made] = await sql<Array<{ id: string }>>`
      INSERT INTO assertions (
        work_id, user_id, subject_entity_id, predicate, object_entity_id,
        knowledge_from_chapter, observed_in_chapter, confidence,
        epistemic_status, review_status, proposed_by, locked
      ) VALUES (
        ${work.id}, ${work.user_id}, ${subject.entity_id}, 'member_of', ${crew.id},
        ${row.number}, ${row.number}, ${Number(row.payload['confidence'] ?? 0.8)},
        'explicit', 'accepted', 'user', true
      ) RETURNING id
    `
    await sql`
      INSERT INTO evidence (assertion_id, user_id, chapter_id, page_id, text_block_id, kind, excerpt)
      VALUES (${made!.id}, ${work.user_id}, ${row.chapter_id}, ${block.page_id},
              ${block.id}, 'dialogue', ${excerpt})
    `
    await sql`DELETE FROM quarantine WHERE id = ${row.id}`
    await sql`
      INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
      VALUES (${work.user_id}, 'quarantine_released', 'assertion', ${made!.id},
              ${sql.json({ subject: release.subject, chapter: row.number, note: NOTE })})
    `
    bump('appartenances')
  }
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}

await main()
process.exit(0)
