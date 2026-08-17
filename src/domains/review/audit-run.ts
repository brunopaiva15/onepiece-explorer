import 'server-only'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import {
  assertions,
  auditFindings,
  auditLog,
  auditReads,
  entities,
  entityLabels,
  events,
} from '@/db/schema/knowledge.ts'
import { LABEL_PRECEDENCE } from '@/db/schema/enums.ts'
import {
  auditStorySnapshot,
  firstWrittenChapters,
  parseRelecture,
  relectureFinding,
  type AuditEntity,
  type AuditFinding,
  type AuditFix,
  type AuditSnapshot,
} from './audit.ts'

/**
 * Le balayage de toute l'histoire : le charger, l'écrire, l'appliquer.
 *
 * `audit.ts` porte les règles et se teste sans base ; celui-ci porte les trois
 * choses qui demandent une base, et rien d'autre.
 *
 *   **Charger.** Cinq lectures, pas une par entité. Une bibliothèque de mille
 *   chapitres tient en mémoire — quelques milliers de nœuds, quelques dizaines
 *   de milliers de mots — et la lire en une fois est ce qui permet aux règles
 *   d'être écrites contre des tableaux plutôt que contre des requêtes.
 *
 *   **Écrire.** Un constat déjà écarté le reste, et un défaut corrigé disparaît
 *   de la liste. Les deux tiennent à l'empreinte : elle identifie le constat, pas
 *   la ligne, donc un second balayage retrouve le même et n'en ajoute pas un
 *   deuxième.
 *
 *   **Appliquer.** Une écriture par correction, chacune réversible en une
 *   requête, chacune journalisée. Rien n'est supprimé : un nœud en trop passe en
 *   « rejeté » et une identité fausse aussi, ce qui est la façon dont ce système
 *   dit « ce fait est faux » depuis l'ADR 0002.
 *
 * Tout passe par `withIngest` : ce sont des questions sur la bibliothèque — quels
 * noms existent, à quel chapitre — et non sur ce que le lecteur a lu. La
 * politique de frontière les rendrait fausses plutôt que sûres, ce qui est
 * précisément pourquoi les deux tables de la 0029 sont refusées au rôle du
 * lecteur.
 */

/** Les prédicats lus par les règles, en plus de l'identité. */
const MEMBERSHIP_PREDICATES = [
  'member_of',
  'secretly_member_of',
  'part_of',
  'part_of_place',
  'captain_of',
  'leads',
]

export interface SweepReport {
  /** Nœuds pesés par les règles. */
  entities: number
  /** Chapitres dont le texte a servi à dater les noms. */
  chapters: number
  found: number
  /** Ceux que le balayage précédent ne connaissait pas. */
  fresh: number
  /** Constats dont le défaut a disparu depuis, retirés de la liste. */
  resolved: number
}

/**
 * Passer toute la bibliothèque sous les règles.
 *
 * Gratuit et sans modèle, donc relançable autant qu'on veut : c'est ce qui
 * permet de corriger, relancer, et voir la liste raccourcir.
 */
export async function sweepStory(userId: string, workId: string): Promise<SweepReport> {
  const snapshot = await loadSnapshot(userId, workId)
  const findings = auditStorySnapshot(snapshot)

  const { fresh, resolved } = await writeFindings(userId, workId, findings, 'regles')

  return {
    entities: snapshot.entities.length,
    chapters: snapshot.chapterCount,
    found: findings.length,
    fresh,
    resolved,
  }
}

interface LoadedSnapshot extends AuditSnapshot {
  chapterCount: number
}

/**
 * La bibliothèque, en cinq lectures.
 *
 * L'ordre compte pour la dernière seulement : les noms à chercher dans les
 * sources sont ceux que les entités portent, donc le texte est indexé après
 * elles et contre leur liste plutôt que contre tout le vocabulaire.
 */
async function loadSnapshot(userId: string, workId: string): Promise<LoadedSnapshot> {
  return withIngest(async (db) => {
    const labelRows = (await db.execute(sql`
      SELECT en.id, en.node_type, en.first_seen_chapter,
             l.id AS label_id, l.label, l.normalized_label, l.kind::text AS kind,
             l.revealed_in_chapter, l.precedence
        FROM entities en
        LEFT JOIN entity_labels l ON l.entity_id = en.id
       WHERE en.user_id = ${userId} AND en.work_id = ${workId}
         AND en.review_status = 'accepted'
    `)) as unknown as Array<{
      id: string
      node_type: string
      first_seen_chapter: number
      label_id: string | null
      label: string | null
      normalized_label: string | null
      kind: string | null
      revealed_in_chapter: number | null
      precedence: number | null
    }>

    const byEntity = new Map<string, AuditEntity>()
    for (const row of labelRows) {
      let entity = byEntity.get(row.id)
      if (!entity) {
        entity = {
          id: row.id,
          nodeType: row.node_type,
          firstSeenChapter: Number(row.first_seen_chapter),
          labels: [],
        }
        byEntity.set(row.id, entity)
      }
      if (row.label_id === null || row.label === null) continue
      entity.labels.push({
        id: row.label_id,
        label: row.label,
        normalized: row.normalized_label ?? '',
        kind: row.kind ?? 'alias',
        revealedInChapter:
          row.revealed_in_chapter === null ? null : Number(row.revealed_in_chapter),
        precedence: Number(row.precedence ?? 0),
      })
    }

    const relationRows = await db
      .select({
        id: assertions.id,
        subjectEntityId: assertions.subjectEntityId,
        objectEntityId: assertions.objectEntityId,
        predicate: assertions.predicate,
        knowledgeFromChapter: assertions.knowledgeFromChapter,
      })
      .from(assertions)
      .where(
        and(
          eq(assertions.userId, userId),
          eq(assertions.workId, workId),
          eq(assertions.reviewStatus, 'accepted'),
          isNotNull(assertions.objectEntityId),
          inArray(assertions.predicate, ['same_as', ...MEMBERSHIP_PREDICATES]),
        ),
      )

    const eventRows = (await db.execute(sql`
      SELECT e.entity_id, e.summary,
             COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) AS chapter,
             extract(epoch FROM e.created_at) AS created
        FROM events e
        JOIN entities en ON en.id = e.entity_id
       WHERE e.user_id = ${userId} AND e.work_id = ${workId}
         AND en.review_status = 'accepted'
         AND e.summary IS NOT NULL
    `)) as unknown as Array<{
      entity_id: string
      summary: string
      chapter: number
      created: number
    }>

    const sourceRows = (await db.execute(sql`
      SELECT c.number,
             string_agg(t.normalized_text, ' ' ORDER BY t.reading_order) AS text
        FROM text_blocks t
        JOIN chapters c ON c.id = t.chapter_id
       WHERE c.user_id = ${userId} AND c.work_id = ${workId}
         AND c.status = 'published'
       GROUP BY c.number
       ORDER BY c.number
    `)) as unknown as Array<{ number: number; text: string | null }>

    const sources = sourceRows.map((row) => ({
      chapter: Number(row.number),
      normalizedText: row.text ?? '',
    }))

    const entityList = [...byEntity.values()]
    const firstWritten = firstWrittenChapters(
      sources,
      entityList.flatMap((entity) => entity.labels.map((label) => label.normalized)),
    )

    return {
      entities: entityList,
      identities: relationRows
        .filter((row) => row.predicate === 'same_as' && row.objectEntityId !== null)
        .map((row) => ({
          assertionId: row.id,
          subjectEntityId: row.subjectEntityId,
          objectEntityId: row.objectEntityId!,
          knowledgeFromChapter: row.knowledgeFromChapter,
        })),
      memberships: relationRows
        .filter((row) => row.predicate !== 'same_as' && row.objectEntityId !== null)
        .map((row) => ({
          subjectEntityId: row.subjectEntityId,
          objectEntityId: row.objectEntityId!,
          predicate: row.predicate,
        })),
      events: eventRows.map((row) => ({
        entityId: row.entity_id,
        chapter: Number(row.chapter),
        summary: row.summary,
        createdAt: Number(row.created),
      })),
      firstWritten,
      chapterCount: sources.length,
    }
  })
}

/**
 * Les constats, écrits sans écraser une décision.
 *
 * `DO UPDATE ... WHERE status = 'open'` est la moitié qui compte : un constat
 * écarté est retrouvé à chaque balayage — le défaut est toujours là, c'est le
 * jugement qui a changé — et le réécrire le rouvrirait. La formulation d'un
 * constat encore ouvert, elle, est rafraîchie : les règles s'améliorent, et une
 * vieille phrase à côté d'une liste à jour se lit comme un bug.
 *
 * Le nettoyage ne vise que la source qui vient d'être rejouée. Les constats des
 * règles disparaissent quand le défaut disparaît, ce qui est vérifiable en les
 * recalculant ; ceux d'une relecture ont coûté un appel par chapitre et ne se
 * recalculent pas — les effacer parce qu'on a balayé les règles serait jeter ce
 * qui a été payé.
 */
async function writeFindings(
  userId: string,
  workId: string,
  findings: AuditFinding[],
  source: 'regles' | 'modele',
  /** Ce que ce passage a examiné : hors de ce périmètre, rien n'est nettoyé. */
  scope?: { chapters: number[] },
): Promise<{ fresh: number; resolved: number }> {
  return withIngest(async (db) => {
    const before = await db
      .select({ fingerprint: auditFindings.fingerprint })
      .from(auditFindings)
      .where(
        and(
          eq(auditFindings.userId, userId),
          eq(auditFindings.workId, workId),
          eq(auditFindings.source, source),
        ),
      )
    const known = new Set(before.map((row) => row.fingerprint))
    const seen = new Set(findings.map((finding) => finding.fingerprint))

    if (findings.length > 0) {
      await db
        .insert(auditFindings)
        .values(
          findings.map((finding) => ({
            userId,
            workId,
            chapter: finding.chapter,
            kind: finding.kind,
            source,
            title: finding.title,
            detail: finding.detail,
            subjectEntityId: finding.subjectEntityId,
            objectEntityId: finding.objectEntityId,
            fix: finding.fix,
            fingerprint: finding.fingerprint,
          })),
        )
        .onConflictDoUpdate({
          target: [auditFindings.userId, auditFindings.workId, auditFindings.fingerprint],
          set: {
            chapter: sql`excluded.chapter`,
            title: sql`excluded.title`,
            detail: sql`excluded.detail`,
            fix: sql`excluded.fix`,
          },
          setWhere: eq(auditFindings.status, 'open'),
        })
    }

    const stale = [...known].filter((fingerprint) => !seen.has(fingerprint))
    let resolved = 0
    if (stale.length > 0) {
      const removed = await db
        .delete(auditFindings)
        .where(
          and(
            eq(auditFindings.userId, userId),
            eq(auditFindings.workId, workId),
            eq(auditFindings.source, source),
            eq(auditFindings.status, 'open'),
            inArray(auditFindings.fingerprint, stale),
            ...(scope ? [inArray(auditFindings.chapter, scope.chapters)] : []),
          ),
        )
        .returning({ id: auditFindings.id })
      resolved = removed.length
    }

    return {
      fresh: findings.filter((finding) => !known.has(finding.fingerprint)).length,
      resolved,
    }
  })
}

export interface FindingRow {
  id: string
  chapter: number
  kind: string
  source: string
  title: string
  detail: string | null
  subjectEntityId: string | null
  objectEntityId: string | null
  fix: AuditFix | null
}

/** Ce qu'il reste à trancher, dans l'ordre des chapitres. */
export async function openFindings(
  userId: string,
  workId: string,
  limit = 500,
): Promise<FindingRow[]> {
  const rows = await withIngest(async (db) =>
    db
      .select({
        id: auditFindings.id,
        chapter: auditFindings.chapter,
        kind: auditFindings.kind,
        source: auditFindings.source,
        title: auditFindings.title,
        detail: auditFindings.detail,
        subjectEntityId: auditFindings.subjectEntityId,
        objectEntityId: auditFindings.objectEntityId,
        fix: auditFindings.fix,
      })
      .from(auditFindings)
      .where(
        and(
          eq(auditFindings.userId, userId),
          eq(auditFindings.workId, workId),
          eq(auditFindings.status, 'open'),
        ),
      )
      .orderBy(asc(auditFindings.chapter), asc(auditFindings.kind))
      .limit(limit),
  )

  return rows.map((row) => ({ ...row, fix: (row.fix as AuditFix | null) ?? null }))
}

export interface AuditState {
  open: number
  ignored: number
  applied: number
  /** Chapitres publiés, et ceux que le modèle a déjà relus. */
  chapters: number
  read: number
  costCents: number
}

export async function auditState(userId: string, workId: string): Promise<AuditState> {
  return withIngest(async (db) => {
    const [row] = (await db.execute(sql`
      SELECT
        (SELECT count(*) FROM audit_findings
          WHERE user_id = ${userId} AND work_id = ${workId} AND status = 'open')::int AS open,
        (SELECT count(*) FROM audit_findings
          WHERE user_id = ${userId} AND work_id = ${workId} AND status = 'ignored')::int AS ignored,
        (SELECT count(*) FROM audit_findings
          WHERE user_id = ${userId} AND work_id = ${workId} AND status = 'applied')::int AS applied,
        (SELECT count(*) FROM chapters
          WHERE user_id = ${userId} AND work_id = ${workId} AND status = 'published')::int AS chapters,
        (SELECT count(*) FROM audit_reads
          WHERE user_id = ${userId} AND work_id = ${workId})::int AS read,
        (SELECT COALESCE(sum(cost_cents), 0) FROM audit_reads
          WHERE user_id = ${userId} AND work_id = ${workId}) AS cost
    `)) as unknown as Array<{
      open: number
      ignored: number
      applied: number
      chapters: number
      read: number
      cost: string | number
    }>

    return {
      open: Number(row?.open ?? 0),
      ignored: Number(row?.ignored ?? 0),
      applied: Number(row?.applied ?? 0),
      chapters: Number(row?.chapters ?? 0),
      read: Number(row?.read ?? 0),
      costCents: Number(row?.cost ?? 0),
    }
  })
}

/** Un constat qu'on ne veut plus voir. Le défaut reste, le jugement est pris. */
export async function ignoreFinding(userId: string, findingId: string): Promise<boolean> {
  return withIngest(async (db) => {
    const updated = await db
      .update(auditFindings)
      .set({ status: 'ignored', decidedAt: new Date() })
      .where(
        and(
          eq(auditFindings.id, findingId),
          eq(auditFindings.userId, userId),
          eq(auditFindings.status, 'open'),
        ),
      )
      .returning({ id: auditFindings.id })
    return updated.length > 0
  })
}

export interface ApplyResult {
  ok: boolean
  /** Ce qui a été écrit, en une phrase, pour la page et pour le journal. */
  message: string
}

/**
 * Appliquer une correction, et une seule.
 *
 * Le constat est relu depuis la base plutôt que reçu du navigateur : une action
 * de serveur est une route POST, et l'identifiant est tout ce qu'elle a le droit
 * de croire. La correction appliquée est donc celle qui a été écrite par le
 * balayage, pas celle que la page prétend afficher.
 *
 * Rien n'est supprimé, jamais. Un nœud en trop passe en « rejeté » — la ligne
 * reste, datée, avec sa provenance, et cesse d'être lue par la politique de
 * frontière —, une identité fausse aussi. C'est réversible en une requête, et
 * c'est ce que « ce fait est faux » a toujours voulu dire ici.
 */
export async function applyFinding(userId: string, findingId: string): Promise<ApplyResult> {
  const finding = await withIngest(async (db) => {
    const [row] = await db
      .select({
        id: auditFindings.id,
        workId: auditFindings.workId,
        fix: auditFindings.fix,
        title: auditFindings.title,
        status: auditFindings.status,
      })
      .from(auditFindings)
      .where(and(eq(auditFindings.id, findingId), eq(auditFindings.userId, userId)))
      .limit(1)
    return row ?? null
  })

  if (!finding) return { ok: false, message: 'Constat introuvable.' }
  if (finding.status !== 'open') return { ok: false, message: 'Constat déjà tranché.' }

  const fix = (finding.fix as AuditFix | null) ?? null
  if (!fix) {
    return {
      ok: false,
      message: 'Ce constat n’a pas de correction automatique : il se tranche sur la fiche.',
    }
  }

  const message = await withIngest(async (db) => {
    switch (fix.action) {
      case 'rejeter_entite': {
        const updated = await db
          .update(entities)
          .set({ reviewStatus: 'rejected' })
          .where(
            and(
              eq(entities.id, fix.entityId),
              eq(entities.userId, userId),
              eq(entities.reviewStatus, 'accepted'),
            ),
          )
          .returning({ id: entities.id })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_entity_rejected',
          subjectKind: 'entity',
          subjectId: fix.entityId,
          detail: { finding: findingId, because: fix.because },
        })
        return 'Doublon retiré du fil. La fiche reste, rejetée, et se rouvre en une requête.'
      }

      case 'redater_nom': {
        const updated = await db
          .update(entityLabels)
          .set({ revealedInChapter: fix.chapter })
          .where(and(eq(entityLabels.id, fix.labelId), eq(entityLabels.userId, userId)))
          .returning({ id: entityLabels.id })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_label_redated',
          subjectKind: 'entity_label',
          subjectId: fix.labelId,
          detail: { finding: findingId, revealedInChapter: fix.chapter },
        })
        return `Nom daté du chapitre ${fix.chapter}, celui qui l’écrit en premier.`
      }

      case 'promouvoir_nom': {
        const updated = await db
          .update(entityLabels)
          .set({ precedence: LABEL_PRECEDENCE.true_name })
          .where(and(eq(entityLabels.id, fix.labelId), eq(entityLabels.userId, userId)))
          .returning({ id: entityLabels.id })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_label_promoted',
          subjectKind: 'entity_label',
          subjectId: fix.labelId,
          detail: { finding: findingId, precedence: LABEL_PRECEDENCE.true_name },
        })
        return 'La révélation se lit maintenant dans le bon sens.'
      }

      case 'retirer_identite': {
        const updated = await db
          .update(assertions)
          .set({ reviewStatus: 'rejected' })
          .where(
            and(
              eq(assertions.id, fix.assertionId),
              eq(assertions.userId, userId),
              eq(assertions.reviewStatus, 'accepted'),
            ),
          )
          .returning({ id: assertions.id })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_identity_retracted',
          subjectKind: 'assertion',
          subjectId: fix.assertionId,
          detail: { finding: findingId },
        })
        return 'Identité retirée. Les deux fiches redeviennent deux choses.'
      }

      case 'avancer_entree': {
        const updated = await db
          .update(entities)
          .set({ firstSeenChapter: fix.chapter })
          .where(and(eq(entities.id, fix.entityId), eq(entities.userId, userId)))
          .returning({ id: entities.id })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_entrance_moved',
          subjectKind: 'entity',
          subjectId: fix.entityId,
          detail: { finding: findingId, firstSeenChapter: fix.chapter },
        })
        return `Entrée en scène ramenée au chapitre ${fix.chapter}.`
      }

      case 'reecrire_scene': {
        const updated = await db
          .update(events)
          .set({ summary: fix.summary })
          .where(and(eq(events.entityId, fix.entityId), eq(events.userId, userId)))
          .returning({ entityId: events.entityId })
        if (updated.length === 0) return null
        await db.insert(auditLog).values({
          userId,
          action: 'audit_scene_rewritten',
          subjectKind: 'entity',
          subjectId: fix.entityId,
          detail: { finding: findingId, summary: fix.summary },
        })
        return 'Phrase corrigée sur le fil.'
      }
    }
  })

  if (message === null) {
    return {
      ok: false,
      message: 'Rien à corriger : la ligne visée a déjà changé depuis le balayage.',
    }
  }

  await withIngest(async (db) => {
    await db
      .update(auditFindings)
      .set({ status: 'applied', decidedAt: new Date() })
      .where(and(eq(auditFindings.id, findingId), eq(auditFindings.userId, userId)))
  })

  return { ok: true, message }
}

/**
 * Combien de passages un chapitre offre à sa relecture.
 *
 * Un chapitre écrit à la main en porte une vingtaine, un chapitre de pages
 * dessinées peut en porter deux cents — et au-delà d'un certain volume l'appel
 * coûte plus que ce qu'il rapporte, sans mieux lire. La coupe est dite dans le
 * rapport plutôt qu'appliquée en silence : un chapitre relu sur un texte tronqué
 * et déclaré propre n'est pas la même affirmation qu'un chapitre relu en entier.
 */
const PASSAGES_PER_CHAPTER = 120

/** Et combien de scènes lui sont soumises. Au-delà, le fil n'est plus lisible. */
const SCENES_PER_CHAPTER = 40

export interface RelectureReport {
  read: number
  found: number
  costCents: number
  remaining: number
  /** Les chapitres dont l'appel a échoué, avec leur raison. */
  failures: Array<{ chapter: number; reason: string }>
  /** Chapitres dont le texte a été tronqué avant d'être lu. */
  truncated: number[]
  error?: string
}

/**
 * Relire les chapitres que le modèle n'a pas encore lus, quelques-uns à la fois.
 *
 * Ce que les règles ne peuvent pas trouver : une phrase fausse. « Usopp devient
 * capitaine de l'équipage » est bien datée, bien reliée, bien formée — et le
 * chapitre dit le contraire. Aucune règle sur des dates ne voit ça ; il faut
 * relire le chapitre, ce qui coûte un appel.
 *
 * Par petits paquets, et repris là où il s'est arrêté : `audit_reads` retient ce
 * qui a été lu, donc une interruption — un plafond de durée, un onglet fermé, un
 * modèle surchargé — ne coûte que le paquet en cours. C'est la même discipline
 * que les points de reprise du pipeline, pour la même raison : ce qui se paye au
 * chapitre doit se perdre au chapitre.
 *
 * Un fournisseur qui ne lit pas est refusé plutôt que subi. Les modes synthétique
 * et rejeu répondent en comparant des mots ; ils reprocheraient des phrases avec
 * l'aplomb d'une vraie lecture, et une correction proposée par eux serait pire
 * que pas de relecture du tout.
 */
export async function readStoryWithModel(
  userId: string,
  workId: string,
  batch = 4,
): Promise<RelectureReport> {
  const provider = modelProvider()
  if (provider.name === 'replay' || provider.name === 'synthetic') {
    return {
      read: 0,
      found: 0,
      costCents: 0,
      remaining: 0,
      failures: [],
      truncated: [],
      error:
        `Fournisseur « ${provider.name} » : il ne lit pas les chapitres, il compare ` +
        `des mots. Configurez CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ou un ` +
        `modèle local.`,
    }
  }

  const pending = await unreadChapters(userId, workId)
  const selected = pending.slice(0, Math.max(1, batch))

  const report: RelectureReport = {
    read: 0,
    found: 0,
    costCents: 0,
    remaining: pending.length,
    failures: [],
    truncated: [],
  }

  for (const chapter of selected) {
    const material = await chapterMaterial(userId, workId, chapter)

    if (material.truncated) report.truncated.push(chapter)

    // Un chapitre sans scène ou sans texte n'a rien à se faire reprocher, et
    // marquer sa lecture évite de le reproposer à chaque paquet.
    if (material.scenes.length === 0 || material.passages.length === 0) {
      await markRead(userId, workId, chapter, { modelId: null, costCents: 0, findings: 0 })
      report.read += 1
      report.remaining -= 1
      continue
    }

    let answer
    try {
      answer = await provider.answer({
        question: relectureQuestion(chapter),
        context: [
          ...material.scenes.map((scene) => ({
            assertionId: scene.entityId,
            chapter,
            statement: `scène ${scene.entityId} : ${scene.summary}`,
            excerpt: null,
          })),
          ...material.passages.map((passage, index) => ({
            assertionId: `p${index + 1}`,
            chapter,
            statement: passage,
            excerpt: null,
          })),
        ],
        boundaryChapter: chapter,
      })
    } catch (error) {
      report.failures.push({
        chapter,
        reason: error instanceof Error ? error.message.split('\n')[0]! : String(error),
      })
      continue
    }

    report.costCents += answer.usage.costCents

    const read = answer.refusal ? null : answer.value
    const rows = read
      ? parseRelecture(
          read.answer,
          material.scenes.map((scene) => scene.entityId),
        )
      : []

    /*
     * La citation, quand la ligne n'en portait pas.
     *
     * Le format demande la phrase en quatrième champ, et un modèle la met
     * parfois là où l'appel a un endroit pour les citations. Les deux valent :
     * ce qui est refusé plus bas n'est pas l'endroit d'où vient la phrase, c'est
     * qu'elle ne soit pas dans le chapitre.
     */
    const citations = new Map(
      (read?.citations ?? []).map((citation) => [citation.assertion_id, citation.excerpt]),
    )

    const findings = rows
      .map((row) => {
        const scene = material.scenes.find((candidate) => candidate.entityId === row.entityId)
        if (!scene) return null
        return relectureFinding({
          chapter,
          entityId: row.entityId,
          summary: scene.summary,
          objection: row.objection,
          excerpt: row.excerpt.length > 0 ? row.excerpt : (citations.get(row.entityId) ?? ''),
          passages: material.passages,
          correction: row.correction,
        })
      })
      .filter((finding): finding is AuditFinding => finding !== null)

    /*
     * Bornée à ce chapitre, et c'est vital.
     *
     * Le nettoyage retire les constats que le passage courant n'a pas retrouvés
     * — juste pour les règles, qui repassent sur toute la bibliothèque. Une
     * relecture ne lit que quatre chapitres : sans cette borne, relire le 12
     * effacerait tout ce que les cent quarante autres avaient trouvé, c'est-à-
     * dire tout ce qui a été payé.
     */
    await writeFindings(userId, workId, findings, 'modele', { chapters: [chapter] })

    await markRead(userId, workId, chapter, {
      modelId: answer.usage.modelId,
      costCents: answer.usage.costCents,
      findings: findings.length,
    })

    report.read += 1
    report.found += findings.length
    report.remaining -= 1
  }

  return report
}

/**
 * La consigne, écrite pour être refusable.
 *
 * Le défaut d'un modèle à qui l'on demande « qu'est-ce qui cloche » est de
 * trouver quelque chose : il reformulera une phrase juste pour avoir répondu. La
 * consigne dit donc, dans cet ordre, que ne rien trouver est la réponse
 * attendue, que le savoir extérieur ne compte pas, et que la seule preuve
 * admise est une phrase recopiée du chapitre.
 *
 * Et jamais un chapitre suivant. Le modèle connaît One Piece ; si on le laisse
 * corriger une scène du chapitre 41 avec ce qu'il sait du 100, il écrit dans le
 * fil un savoir que le lecteur n'a pas — c'est-à-dire exactement le défaut que
 * ce produit existe pour ne pas commettre.
 */
function relectureQuestion(chapter: number): string {
  return (
    `Voici les scènes que la bibliothèque raconte du chapitre ${chapter}, puis les ` +
    `passages de ce chapitre. Pour chaque scène, la question est : les passages ` +
    `disent-ils bien cela ?\n\n` +
    `Ne signalez qu'une scène que les passages **contredisent** ou qui affirme ce ` +
    `qu'aucun d'eux ne dit. Une scène juste mais moins détaillée que le chapitre ` +
    `n'est pas une erreur. Ne vous servez jamais de ce que vous savez de la suite : ` +
    `seuls ces passages comptent, et une correction tirée d'un chapitre ultérieur ` +
    `serait un spoiler écrit dans le fil.\n\n` +
    `Répondez une ligne par scène fautive, exactement dans cette forme :\n` +
    `identifiant de la scène | ce que les passages contredisent | la phrase corrigée | la phrase du chapitre qui le prouve\n\n` +
    `La phrase du chapitre doit être recopiée mot pour mot depuis un passage. ` +
    `Mettez « - » à la place de la phrase corrigée si vous n'en proposez pas. ` +
    `Si aucune scène n'est fautive, répondez « insufficient_data » et rien d'autre : ` +
    `c'est la réponse la plus fréquente et la plus utile.`
  )
}

async function unreadChapters(userId: string, workId: string): Promise<number[]> {
  const rows = (await withIngest(async (db) =>
    db.execute(sql`
      SELECT c.number
        FROM chapters c
       WHERE c.user_id = ${userId} AND c.work_id = ${workId}
         AND c.status = 'published'
         AND NOT EXISTS (
           SELECT 1 FROM audit_reads r
            WHERE r.user_id = c.user_id AND r.work_id = c.work_id
              AND r.chapter = c.number)
       ORDER BY c.number
    `),
  )) as unknown as Array<{ number: number }>

  return rows.map((row) => Number(row.number))
}

interface ChapterMaterial {
  scenes: Array<{ entityId: string; summary: string }>
  passages: string[]
  truncated: boolean
}

async function chapterMaterial(
  userId: string,
  workId: string,
  chapter: number,
): Promise<ChapterMaterial> {
  return withIngest(async (db) => {
    const sceneRows = (await db.execute(sql`
      SELECT e.entity_id, e.summary
        FROM events e
        JOIN entities en ON en.id = e.entity_id
       WHERE e.user_id = ${userId} AND e.work_id = ${workId}
         AND en.review_status = 'accepted'
         AND e.summary IS NOT NULL
         AND COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}
       ORDER BY e.created_at
       LIMIT ${SCENES_PER_CHAPTER}
    `)) as unknown as Array<{ entity_id: string; summary: string }>

    const passageRows = (await db.execute(sql`
      SELECT t.text
        FROM text_blocks t
        JOIN chapters c ON c.id = t.chapter_id
       WHERE c.user_id = ${userId} AND c.work_id = ${workId}
         AND c.number = ${chapter} AND c.status = 'published'
       ORDER BY t.reading_order
       LIMIT ${PASSAGES_PER_CHAPTER + 1}
    `)) as unknown as Array<{ text: string }>

    return {
      scenes: sceneRows.map((row) => ({ entityId: row.entity_id, summary: row.summary })),
      passages: passageRows.slice(0, PASSAGES_PER_CHAPTER).map((row) => row.text),
      truncated: passageRows.length > PASSAGES_PER_CHAPTER,
    }
  })
}

async function markRead(
  userId: string,
  workId: string,
  chapter: number,
  input: { modelId: string | null; costCents: number; findings: number },
): Promise<void> {
  await withIngest(async (db) => {
    await db
      .insert(auditReads)
      .values({
        userId,
        workId,
        chapter,
        modelId: input.modelId,
        costCents: input.costCents,
        findings: input.findings,
      })
      .onConflictDoUpdate({
        target: [auditReads.userId, auditReads.workId, auditReads.chapter],
        set: {
          modelId: input.modelId,
          costCents: input.costCents,
          findings: input.findings,
          readAt: new Date(),
        },
      })
  })
}

/**
 * Tout relire à nouveau, en repayant.
 *
 * Le seul geste qui efface `audit_reads`, et il existe parce que la consigne
 * évolue : une relecture faite avec une question moins précise a laissé passer
 * ce qu'une meilleure trouverait, et rien d'autre ne permet de la refaire.
 */
export async function forgetReadings(userId: string, workId: string): Promise<number> {
  return withIngest(async (db) => {
    const removed = await db
      .delete(auditReads)
      .where(and(eq(auditReads.userId, userId), eq(auditReads.workId, workId)))
      .returning({ chapter: auditReads.chapter })
    return removed.length
  })
}
