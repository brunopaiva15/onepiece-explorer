import 'server-only'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import {
  assertions,
  auditFindings,
  auditLog,
  auditPasses,
  entities,
  entityLabels,
  events,
} from '@/db/schema/knowledge.ts'
import { LABEL_PRECEDENCE } from '@/db/schema/enums.ts'
import { renameEntityLabel } from '@/domains/knowledge/rename.ts'
import {
  auditStorySnapshot,
  firstWrittenChapters,
  type AuditEntity,
  type AuditFinding,
  type AuditFix,
  type AuditSnapshot,
} from './audit.ts'
import { soundResolutions } from './mystery-audit.ts'
import { ANALYSES, type AnalysisKind, type PassRecord, type SubjectKind } from './analyses.ts'

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

    /*
     * Ce que chaque identité cite, quand elle cite quelque chose.
     *
     * Une seule lecture pour toutes, et la plus longue citation gagne : une
     * relation peut porter plusieurs preuves, et celle qui explique le mieux ce
     * qu'elle affirme est celle qui en dit le plus. Une identité écrite à la
     * main n'en a aucune, et le null se lit comme ce qu'il est — la parole du
     * lecteur, qu'aucune règle d'ici ne conteste.
     */
    const excerptRows = (await db.execute(sql`
      SELECT DISTINCT ON (a.id) a.id, ev.excerpt
        FROM assertions a
        JOIN evidence ev ON ev.assertion_id = a.id
       WHERE a.user_id = ${userId} AND a.work_id = ${workId}
         AND a.predicate = 'same_as' AND a.review_status = 'accepted'
         AND ev.excerpt IS NOT NULL
       ORDER BY a.id, length(ev.excerpt) DESC
    `)) as unknown as Array<{ id: string; excerpt: string }>

    const excerpts = new Map(excerptRows.map((row) => [row.id, row.excerpt]))

    const mysteryRows = (await db.execute(sql`
      SELECT m.entity_id, m.question, m.opened_in_chapter, m.state::text AS state,
             m.resolved_in_chapter
        FROM mysteries m
        JOIN entities en ON en.id = m.entity_id
       WHERE m.user_id = ${userId} AND m.work_id = ${workId}
         AND en.review_status = 'accepted'
       ORDER BY m.opened_in_chapter
    `)) as unknown as Array<{
      entity_id: string
      question: string
      opened_in_chapter: number
      state: string
      resolved_in_chapter: number | null
    }>

    /*
     * Les réponses écrites, datées par la **scène** et non par la relation.
     *
     * `knowledge_from_chapter` est ce que le balayage a écrit, et c'est
     * précisément ce qu'on soupçonne : une résolution datée du chapitre où la
     * passe tournait plutôt que de celui où la scène se joue. La date qui fait
     * foi est donc relue dans `events`, où elle vient du chapitre lui-même.
     */
    const resolutionRows = (await db.execute(sql`
      SELECT a.id, a.subject_entity_id, a.object_entity_id,
             COALESCE(e.shown_in_chapter, e.told_in_chapter, a.knowledge_from_chapter) AS chapter
        FROM assertions a
        LEFT JOIN events e ON e.entity_id = a.subject_entity_id
       WHERE a.user_id = ${userId} AND a.work_id = ${workId}
         AND a.predicate = 'resolves_mystery' AND a.review_status = 'accepted'
         AND a.object_entity_id IS NOT NULL
    `)) as unknown as Array<{
      id: string
      subject_entity_id: string
      object_entity_id: string
      chapter: number
    }>

    /*
     * D'où vient la preuve de chaque scène.
     *
     * Les natures des pages citées et celles des preuves elles-mêmes, agrégées
     * par scène — une scène dont *toutes* les preuves viennent d'une couverture
     * n'appartient pas au fil principal. `structured` dit si le chapitre a des
     * pages du tout : un chapitre importé en résumé n'a rien à lire, et la
     * règle se tait plutôt que de conclure d'une absence.
     *
     * Les preuves sont cherchées des deux côtés de la relation : une scène est
     * tantôt le sujet d'un fait — « le combat oppose X à Y » — tantôt son objet
     * — « X prend part à la scène ».
     */
    const provenanceRows = (await db.execute(sql`
      SELECT e.entity_id, e.summary,
             COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) AS chapter,
             array_remove(array_agg(DISTINCT p.kind::text), NULL) AS page_kinds,
             array_remove(array_agg(DISTINCT ev.kind::text), NULL) AS evidence_kinds,
             EXISTS (SELECT 1 FROM pages pg
                      WHERE pg.chapter_id = c.id AND pg.user_id = ${userId}) AS structured
        FROM events e
        JOIN entities en ON en.id = e.entity_id
        JOIN chapters c ON c.user_id = e.user_id AND c.work_id = e.work_id
         AND c.number = COALESCE(e.told_in_chapter, e.shown_in_chapter, 0)
        LEFT JOIN assertions a ON a.user_id = e.user_id
         AND a.review_status = 'accepted'
         AND (a.subject_entity_id = e.entity_id OR a.object_entity_id = e.entity_id)
        LEFT JOIN evidence ev ON ev.assertion_id = a.id
        LEFT JOIN pages p ON p.id = ev.page_id
       WHERE e.user_id = ${userId} AND e.work_id = ${workId}
         AND en.review_status = 'accepted'
         AND e.summary IS NOT NULL
       GROUP BY e.entity_id, e.summary, chapter, c.id
    `)) as unknown as Array<{
      entity_id: string
      summary: string
      chapter: number
      page_kinds: string[] | null
      evidence_kinds: string[] | null
      structured: boolean
    }>

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
          excerpt: excerpts.get(row.id) ?? null,
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
      mysteries: mysteryRows.map((row) => ({
        entityId: row.entity_id,
        question: row.question,
        openedInChapter: Number(row.opened_in_chapter),
        state: row.state,
        resolvedInChapter:
          row.resolved_in_chapter === null ? null : Number(row.resolved_in_chapter),
      })),
      resolutions: resolutionRows.map((row) => ({
        assertionId: row.id,
        sceneEntityId: row.subject_entity_id,
        mysteryEntityId: row.object_entity_id,
        chapter: Number(row.chapter),
      })),
      provenance: provenanceRows.map((row) => ({
        entityId: row.entity_id,
        chapter: Number(row.chapter),
        summary: row.summary,
        pageKinds: row.page_kinds ?? [],
        evidenceKinds: row.evidence_kinds ?? [],
        structured: row.structured,
      })),
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
 * Le nettoyage ne vise que **l'analyse et les sujets qui viennent d'être
 * rejoués**, et c'est la borne la plus importante de ce fichier. Les constats
 * des règles disparaissent quand le défaut disparaît, ce qui est vérifiable en
 * les recalculant ; ceux d'une lecture ont coûté un appel chacun et ne se
 * recalculent pas. Sans cette borne, relire une question effacerait ce que les
 * cent quarante autres et les cent cinquante chapitres avaient trouvé,
 * c'est-à-dire tout ce qui a été payé — et la page annoncerait fièrement
 * « 0 constat » après une passe de dix secondes.
 *
 * Les règles n'ont pas de sujet : elles repassent sur toute la bibliothèque à
 * chaque fois, donc leur périmètre est leur analyse entière. Une lecture en a
 * toujours un, et ne touche qu'à lui.
 */
export async function writeFindings(
  userId: string,
  workId: string,
  findings: AuditFinding[],
  analysis: AnalysisKind,
  /**
   * Les sujets que ce passage a examinés : hors de ce périmètre, rien n'est
   * nettoyé. Absent pour les règles, qui repassent sur tout.
   */
  subjects?: readonly string[],
): Promise<{ fresh: number; resolved: number }> {
  const source = analysis === 'regles' ? 'regles' : 'modele'

  return withIngest(async (db) => {
    const scope = and(
      eq(auditFindings.userId, userId),
      eq(auditFindings.workId, workId),
      eq(auditFindings.analysis, analysis),
      ...(subjects ? [inArray(auditFindings.subject, [...subjects])] : []),
    )

    const before = await db
      .select({ fingerprint: auditFindings.fingerprint })
      .from(auditFindings)
      .where(scope)

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
            analysis,
            subject: finding.subject ?? null,
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
            analysis: sql`excluded.analysis`,
            subject: sql`excluded.subject`,
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
          and(scope, eq(auditFindings.status, 'open'), inArray(auditFindings.fingerprint, stale)),
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
  /** L'analyse qui l'a produit : ce que la page annonce au-dessus du panneau. */
  analysis: string
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
        analysis: auditFindings.analysis,
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

/** Ce qu'une analyse a déjà lu, ce qu'elle a coûté, et ce qui a raté. */
export interface AnalysisState {
  analysis: AnalysisKind
  read: number
  failed: number
  costCents: number
  findings: number
}

export interface AuditState {
  open: number
  ignored: number
  applied: number
  /** Chapitres publiés : le dénominateur des analyses qui portent sur eux. */
  chapters: number
  /** Identités acceptées et questions ouvertes : les deux autres dénominateurs. */
  identities: number
  mysteries: number
  /** Ce que toutes les lectures ont coûté, ensemble. */
  costCents: number
  /** Une ligne par analyse déjà lancée, pour que chaque panneau dise la sienne. */
  analyses: AnalysisState[]
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
        (SELECT count(*) FROM assertions a
          WHERE a.user_id = ${userId} AND a.work_id = ${workId}
            AND a.predicate = 'same_as' AND a.review_status = 'accepted'
            AND NOT EXISTS (
              SELECT 1 FROM audit_findings f
               WHERE f.user_id = a.user_id AND f.work_id = a.work_id
                 AND f.analysis = 'regles' AND f.status = 'open'
                 AND f.fix->>'action' = 'retirer_identite'
                 AND f.fix->>'assertionId' = a.id::text))::int AS identities,
        (SELECT count(*) FROM mysteries
          WHERE user_id = ${userId} AND work_id = ${workId})::int AS mysteries
    `)) as unknown as Array<{
      open: number
      ignored: number
      applied: number
      chapters: number
      identities: number
      mysteries: number
    }>

    const passRows = (await db.execute(sql`
      SELECT analysis,
             count(*) FILTER (WHERE ok)::int AS read,
             count(*) FILTER (WHERE NOT ok)::int AS failed,
             COALESCE(sum(cost_cents), 0) AS cost,
             COALESCE(sum(findings), 0)::int AS findings
        FROM audit_passes
       WHERE user_id = ${userId} AND work_id = ${workId}
       GROUP BY analysis
    `)) as unknown as Array<{
      analysis: string
      read: number
      failed: number
      cost: string | number
      findings: number
    }>

    const analyses = passRows.map((pass) => ({
      analysis: pass.analysis as AnalysisKind,
      read: Number(pass.read),
      failed: Number(pass.failed),
      costCents: Number(pass.cost),
      findings: Number(pass.findings),
    }))

    return {
      open: Number(row?.open ?? 0),
      ignored: Number(row?.ignored ?? 0),
      applied: Number(row?.applied ?? 0),
      chapters: Number(row?.chapters ?? 0),
      identities: Number(row?.identities ?? 0),
      mysteries: Number(row?.mysteries ?? 0),
      costCents: analyses.reduce((total, pass) => total + pass.costCents, 0),
      analyses,
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

  /*
   * Le raccourci d'un libellé passe par le renommage, et hors de la transaction
   * des autres corrections.
   *
   * Hors, parce que `renameEntityLabel` ouvre la sienne et que le pool
   * d'ingestion n'a qu'une connexion : une transaction imbriquée attendrait une
   * connexion que la première détient, ce qui ne serait pas lent mais définitif
   * (voir tests/db/ingest-nesting).
   */
  const message =
    fix.action === 'raccourcir_libelle'
      ? await shortenLabel(userId, findingId, fix)
      : fix.action === 'proposer_identite'
        ? await queueIdentityCard(userId, finding.workId, findingId, fix)
        : await writeFix(userId, findingId, fix)

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
 * L'écriture d'une correction mécanique : une requête, journalisée.
 *
 * Extrait d'`applyFinding` quand une correction a cessé d'être une requête. Le
 * raccourci d'un libellé passe par `renameEntityLabel`, qui ouvre sa propre
 * transaction — donc il ne peut pas vivre dans celle-ci, et la lisibilité des
 * deux moitiés y gagne : ici tout est un UPDATE, à côté rien ne l'est.
 *
 * Rend null quand la ligne visée n'existe plus ou a déjà changé : le balayage
 * date, et l'appelant le dit plutôt que de prétendre avoir écrit.
 */
async function writeFix(
  userId: string,
  findingId: string,
  fix: Exclude<AuditFix, { action: 'raccourcir_libelle' } | { action: 'proposer_identite' }>,
): Promise<string | null> {
  return withIngest(async (db) => {
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

      /*
       * La réponse d'une question, écrite puis recalculée.
       *
       * Deux moitiés, et l'ordre compte. La relation d'abord : c'est le fait,
       * verrouillé et donné pour ce qu'il est — votre parole, `user_validated`,
       * que la prochaine proposition d'un modèle ne pourra pas superséder.
       * L'état ensuite, et **jamais à la main** : il est refait depuis les
       * relations acceptées, ce qui est la seule façon dont la date reste vraie
       * le jour où l'une d'elles est retirée.
       *
       * Idempotent par construction : la relation n'est écrite que si la même
       * n'existe pas déjà, et le recalcul rend deux fois le même résultat. Un
       * second clic, un second onglet, un lot rejoué finissent au même endroit.
       */
      case 'publier_resolution': {
        const [scene] = await db
          .select({ entityId: events.entityId, workId: events.workId })
          .from(events)
          .where(and(eq(events.entityId, fix.sceneEntityId), eq(events.userId, userId)))
          .limit(1)
        if (!scene) return null

        const [already] = await db
          .select({ id: assertions.id })
          .from(assertions)
          .where(
            and(
              eq(assertions.userId, userId),
              eq(assertions.predicate, 'resolves_mystery'),
              eq(assertions.subjectEntityId, fix.sceneEntityId),
              eq(assertions.objectEntityId, fix.mysteryEntityId),
              eq(assertions.reviewStatus, 'accepted'),
            ),
          )
          .limit(1)

        if (!already) {
          await db.insert(assertions).values({
            workId: scene.workId,
            userId,
            subjectEntityId: fix.sceneEntityId,
            predicate: 'resolves_mystery',
            objectEntityId: fix.mysteryEntityId,
            knowledgeFromChapter: fix.chapter,
            observedInChapter: fix.chapter,
            confidence: 1,
            epistemicStatus: 'user_validated',
            reviewStatus: 'accepted',
            proposedBy: 'user',
            locked: true,
          })
        }

        const state = await recomputeMystery(db, userId, fix.mysteryEntityId)
        if (state === null) return null

        await db.insert(auditLog).values({
          userId,
          action: 'audit_mystery_resolved',
          subjectKind: 'mystery',
          subjectId: fix.mysteryEntityId,
          detail: {
            finding: findingId,
            sceneEntityId: fix.sceneEntityId,
            chapter: fix.chapter,
            resolvedInChapter: state.resolvedInChapter,
            alreadyWritten: Boolean(already),
          },
        })

        return state.resolvedInChapter === null
          ? 'Réponse écrite. La question reste ouverte : aucune relation acceptée ne la referme.'
          : `Réponse écrite, et la question refermée au chapitre ${state.resolvedInChapter}.`
      }

      /* Une réponse qui n'en est pas une. La relation passe à rejetée, et
       * l'état repart des seules qui restent. */
      case 'retirer_resolution': {
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

        const state = await recomputeMystery(db, userId, fix.mysteryEntityId)

        await db.insert(auditLog).values({
          userId,
          action: 'audit_resolution_retracted',
          subjectKind: 'assertion',
          subjectId: fix.assertionId,
          detail: {
            finding: findingId,
            mysteryEntityId: fix.mysteryEntityId,
            resolvedInChapter: state?.resolvedInChapter ?? null,
          },
        })

        return state?.resolvedInChapter === null || state === null
          ? 'Réponse retirée. La question redevient sans réponse.'
          : `Réponse retirée. La question reste refermée au chapitre ${state.resolvedInChapter}.`
      }

      /* L'état d'une question, refait depuis ses relations acceptées. Rien
       * d'autre n'est touché : aucune relation n'est écrite ni retirée. */
      case 'recalculer_mystere': {
        const state = await recomputeMystery(db, userId, fix.mysteryEntityId)
        if (state === null) return null

        await db.insert(auditLog).values({
          userId,
          action: 'audit_mystery_recomputed',
          subjectKind: 'mystery',
          subjectId: fix.mysteryEntityId,
          detail: {
            finding: findingId,
            from: state.previousChapter,
            to: state.resolvedInChapter,
          },
        })

        return state.resolvedInChapter === null
          ? 'Question rendue à « sans réponse » : aucune relation acceptée ne la referme.'
          : `Question refermée au chapitre ${state.resolvedInChapter}, celui de la première réponse acceptée.`
      }
    }
  })
}

/**
 * L'état d'une question, refait depuis ses relations acceptées.
 *
 * Le seul endroit de ce fichier qui écrive `mysteries.state`, et il ne décide
 * de rien : il lit les relations « résout le mystère » acceptées, écarte celles
 * qui n'en sont pas — une scène qui est la question elle-même, une scène du
 * chapitre qui l'a posée —, prend la plus ancienne, et recopie. Deux exécutions
 * de suite rendent la même chose, ce qui est ce qu'on demande à une correction
 * qu'un lecteur peut cliquer deux fois.
 *
 * La date vient de la **scène** et non de la relation : `knowledge_from_chapter`
 * est ce qu'un balayage a écrit, et c'est justement ce qu'on soupçonne.
 */
async function recomputeMystery(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  mysteryEntityId: string,
): Promise<{ resolvedInChapter: number | null; previousChapter: number | null } | null> {
  const [mystery] = (await db.execute(sql`
    SELECT opened_in_chapter, resolved_in_chapter
      FROM mysteries
     WHERE entity_id = ${mysteryEntityId} AND user_id = ${userId}
     LIMIT 1
  `)) as unknown as Array<{ opened_in_chapter: number; resolved_in_chapter: number | null }>

  if (!mystery) return null

  const rows = (await db.execute(sql`
    SELECT a.id, a.subject_entity_id,
           COALESCE(e.shown_in_chapter, e.told_in_chapter, a.knowledge_from_chapter) AS chapter
      FROM assertions a
      LEFT JOIN events e ON e.entity_id = a.subject_entity_id
     WHERE a.user_id = ${userId}
       AND a.predicate = 'resolves_mystery'
       AND a.object_entity_id = ${mysteryEntityId}
       AND a.review_status = 'accepted'
  `)) as unknown as Array<{ id: string; subject_entity_id: string; chapter: number }>

  const opened = Number(mystery.opened_in_chapter)
  const sound = soundResolutions({
    entityId: mysteryEntityId,
    question: '',
    openedInChapter: opened,
    state: 'open',
    resolvedInChapter: null,
    resolutions: rows.map((row) => ({
      assertionId: row.id,
      sceneEntityId: row.subject_entity_id,
      chapter: Number(row.chapter),
    })),
  })

  const resolvedInChapter =
    sound.length === 0 ? null : Math.min(...sound.map((resolution) => resolution.chapter))

  await db.execute(sql`
    UPDATE mysteries
       SET state = ${resolvedInChapter === null ? 'open' : 'resolved'}::mystery_state,
           resolved_in_chapter = ${resolvedInChapter}
     WHERE entity_id = ${mysteryEntityId} AND user_id = ${userId}
  `)

  return {
    resolvedInChapter,
    previousChapter:
      mystery.resolved_in_chapter === null ? null : Number(mystery.resolved_in_chapter),
  }
}

/**
 * Une identité proposée à la revue, jamais publiée.
 *
 * Ce que le balayage d'identités écrit depuis un script, écrit ici depuis un
 * clic, et pour la même raison : une identité est le seul jugement que
 * l'ontologie place en revue humaine obligatoire, parce qu'une fusion fausse
 * détruit la chronologie des révélations que tout ce système existe pour tenir.
 * Le bouton de cette page ne l'affirme donc pas — il la met dans la file, avec
 * sa citation, et la carte montre les deux fiches et la phrase.
 *
 * Rattachée à un run du chapitre qui révèle : le centre de revue est organisé
 * par run, et une carte sans run n'a pas de page où s'afficher. Idempotent —
 * une carte déjà en attente pour la même paire n'en fait pas naître une
 * seconde.
 */
async function queueIdentityCard(
  userId: string,
  workId: string,
  findingId: string,
  fix: Extract<AuditFix, { action: 'proposer_identite' }>,
): Promise<string | null> {
  return withIngest(async (db) => {
    const [chapter] = (await db.execute(sql`
      SELECT id FROM chapters
       WHERE work_id = ${workId} AND user_id = ${userId} AND number = ${fix.chapter}
       LIMIT 1
    `)) as unknown as Array<{ id: string }>
    if (!chapter) return null

    const [existing] = (await db.execute(sql`
      SELECT id FROM review_items
       WHERE user_id = ${userId} AND status = 'proposed' AND category = 'assertion'
         AND payload->>'subject' = ${fix.subjectEntityId}
         AND payload->>'object' = ${fix.objectEntityId}
       LIMIT 1
    `)) as unknown as Array<{ id: string }>

    if (existing) {
      return 'Une carte attend déjà cette identité dans le centre de revue.'
    }

    const [run] = (await db.execute(sql`
      SELECT id FROM ingestion_runs
       WHERE chapter_id = ${chapter.id} AND user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT 1
    `)) as unknown as Array<{ id: string }>

    let runId = run?.id
    if (!runId) {
      const [fresh] = (await db.execute(sql`
        INSERT INTO ingestion_runs (chapter_id, user_id, status, pipeline_version, provider)
        VALUES (${chapter.id}, ${userId}, 'succeeded', 'audit-identities', 'anthropic')
        RETURNING id
      `)) as unknown as Array<{ id: string }>
      runId = fresh?.id
    }
    if (!runId) return null

    const payload = {
      subject: fix.subjectEntityId,
      predicate: 'same_as',
      object: fix.objectEntityId,
      object_value: null,
      epistemic_status: 'explicit',
      confidence: 0.9,
      evidence: [{ kind: 'text', ref: fix.ref, excerpt: fix.excerpt }],
      note: fix.note,
    }

    await db.execute(sql`
      INSERT INTO review_items (
        run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${runId}, ${chapter.id}, ${userId}, 'assertion', 90,
        ${JSON.stringify(payload)}::jsonb,
        ${`audit|${findingId}`}, true, 0.9, 'proposed'
      )
    `)

    await db.insert(auditLog).values({
      userId,
      action: 'audit_identity_proposed',
      subjectKind: 'entity',
      subjectId: fix.subjectEntityId,
      detail: {
        finding: findingId,
        objectEntityId: fix.objectEntityId,
        chapter: fix.chapter,
        excerpt: fix.excerpt,
      },
    })

    return (
      'Carte écrite dans le centre de revue, avec sa citation. Rien n’est ' +
      'affirmé tant que vous ne l’avez pas acceptée.'
    )
  })
}

/**
 * Un libellé qui raconte, ramené au nom qu'il contient.
 *
 * Par le renommage plutôt que par un UPDATE, parce qu'un nom n'est pas une
 * colonne : il faut replier la ligne si l'entité porte déjà ce nom-là, garder
 * l'ancienne formulation sous le rang d'affichage — la recherche la trouve
 * encore, et c'est aussi ce qui fait qu'un prochain balayage ne repropose pas le
 * constat —, réécrire les résumés qui l'épelaient, et enregistrer la forme
 * retenue dans le glossaire pour que l'extraction des chapitres suivants la
 * reçoive. Tout cela existe et se teste ; le refaire ici écrirait un nom sans
 * son histoire.
 *
 * `renameEntityLabel` journalise déjà le renommage. La ligne écrite ici ne
 * répète pas ce qu'il dit, elle rattache le geste au constat qui l'a proposé,
 * comme toutes les autres corrections de cette page.
 */
async function shortenLabel(
  userId: string,
  findingId: string,
  fix: Extract<AuditFix, { action: 'raccourcir_libelle' }>,
): Promise<string> {
  const result = await renameEntityLabel(userId, {
    labelId: fix.labelId,
    label: fix.label,
  })

  await withIngest(async (db) => {
    await db.insert(auditLog).values({
      userId,
      action: 'audit_label_shortened',
      subjectKind: 'entity_label',
      subjectId: fix.labelId,
      detail: {
        finding: findingId,
        from: result.previousLabel,
        to: result.label,
        folded: result.folded,
      },
    })
  })

  return (
    `Libellé raccourci en « ${result.label} ». L'ancienne formulation reste, ` +
    `sans être affichée : la recherche la trouve encore.`
  )
}

/**
 * Ce qu'une analyse a déjà lu, indexé par sujet.
 *
 * Une lecture pour toute l'analyse plutôt qu'une par sujet : la question posée
 * cent cinquante fois est « ai-je déjà lu celui-ci, et avec quoi », et cent
 * cinquante requêtes pour y répondre coûtent plus que la passe qu'elles
 * évitent.
 */
export async function passesFor(
  userId: string,
  workId: string,
  analysis: AnalysisKind,
): Promise<Map<string, PassRecord>> {
  const rows = await withIngest(async (db) =>
    db
      .select({
        subjectKind: auditPasses.subjectKind,
        subject: auditPasses.subject,
        inputFingerprint: auditPasses.inputFingerprint,
        promptVersion: auditPasses.promptVersion,
      })
      .from(auditPasses)
      .where(
        and(
          eq(auditPasses.userId, userId),
          eq(auditPasses.workId, workId),
          eq(auditPasses.analysis, analysis),
        ),
      ),
  )

  return new Map(
    rows.map((row) => [
      row.subject,
      {
        analysis,
        subjectKind: row.subjectKind as SubjectKind,
        subject: row.subject,
        inputFingerprint: row.inputFingerprint,
        promptVersion: row.promptVersion,
      },
    ]),
  )
}

/**
 * Retenir qu'un sujet a été lu, ou qu'il a raté.
 *
 * Une ligne par couple (analyse, sujet), réécrite à chaque passe : ce qui
 * compte n'est pas l'historique mais l'état courant — ce sujet a-t-il été lu,
 * avec quelle matière, sous quelle consigne.
 *
 * Un échec écrit une empreinte **vide**, et c'est le détail qui rend la reprise
 * honnête : la ligne existe, donc la page peut dire ce qui a raté ; l'empreinte
 * ne correspond à rien, donc le sujet reste à lire. Écrire l'empreinte réelle
 * enterrerait le chapitre sur un accident de transport, et il ne reviendrait
 * qu'au prochain changement de consigne.
 */
export async function recordPass(
  userId: string,
  workId: string,
  pass: {
    analysis: AnalysisKind
    subjectKind: SubjectKind
    subject: string
    inputFingerprint: string
    promptVersion: string
    modelId: string | null
    costCents: number
    findings: number
    ok: boolean
    failure?: string | null
  },
): Promise<void> {
  await withIngest(async (db) => {
    await db
      .insert(auditPasses)
      .values({
        userId,
        workId,
        analysis: pass.analysis,
        subjectKind: pass.subjectKind,
        subject: pass.subject,
        inputFingerprint: pass.ok ? pass.inputFingerprint : '',
        promptVersion: pass.promptVersion,
        modelId: pass.modelId,
        costCents: pass.costCents,
        findings: pass.findings,
        ok: pass.ok,
        failure: pass.failure ?? null,
      })
      .onConflictDoUpdate({
        target: [
          auditPasses.userId,
          auditPasses.workId,
          auditPasses.analysis,
          auditPasses.subject,
        ],
        set: {
          subjectKind: sql`excluded.subject_kind`,
          inputFingerprint: sql`excluded.input_fingerprint`,
          promptVersion: sql`excluded.prompt_version`,
          modelId: sql`excluded.model_id`,
          costCents: sql`excluded.cost_cents`,
          findings: sql`excluded.findings`,
          ok: sql`excluded.ok`,
          failure: sql`excluded.failure`,
          readAt: new Date(),
        },
      })
  })
}

/**
 * Tout relire à nouveau, en repayant — une analyse à la fois.
 *
 * Le seul geste qui efface ce qui a été lu, et il est borné à une analyse :
 * vouloir relire les mystères n'est pas vouloir repayer cent cinquante
 * chapitres. Sans argument, il efface tout, ce qui reste le geste de dernière
 * instance qu'il a toujours été.
 *
 * Il existe moins qu'avant. Changer la version d'une consigne rend déjà périmée
 * l'analyse concernée, sans rien effacer et sans clic — c'est le chemin normal
 * quand la question s'améliore. Celui-ci reste pour le cas où l'on doute de la
 * lecture elle-même.
 */
export async function forgetPasses(
  userId: string,
  workId: string,
  analysis?: AnalysisKind,
): Promise<number> {
  return withIngest(async (db) => {
    const removed = await db
      .delete(auditPasses)
      .where(
        and(
          eq(auditPasses.userId, userId),
          eq(auditPasses.workId, workId),
          ...(analysis ? [eq(auditPasses.analysis, analysis)] : []),
        ),
      )
      .returning({ id: auditPasses.id })
    return removed.length
  })
}

/** Les analyses connues, pour qu'une action de serveur refuse un nom inventé. */
export function knownAnalysis(value: string): AnalysisKind | null {
  return ANALYSES.find((analysis) => analysis === value) ?? null
}
