import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { loadCatalogue, type LoadOptions } from './catalogue.ts'
import { buildIndex, matchEntity, type MatchInput } from './match.ts'
import { downloadAndStore } from './store.ts'
import { KIND_FOR_NODE_TYPE } from './types.ts'

/**
 * Give the extracted entities a face.
 *
 * Runs as the ingestion role, because "which of my entities still has no
 * picture" is a question about the whole library rather than about where the
 * reader currently is. The boundary applies when the pictures are *read*, and
 * the column it applies to is decided here: the revelation chapter of the label
 * that found the match. See drizzle/0012_entity_images.sql.
 *
 * Nothing in this file writes an assertion, and nothing it produces can be
 * cited as evidence. An illustration is a convenience; the knowledge stays
 * exactly as sourced as it was.
 */

export interface EnrichReport {
  considered: number
  matched: number
  stored: number
  /** Entities with no plausible candidate. Expected, not a failure. */
  unmatched: number
  failures: Array<{ entityId: string; label: string; reason: string }>
  /** Sources that could not be reached while building the catalogue. */
  catalogueFailures: Array<{ source: string; reason: string }>
  catalogueSize: number
  /** Set when the catalogue could not be cached — see cataloguePath(). */
  cacheNote?: string
}

export interface EnrichOptions extends LoadOptions {
  /** Cap the run, so a first attempt can be small and observed. */
  limit?: number
  /** Re-examine entities that already have a picture. */
  includeIllustrated?: boolean
  onProgress?: (done: number, total: number) => void
  /**
   * Override the fetch-and-store step.
   *
   * Exists for the tests, which must not reach three community APIs to check
   * that a picture appears at the right chapter — that would make the suite
   * depend on somebody else's uptime and would leave the boundary assertions
   * "flaky" rather than blocking. The real implementation is the default.
   */
  download?: typeof downloadAndStore
}

interface Row extends Record<string, unknown> {
  entity_id: string
  node_type: string
  labels: Array<{ label: string; revealed_in_chapter: number; precedence: number }>
}

export async function enrichEntityImages(
  userId: string,
  options: EnrichOptions = {},
): Promise<EnrichReport> {
  const catalogue = await loadCatalogue(options)
  const index = buildIndex(catalogue.candidates)

  const report: EnrichReport = {
    considered: 0,
    matched: 0,
    stored: 0,
    unmatched: 0,
    failures: [],
    catalogueFailures: catalogue.failures,
    catalogueSize: index.size,
    ...(catalogue.cacheNote ? { cacheNote: catalogue.cacheNote } : {}),
  }

  if (index.size === 0) return report

  const work = await pending(userId, options)
  report.considered = work.length

  let done = 0
  for (const row of work) {
    done += 1
    options.onProgress?.(done, work.length)

    const input: MatchInput = {
      entityId: row.entity_id,
      nodeType: row.node_type,
      labels: row.labels.map((label) => ({
        label: label.label,
        revealedInChapter: label.revealed_in_chapter,
        precedence: label.precedence,
      })),
    }

    const match = matchEntity(input, index)
    if (!match) {
      report.unmatched += 1
      continue
    }
    report.matched += 1

    try {
      const fetchAndStore = options.download ?? downloadAndStore
      const stored = await fetchAndStore(userId, row.entity_id, match.candidate)

      await withIngest(async (db) => {
        /*
         * `is_primary` is decided by what is already there, not by this run.
         *
         * A partial unique index allows exactly one primary per entity, so
         * inserting a second one blindly would fail the whole statement. The
         * first picture found wins and later ones are alternates — which also
         * means a re-run never silently swaps the portrait the reader has got
         * used to.
         */
        await db.execute(sql`
          INSERT INTO entity_images (
            user_id, entity_id, source, source_ref, source_url, attribution,
            storage_key, thumb_key, width, height, mime, bytes,
            matched_label, match_method, match_score, revealed_in_chapter, is_primary
          )
          VALUES (
            ${userId}, ${row.entity_id}, ${match.candidate.source},
            ${match.candidate.sourceRef}, ${match.candidate.pageUrl},
            ${match.candidate.attribution},
            ${stored.storageKey}, ${stored.thumbKey}, ${stored.width}, ${stored.height},
            ${stored.mime}, ${stored.bytes},
            ${match.matchedLabel}, ${match.method}, ${match.score},
            ${match.revealedInChapter},
            NOT EXISTS (
              SELECT 1 FROM entity_images
              WHERE entity_id = ${row.entity_id} AND is_primary
            )
          )
          ON CONFLICT (entity_id, source, source_ref) DO NOTHING
        `)
      })

      report.stored += 1
    } catch (error: unknown) {
      report.failures.push({
        entityId: row.entity_id,
        label: match.matchedLabel,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return report
}

/**
 * How many entities one automatic pass will try to illustrate.
 *
 * A chapter contributes a handful of new characters, and the pass runs on every
 * chapter, so a small number keeps up with the library while leaving the
 * invocation time to finish. It also bounds what an automatic download does to
 * three free services on somebody else's servers.
 */
const AUTOMATIC_LIMIT = 15

/**
 * Give a face to what the chapter just opened, without being asked.
 *
 * The settings page has a button for this, and a button is the wrong place for
 * it: nobody publishes a chapter thinking « now let me go and fetch the
 * portraits ». Illustration is not knowledge — nothing here writes an assertion
 * and no picture can be cited — so it does not need a decision, only a moment,
 * and the moment a chapter becomes readable is the obvious one.
 *
 * Swallows everything. This runs after the response, beside work that already
 * succeeded; three community APIs being down must not turn a published chapter
 * into an error message. What it does return is what it did, for the caller
 * that cares to log it.
 */
export async function illustrateQuietly(
  userId: string,
  limit: number = AUTOMATIC_LIMIT,
): Promise<EnrichReport | null> {
  try {
    return await enrichEntityImages(userId, { limit })
  } catch {
    return null
  }
}

/**
 * Entities worth trying, with every label they have ever carried.
 *
 * Restricted to node types some catalogue can actually illustrate. Asking three
 * character APIs about a concept or a battle would spend the run's budget on
 * questions with no possible answer, and would report them as "unmatched" as
 * though something had gone wrong.
 */
async function pending(userId: string, options: EnrichOptions): Promise<Row[]> {
  const types = Object.keys(KIND_FOR_NODE_TYPE)
  const limit = options.limit ?? 5_000

  return withIngest(async (db) => {
    const rows = await db.execute<Row>(sql`
      SELECT
        e.id AS entity_id,
        e.node_type,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'label', l.label,
              'revealed_in_chapter', l.revealed_in_chapter,
              'precedence', l.precedence
            )
            ORDER BY l.precedence DESC, l.revealed_in_chapter
          ) FILTER (WHERE l.id IS NOT NULL),
          '[]'::jsonb
        ) AS labels
      FROM entities e
      LEFT JOIN entity_labels l ON l.entity_id = e.id
      WHERE e.user_id = ${userId}
        AND e.review_status = 'accepted'
        AND e.node_type IN ${types}
        ${
          options.includeIllustrated
            ? sql``
            : sql`AND NOT EXISTS (
                SELECT 1 FROM entity_images i WHERE i.entity_id = e.id
              )`
        }
      GROUP BY e.id, e.node_type
      HAVING count(l.id) > 0
      ORDER BY e.first_seen_chapter
      LIMIT ${limit}
    `)

    return rows.map((row) => ({ ...row, labels: row.labels ?? [] }))
  })
}

export interface EntityImage {
  entityId: string
  storageKey: string
  thumbKey: string | null
  attribution: string
  sourceUrl: string
  matchedLabel: string
  matchMethod: string
  matchScore: number
  revealedInChapter: number
  width: number | null
  height: number | null
}

/**
 * The pictures visible at this boundary, for the given entities.
 *
 * Read through `withBoundary` like everything else the reader sees, so the
 * revelation rule is the database's and not this function's — a caller that
 * forgets to filter gets an empty list, never an early portrait.
 */
export async function imagesFor(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<Map<string, EntityImage>> {
  if (entityIds.length === 0) return new Map()

  const rows = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<{
      entity_id: string
      storage_key: string
      thumb_key: string | null
      attribution: string
      source_url: string
      matched_label: string
      match_method: string
      match_score: number
      revealed_in_chapter: number
      width: number | null
      height: number | null
    }>(sql`
      SELECT DISTINCT ON (entity_id)
        entity_id, storage_key, thumb_key, attribution, source_url,
        matched_label, match_method, match_score, revealed_in_chapter, width, height
      FROM entity_images
      WHERE entity_id IN ${entityIds}
      ORDER BY entity_id, is_primary DESC, match_score DESC, created_at
    `),
  )

  return new Map(
    rows.map((row) => [
      row.entity_id,
      {
        entityId: row.entity_id,
        storageKey: row.storage_key,
        thumbKey: row.thumb_key,
        attribution: row.attribution,
        sourceUrl: row.source_url,
        matchedLabel: row.matched_label,
        matchMethod: row.match_method,
        matchScore: Number(row.match_score),
        revealedInChapter: row.revealed_in_chapter,
        width: row.width,
        height: row.height,
      },
    ]),
  )
}

export interface Coverage {
  nodeType: string
  total: number
  illustrated: number
}

/** How much of the library has a face, by node type. For the settings page. */
export async function imageCoverage(userId: string): Promise<Coverage[]> {
  const types = Object.keys(KIND_FOR_NODE_TYPE)

  return withIngest(async (db) => {
    const rows = await db.execute<{
      node_type: string
      total: number
      illustrated: number
    }>(sql`
      SELECT
        e.node_type,
        count(*)::int AS total,
        count(i.entity_id)::int AS illustrated
      FROM entities e
      LEFT JOIN LATERAL (
        SELECT 1 AS entity_id FROM entity_images WHERE entity_id = e.id LIMIT 1
      ) i ON true
      WHERE e.user_id = ${userId}
        AND e.review_status = 'accepted'
        AND e.node_type IN ${types}
      GROUP BY e.node_type
      ORDER BY count(*) DESC
    `)

    return rows.map((row) => ({
      nodeType: row.node_type,
      total: Number(row.total),
      illustrated: Number(row.illustrated),
    }))
  })
}
