import 'server-only'
import { asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { assertions, entities, entityLabels, evidence } from '@/db/schema/knowledge.ts'
import { storage } from '@/domains/storage/index.ts'
import { identityComponent } from './projection.ts'

/**
 * Everything known about one entity at one chapter.
 *
 * The sheet is where a claim stops being a node in a picture and becomes
 * checkable: each fact carries the chapter that revealed it and a link to the
 * panel it came from. A sheet listing facts without their sources would be a
 * wiki page with extra steps.
 *
 * Reads run at the caller's boundary, so a sheet opened at chapter 20 shows the
 * chapter-20 person — their alias then, the relations known then, and nothing
 * chapter 300 will add.
 *
 * Identifiers are bound as parameters throughout, never interpolated. `entityId`
 * arrives from a route parameter, and building an `ANY(ARRAY[…])` clause by
 * string concatenation — which is where this started — is a SQL injection with
 * a UUID-shaped hole in it. Drizzle expands a JavaScript array into a tuple
 * rather than an array literal, so `inArray` is the construct that both binds
 * and means the right thing.
 */

export interface SheetLabel {
  /**
   * The row's own id, so a correction names the name it corrects.
   *
   * A fiche is read across an identity component and a name can hang off either
   * half of a merge, so « the displayed label » is not addressable by entity id
   * and wording alone. Renaming needs one row.
   */
  id: string
  label: string
  kind: string
  /**
   * Null when no chapter gives this name — see migration 0027.
   *
   * The boundary policy withholds such a row, so this is never null on a sheet
   * read through `withBoundary`. It stays in the type because the rename form
   * on the fiche posts a label id straight to `renameEntityLabel`, which reads
   * as the ingestion role and does see them.
   */
  revealedInChapter: number | null
  revealSource: string | null
  precedence: number
}

export interface SheetEvidence {
  excerpt: string | null
  kind: string
  chapterNumber: number | null
  pageIndex: number | null
  panelImageUrl: string | null
}

export interface SheetFact {
  assertionId: string
  predicate: string
  direction: 'outgoing' | 'incoming'
  otherId: string | null
  otherLabel: string | null
  otherType: string | null
  literalValue: string | null
  epistemicStatus: string
  knowledgeFromChapter: number
  /** Set when the reader will later see this belief refuted. */
  knowledgeUntilChapter: number | null
  confidence: number
  proposedBy: string
  locked: boolean
  evidence: SheetEvidence[]
}

export interface EntitySheet {
  id: string
  memberIds: string[]
  nodeType: string
  displayLabel: string
  displayKind: string
  firstSeenChapter: number
  /** Every name revealed so far, strongest first: the history of what to call them. */
  labels: SheetLabel[]
  facts: SheetFact[]
  boundaryChapter: number
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function getEntitySheet(
  userId: string,
  boundaryChapter: number,
  entityId: string,
): Promise<EntitySheet | null> {
  // Defence in depth. The queries below bind their parameters, so this is not
  // load-bearing — but a malformed id should be a null result rather than a
  // database error surfacing as a 500.
  if (!UUID_RE.test(entityId)) return null

  // The component first: a sheet for either half of a merged pair is the same
  // sheet, and asking for the folded-away half must not 404.
  const memberIds = await identityComponent(userId, boundaryChapter, entityId)

  const data = await withBoundary({ userId, boundaryChapter }, async (db) => {
    const entityRows = await db
      .select({
        id: entities.id,
        nodeType: entities.nodeType,
        firstSeenChapter: entities.firstSeenChapter,
      })
      .from(entities)
      .where(inArray(entities.id, memberIds))

    if (entityRows.length === 0) return null

    const labelRows = await db
      .select({
        id: entityLabels.id,
        label: entityLabels.label,
        kind: entityLabels.kind,
        revealedInChapter: entityLabels.revealedInChapter,
        revealSource: entityLabels.revealSource,
        precedence: entityLabels.precedence,
      })
      .from(entityLabels)
      .where(inArray(entityLabels.entityId, memberIds))
      .orderBy(desc(entityLabels.precedence), desc(entityLabels.revealedInChapter))

    /*
     * Facts in both directions.
     *
     * A sheet showing only outgoing relations tells you who this person fought
     * and not who fought them — half a life, and often the more interesting
     * half. `direction` lets the interface phrase each one correctly instead of
     * listing them all as though the subject acted.
     */
    const factRows = await db
      .select({
        assertionId: assertions.id,
        predicate: assertions.predicate,
        subjectId: assertions.subjectEntityId,
        objectId: assertions.objectEntityId,
        objectValue: assertions.objectValue,
        epistemicStatus: assertions.epistemicStatus,
        knowledgeFromChapter: assertions.knowledgeFromChapter,
        knowledgeUntilChapter: assertions.knowledgeUntilChapter,
        confidence: assertions.confidence,
        proposedBy: assertions.proposedBy,
        locked: assertions.locked,
      })
      .from(assertions)
      .where(
        or(
          inArray(assertions.subjectEntityId, memberIds),
          inArray(assertions.objectEntityId, memberIds),
        ),
      )
      .orderBy(asc(assertions.knowledgeFromChapter), asc(assertions.predicate))

    const members = new Set(memberIds)
    const otherIds = [
      ...new Set(
        factRows
          .map((fact) => (members.has(fact.subjectId) ? fact.objectId : fact.subjectId))
          .filter((id): id is string => id !== null && !members.has(id)),
      ),
    ]

    const others =
      otherIds.length === 0
        ? []
        : await db
            .select({
              id: entities.id,
              nodeType: entities.nodeType,
              /*
               * Qualified by hand, and it must stay that way.
               *
               * `${entities.id}` inside a raw fragment renders as a bare
               * `"id"`: Drizzle qualifies the columns in the clauses it builds,
               * not the SQL you write. Inside this subquery `"id"` then
               * resolves to `entity_labels`' own `id` — the inner scope is
               * searched first and that table has such a column — so the
               * correlation silently became `l.entity_id = l.id`, matched
               * nothing, and every related entity read « entité sans nom
               * révélé » while its link led to a page carrying the name. No
               * error either, because both sides are uuid.
               */
              label: sql<string | null>`(
                SELECT l.label FROM entity_labels l
                WHERE l.entity_id = entities.id
                ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                LIMIT 1
              )`,
            })
            .from(entities)
            .where(inArray(entities.id, otherIds))

    const assertionIds = factRows.map((fact) => fact.assertionId)
    const evidenceRows =
      assertionIds.length === 0
        ? []
        : await db
            .select({
              assertionId: evidence.assertionId,
              excerpt: evidence.excerpt,
              kind: evidence.kind,
              /*
               * Either end of the evidence carries the chapter.
               *
               * Read from `panels` alone, a quotation — evidence anchored to a
               * text block and no panel, which is most of what extraction
               * produces — came back with a null chapter, and the fiche printed
               * « · page 1 »: a separator with nothing in front of it, on the
               * one line whose job is to say where this was proved. The number
               * was in the row all along, on the other side of the join.
               */
              chapterNumber: sql<
                number | null
              >`coalesce(${panels.chapterNumber}, ${textBlocks.chapterNumber})`,
              pageIndex: pages.index,
              displayKey: pages.storageKeyDisplay,
            })
            .from(evidence)
            .leftJoin(panels, eq(panels.id, evidence.panelId))
            .leftJoin(textBlocks, eq(textBlocks.id, evidence.textBlockId))
            .leftJoin(
              pages,
              sql`${pages.id} = coalesce(${panels.pageId}, ${textBlocks.pageId})`,
            )
            .where(inArray(evidence.assertionId, assertionIds))

    return { entityRows, labelRows, factRows, others, evidenceRows, members }
  })

  if (!data) return null

  const store = storage()
  const signedByKey = new Map<string, string>()
  for (const row of data.evidenceRows) {
    if (row.displayKey && !signedByKey.has(row.displayKey)) {
      signedByKey.set(row.displayKey, await store.signedUrl(row.displayKey))
    }
  }

  const evidenceByAssertion = new Map<string, SheetEvidence[]>()
  for (const row of data.evidenceRows) {
    const list = evidenceByAssertion.get(row.assertionId) ?? []
    list.push({
      excerpt: row.excerpt,
      kind: row.kind,
      chapterNumber: row.chapterNumber,
      pageIndex: row.pageIndex,
      panelImageUrl: row.displayKey ? (signedByKey.get(row.displayKey) ?? null) : null,
    })
    evidenceByAssertion.set(row.assertionId, list)
  }

  const otherById = new Map(
    data.others.map((row) => [row.id, { label: row.label, type: row.nodeType }]),
  )

  const labels: SheetLabel[] = data.labelRows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    revealedInChapter: row.revealedInChapter,
    revealSource: row.revealSource,
    precedence: row.precedence,
  }))

  return {
    id: memberIds[0]!,
    memberIds,
    nodeType: data.entityRows[0]!.nodeType,
    displayLabel: labels[0]?.label ?? 'entité sans nom révélé',
    displayKind: labels[0]?.kind ?? 'placeholder',
    firstSeenChapter: Math.min(...data.entityRows.map((row) => row.firstSeenChapter)),
    labels,
    facts: data.factRows.map((row): SheetFact => {
      const outgoing = data.members.has(row.subjectId)
      const otherId = outgoing ? row.objectId : row.subjectId
      const other = otherId ? otherById.get(otherId) : undefined
      return {
        assertionId: row.assertionId,
        predicate: row.predicate,
        direction: outgoing ? 'outgoing' : 'incoming',
        otherId,
        otherLabel: other?.label ?? null,
        otherType: other?.type ?? null,
        literalValue: literalOf(row.objectValue),
        epistemicStatus: row.epistemicStatus,
        knowledgeFromChapter: row.knowledgeFromChapter,
        knowledgeUntilChapter: row.knowledgeUntilChapter,
        confidence: row.confidence,
        proposedBy: row.proposedBy,
        locked: row.locked,
        evidence: evidenceByAssertion.get(row.assertionId) ?? [],
      }
    }),
    boundaryChapter,
  }
}

/** `object_value` is stored as `{ value: … }`; the sheet wants the string. */
function literalOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value
    return inner === null || inner === undefined ? null : String(inner)
  }
  return String(value)
}
