import 'server-only'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, textBlocks } from '@/db/schema/documents.ts'
import { assertions, auditLog, entities, entityLabels } from '@/db/schema/knowledge.ts'
import { normalizeText } from './normalize.ts'

/**
 * Dire à la main que deux nœuds sont la même personne, à partir du chapitre qui
 * l'apprend.
 *
 * Le dernier recours, et il doit exister parce qu'aucune règle automatique
 * n'attrapera tout. En amont, le chapitre qui révèle propose lui-même la
 * relation, citée, et un humain la tranche dans le centre de revue ; c'est le
 * chemin normal et il couvre le cas courant. Mais une révélation peut être
 * portée par une image, par une phrase que l'extraction a lue autrement, ou par
 * un chapitre déjà publié avant que le prompt ne sache la demander — et alors
 * le lecteur sait, et l'application n'a aucun geste à lui offrir. « Silhouette
 * au sommet » et Tony Tony Chopper restent deux nœuds pour le reste de l'œuvre.
 *
 * Volontairement séparé du choix de prédicat sur un fait, qui refuse `same_as`
 * et a raison de le refuser : transformer « connaît » en identité depuis un
 * select d'une ligne serait une fusion que personne n'a vue. Ici c'est le
 * contraire — un geste dont c'est le seul objet, qui nomme les deux nœuds,
 * demande la date et dit ce que la fiche affichera avant comme après.
 *
 * Ce qui distingue cette fusion de la réparation d'un doublon, et c'est tout le
 * dossier : **les deux nœuds restent**. La désignation provisoire est ce que le
 * lecteur savait au chapitre 138, et la rejeter effacerait l'état que la
 * frontière existe pour garder. Seule la relation est écrite, datée ; sous son
 * chapitre l'union-find de la projection ne la voit pas et les deux nœuds sont
 * deux, à partir de lui ils n'en font qu'un, affiché sous le nom le mieux
 * classé de la composante.
 */

/** Un nœud, tel que ce geste a besoin de le connaître. */
export interface IdentifySide {
  id: string
  label: string
  nodeType: string
  firstSeenChapter: number
}

export interface IdentifyProposal {
  subject: IdentifySide
  object: IdentifySide
  /**
   * Le chapitre proposé, lu dans les sources — jamais deviné.
   *
   * Le premier chapitre dont le texte écrit le nom du nœud nommé, par la même
   * question que `naming.ts` pose pour refuser un nom. Null quand aucune source
   * ne l'écrit : la fusion reste possible, mais la date est alors entièrement
   * celle du lecteur, et l'interface le dit plutôt que de proposer un nombre
   * qu'elle n'a pas.
   */
  suggestedChapter: number | null
  /** Le mot sur lequel la date a été trouvée, pour que la proposition s'explique. */
  suggestedFrom: string | null
  /** Le plus tardif des deux « first_seen » : avant, la fusion n'a pas de sens. */
  earliest: number
  /** Renseigné quand les deux sont déjà rejoints, avec le chapitre. */
  alreadyJoined: number | null
}

export interface IdentifyResult {
  subjectId: string
  objectId: string
  chapter: number
}

export class IdentifyRefusal extends Error {}

/**
 * Ce que la fusion ferait, avant de la faire.
 *
 * Rendu avant tout écrit pour la même raison que `retypeEntity` chiffre ses
 * conflits avant de reclasser : une fusion change ce que la fiche affiche, et
 * « à partir du 139 il s'appellera Tony Tony Chopper » n'est pas quelque chose
 * qu'on découvre après avoir cliqué.
 */
export async function proposeIdentity(
  userId: string,
  input: { entityId: string; otherId: string },
): Promise<IdentifyProposal> {
  if (input.entityId === input.otherId) {
    throw new IdentifyRefusal('Une entité est déjà elle-même.')
  }

  return withIngest(async (db) => {
    const sides = await sidesOf(db, userId, [input.entityId, input.otherId])
    const subject = sides.get(input.entityId)
    const object = sides.get(input.otherId)
    if (!subject || !object) {
      throw new IdentifyRefusal('Une des deux fiches est introuvable.')
    }

    const [joined] = await db
      .select({ chapter: assertions.knowledgeFromChapter })
      .from(assertions)
      .where(
        and(
          eq(assertions.userId, userId),
          eq(assertions.predicate, 'same_as'),
          eq(assertions.reviewStatus, 'accepted'),
          or(
            and(
              eq(assertions.subjectEntityId, input.entityId),
              eq(assertions.objectEntityId, input.otherId),
            ),
            and(
              eq(assertions.subjectEntityId, input.otherId),
              eq(assertions.objectEntityId, input.entityId),
            ),
          ),
        ),
      )
      .limit(1)

    /*
     * La date se cherche sur le nom, pas sur la description.
     *
     * C'est le nom qui arrive : « Silhouette au sommet » n'apparaîtra dans
     * aucune source, et « Tony Tony Chopper » apparaît au chapitre qui le donne.
     * Le côté interrogé est donc celui qui porte le vrai nom — et quand les deux
     * en portent un, le plus tardivement entré en scène, qui est celui que le
     * chapitre vient de nommer.
     */
    const named = await namedSide(db, userId, subject, object)
    const found = named ? await firstChapterNaming(db, userId, named.label) : null

    return {
      subject,
      object,
      suggestedChapter: found,
      suggestedFrom: found === null ? null : (named?.label ?? null),
      earliest: Math.max(subject.firstSeenChapter, object.firstSeenChapter),
      alreadyJoined: joined?.chapter ?? null,
    }
  })
}

/**
 * L'écrire, à la date que vous avez confirmée.
 *
 * `user_validated`, `locked`, `proposed_by: 'user'` : c'est votre parole, et le
 * verrou la met à l'abri d'une proposition ultérieure du modèle sur le même
 * chapitre. Rien n'est supprimé et rien n'est irréversible — la relation
 * apparaît sur les deux fiches, et « ce fait est faux » la retire.
 */
export async function identifyEntities(
  userId: string,
  input: { entityId: string; otherId: string; chapter: number },
): Promise<IdentifyResult> {
  const proposal = await proposeIdentity(userId, input)

  if (proposal.alreadyJoined !== null) {
    throw new IdentifyRefusal(
      `Ces deux fiches sont déjà rejointes, au chapitre ${proposal.alreadyJoined}.`,
    )
  }

  if (!Number.isInteger(input.chapter) || input.chapter < 1) {
    throw new IdentifyRefusal('Le chapitre de la révélation doit être un entier positif.')
  }

  /*
   * Une identité ne peut pas précéder l'un de ses deux bouts.
   *
   * Datée avant l'entrée en scène du second nœud, elle serait invisible à sa
   * propre frontière — l'union-find lirait une relation vers une entité que la
   * politique de ligne cache encore — et surtout elle affirmerait que le lecteur
   * a rapproché deux choses dont il n'en connaissait qu'une.
   */
  if (input.chapter < proposal.earliest) {
    throw new IdentifyRefusal(
      `Le second nœud n’entre en scène qu’au chapitre ${proposal.earliest} : ` +
        `une identité datée du ${input.chapter} rapprocherait quelque chose que le ` +
        `lecteur n’a pas encore rencontré.`,
    )
  }

  await withIngest(async (db) => {
    await db.insert(assertions).values({
      workId: await workOf(db, userId, input.entityId),
      userId,
      subjectEntityId: input.entityId,
      predicate: 'same_as',
      objectEntityId: input.otherId,
      knowledgeFromChapter: input.chapter,
      observedInChapter: input.chapter,
      confidence: 1,
      epistemicStatus: 'user_validated',
      reviewStatus: 'accepted',
      proposedBy: 'user',
      locked: true,
    })

    await db.insert(auditLog).values({
      userId,
      action: 'entities_identified',
      subjectKind: 'entity',
      subjectId: input.entityId,
      detail: {
        otherId: input.otherId,
        chapter: input.chapter,
        subject: proposal.subject.label,
        object: proposal.object.label,
      },
    })
  })

  return {
    subjectId: input.entityId,
    objectId: input.otherId,
    chapter: input.chapter,
  }
}

async function sidesOf(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  ids: string[],
): Promise<Map<string, IdentifySide>> {
  const rows = await db
    .select({
      id: entities.id,
      nodeType: entities.nodeType,
      firstSeenChapter: entities.firstSeenChapter,
      label: entityLabels.label,
      kind: entityLabels.kind,
      precedence: entityLabels.precedence,
      revealedInChapter: entityLabels.revealedInChapter,
    })
    .from(entities)
    .leftJoin(entityLabels, eq(entityLabels.entityId, entities.id))
    .where(and(eq(entities.userId, userId), inArray(entities.id, ids)))
    .orderBy(desc(entityLabels.precedence), desc(entityLabels.revealedInChapter))

  const out = new Map<string, IdentifySide>()
  for (const row of rows) {
    if (out.has(row.id)) continue
    out.set(row.id, {
      id: row.id,
      label: row.label ?? 'entité sans nom',
      nodeType: row.nodeType,
      firstSeenChapter: row.firstSeenChapter,
    })
  }
  return out
}

/**
 * Lequel des deux porte le nom qui arrive.
 *
 * Le vrai nom d'abord ; à défaut, le nœud entré en scène le plus tard, qui est
 * celui que le chapitre vient de nommer. Null quand ni l'un ni l'autre ne porte
 * de vrai nom — deux descriptions rapprochées, ce qui est légitime et ne se
 * date pas depuis un texte.
 */
async function namedSide(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  a: IdentifySide,
  b: IdentifySide,
): Promise<IdentifySide | null> {
  const rows = await db
    .select({ entityId: entityLabels.entityId, label: entityLabels.label })
    .from(entityLabels)
    .where(
      and(
        eq(entityLabels.userId, userId),
        inArray(entityLabels.entityId, [a.id, b.id]),
        eq(entityLabels.kind, 'true_name'),
      ),
    )
    .orderBy(desc(entityLabels.revealedInChapter))

  const later = a.firstSeenChapter >= b.firstSeenChapter ? a : b
  const earlier = later === a ? b : a

  for (const candidate of [later, earlier]) {
    const row = rows.find((entry) => entry.entityId === candidate.id)
    if (row) return { ...candidate, label: row.label }
  }
  return null
}

/**
 * Le premier chapitre dont une source écrit ce nom.
 *
 * La question de `naming.ts`, posée ici pour dater plutôt que pour refuser, et
 * sur les mêmes lignes : un mot entier, et rien quand le mot n'est nulle part.
 */
async function firstChapterNaming(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  name: string,
): Promise<number | null> {
  const needle = normalizeText(name)
  if (needle.length < 3) return null

  const pattern = `\\y${needle.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}\\y`

  const rows = await db
    .select({ first: sql<number | null>`min(${chapters.number})` })
    .from(textBlocks)
    .innerJoin(chapters, eq(chapters.id, textBlocks.chapterId))
    .where(
      and(eq(chapters.userId, userId), sql`${textBlocks.normalizedText} ~ ${pattern}`),
    )

  return rows[0]?.first ?? null
}

async function workOf(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  entityId: string,
): Promise<string> {
  const [row] = await db
    .select({ workId: entities.workId })
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.id, entityId)))
    .limit(1)
  if (!row) throw new IdentifyRefusal('Fiche introuvable.')
  return row.workId
}
