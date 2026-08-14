import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { storage } from '../storage/index.ts'
import { loadCatalogue, type LoadOptions } from './catalogue.ts'
import { eraAtChapter, type Era } from './era.ts'
import {
  appearsTooLate,
  buildIndex,
  matchEntity,
  type CandidateIndex,
  type Match,
  type MatchInput,
} from './match.ts'
import { lookupFandomImages, lookupFandomPortraits } from './sources/fandom.ts'
import { downloadAndStore } from './store.ts'
import {
  FANDOM_NODE_TYPES,
  KIND_FOR_NODE_TYPE,
  type ImageCandidate,
} from './types.ts'

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
  /**
   * Which entities those are, named.
   *
   * « 31 sans image » is a number the reader can do nothing with: they cannot
   * tell whether it hides thirty walk-on characters — the normal case, and no
   * reason to touch anything — or the one island whose article the wiki files
   * under another spelling, which a rename on the fiche would fix in a minute.
   * Naming them is the difference between a statistic and something actionable.
   *
   * The label is the one the matcher tried first, so a reader comparing it with
   * the wiki is looking at the same spelling this run looked up.
   */
  unmatchedEntities: Array<{ entityId: string; label: string; nodeType: string }>
  /** Of `matched`, how many the wiki fallback found. */
  fromWiki: number
  /**
   * Of `stored`, the pictures the wiki dates to one side of the ellipse.
   *
   * Worth counting separately because it is the only number that says whether
   * a reader below chapter 598 is being shown faces from before it. A run with
   * many characters and no `preTimeskip` at all means the dated portraits were
   * not found, and the reader is back on undated catalogue artwork.
   */
  preTimeskip: number
  postTimeskip: number
  /**
   * Pictures thrown away because the rapprochement that found them is refused.
   *
   * Zero unless the run was asked to re-check. It counts rows, not entities:
   * an entity loses everything it had when its identification falls, including
   * the wiki portraits that were fetched under the wrong character's name.
   */
  dropped: number
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
  /**
   * Put the stored rapprochements back through today's rules, first.
   *
   * A matching rule written after a library was illustrated changes nothing on
   * its own: the pass skips whatever already has a face, so the face that rule
   * would now refuse stays exactly where it is. This is the run that goes and
   * looks — and because a picture it takes away leaves an entity with none, the
   * ordinary pass below picks that entity up in the same run and illustrates it
   * again under the current rules.
   *
   * Off by default, and never on in the automatic per-chapter pass. Deleting a
   * reader's illustrations is a thing to be asked for, not a thing that happens
   * quietly while a chapter is published.
   */
  recheck?: boolean
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
  /**
   * Ask the wiki about whatever the catalogues could not place.
   *
   * On by default, and off whenever `offline` is set — a run told not to
   * touch the network must not make one request per unmatched entity. Setting
   * this to false switches it off on its own.
   */
  fandom?: boolean
  /** Override the wiki lookup. Same reason as `download`. */
  lookup?: (name: string) => Promise<ImageCandidate[]>
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
    unmatchedEntities: [],
    fromWiki: 0,
    preTimeskip: 0,
    postTimeskip: 0,
    dropped: 0,
    failures: [],
    catalogueFailures: catalogue.failures,
    catalogueSize: index.size,
    ...(catalogue.cacheNote ? { cacheNote: catalogue.cacheNote } : {}),
  }

  /*
   * An empty catalogue used to end the run here.
   *
   * That was right when the catalogues were the only source: nothing to match
   * against, nothing to do. It is wrong now — the wiki fallback needs no
   * catalogue at all, and the case where all three community APIs are down is
   * exactly the case where a fallback earns its keep.
   */
  if (index.size === 0 && !wikiEnabled(options)) return report

  /*
   * Before looking for what is missing, look again at what is there.
   *
   * The order is the point: dropping a refused picture leaves its entity
   * without one, and `pending()` below selects precisely the entities without
   * one. So a re-check and a re-illustration are the same run, and the reader
   * presses one button rather than two.
   */
  if (options.recheck) {
    report.dropped = await dropRefusedImages(userId, catalogue.candidates, index)
  }

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

    const matches = await portraitsFor(input, index, options)
    if (matches.length === 0) {
      report.unmatched += 1
      report.unmatchedEntities.push({
        entityId: row.entity_id,
        // Never empty: `pending()` selects only entities that have a label.
        label: input.labels[0]!.label,
        nodeType: row.node_type,
      })
      continue
    }
    report.matched += 1
    if (matches[0]!.candidate.source === 'fandom') report.fromWiki += 1

    /*
     * Every picture found, not merely the best one.
     *
     * An entity can now come back with the same subject on both sides of the
     * ellipse, and choosing between them here would be choosing for a reader
     * whose position this code does not know — enrichment runs for the whole
     * library at once, the reader moves afterwards. So all of them are stored
     * and `imagesFor` picks, per read, per position.
     */
    for (const match of matches) {
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
              matched_label, match_method, match_score, revealed_in_chapter, era,
              kind, is_primary
            )
            VALUES (
              ${userId}, ${row.entity_id}, ${match.candidate.source},
              ${match.candidate.sourceRef}, ${match.candidate.pageUrl},
              ${match.candidate.attribution},
              ${stored.storageKey}, ${stored.thumbKey}, ${stored.width}, ${stored.height},
              ${stored.mime}, ${stored.bytes},
              ${match.matchedLabel}, ${match.method}, ${match.score},
              ${match.revealedInChapter}, ${match.candidate.era},
              'portrait',
              NOT EXISTS (
                SELECT 1 FROM entity_images
                WHERE entity_id = ${row.entity_id} AND is_primary
              )
            )
            ON CONFLICT (entity_id, source, source_ref) DO NOTHING
          `)
        })

        report.stored += 1
        if (match.candidate.era === 'pre_timeskip') report.preTimeskip += 1
        if (match.candidate.era === 'post_timeskip') report.postTimeskip += 1
      } catch (error: unknown) {
        report.failures.push({
          entityId: row.entity_id,
          label: match.matchedLabel,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return report
}

/**
 * Everything worth storing for one entity.
 *
 * The catalogues answer first, as they always have — they are indexed, offline
 * and free, and one of them carries a chapter of first appearance nothing else
 * does. What is new is that a *character* they placed is then taken to the
 * wiki anyway, not to be re-identified but to be dated: the catalogue portrait
 * says nothing about which side of the ellipse it shows, and for the Straw Hats
 * that silence is the difference between a reader at chapter 8 seeing Nami as
 * the chapter draws her and seeing her as she comes back two years later.
 *
 * When the catalogues place nothing, the wiki is the fallback it already was.
 */
async function portraitsFor(
  entity: MatchInput,
  index: CandidateIndex,
  options: EnrichOptions,
): Promise<Match[]> {
  const matched = matchEntity(entity, index)
  if (!matched) return fromWiki(entity, options)
  return [matched, ...(await datedPortraits(matched, entity, options))]
}

/**
 * Take back the faces that were attached on a resemblance the rules now refuse.
 *
 * Only rows matched by `trigram` are re-examined, because that is the only step
 * that matches on spelling alone and the only one the chapter check applies to.
 * A picture found by an exact name, by the same words in another order, or by
 * containment was found on a relation between names, and second-guessing those
 * here would make this stricter than the matcher itself — which would be a
 * second rule nobody wrote down.
 *
 * A row whose candidate is no longer in the catalogue is left alone. Not being
 * able to look something up is not evidence against it, and a run made while
 * one of the sources is down must not read the outage as a verdict.
 *
 * When one picture falls, the entity's others go with it. They are not
 * independent findings: a wiki portrait is fetched under the *catalogue's* name
 * for the character — see `datedPortraits` — so it inherits the identification
 * that has just been refused, and keeping it would leave the same wrong face
 * with better provenance than before.
 */
async function dropRefusedImages(
  userId: string,
  candidates: ImageCandidate[],
  index: CandidateIndex,
): Promise<number> {
  const bySource = new Map(
    candidates.map((candidate) => [
      `${candidate.source} ${candidate.sourceRef}`,
      candidate,
    ]),
  )

  const stored = await withIngest((db) =>
    db.execute<{
      entity_id: string
      source: string
      source_ref: string
      revealed_in_chapter: number
    }>(sql`
      SELECT entity_id, source, source_ref, revealed_in_chapter
      FROM entity_images
      WHERE user_id = ${userId} AND match_method = 'trigram' AND kind = 'portrait'
    `),
  )

  const refused = new Set<string>()
  for (const row of stored) {
    const candidate = bySource.get(`${row.source} ${row.source_ref}`)
    if (!candidate) continue
    if (appearsTooLate(index, candidate, Number(row.revealed_in_chapter))) {
      refused.add(row.entity_id)
    }
  }

  if (refused.size === 0) return 0

  const removed = await withIngest((db) =>
    db.execute<{ storage_key: string; thumb_key: string | null }>(sql`
      DELETE FROM entity_images
      WHERE user_id = ${userId} AND entity_id IN ${[...refused]}
        AND kind = 'portrait'
      RETURNING storage_key, thumb_key
    `),
  )

  /*
   * The bytes, after the rows.
   *
   * This order is the recoverable one. A file left behind by a failed delete is
   * an orphan in a bucket nobody reads from; a row left pointing at a file that
   * is gone is a portrait that renders as a broken picture on the fiche. The
   * failure is swallowed for the same reason: the reader asked for a wrong face
   * to go away, and it has.
   */
  try {
    await storage().remove(
      removed
        .flatMap((row) => [row.storage_key, row.thumb_key])
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    )
  } catch {
    /* An unreachable bucket is a stale file, not a failed correction. */
  }

  return removed.length
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
/**
 * The wiki, asked about what the catalogues could not place.
 *
 * Tried on the entity's own labels, best first, and stopped at the first hit —
 * one entity is worth at most a couple of requests to somebody else's free
 * wiki. The label that found the article is the one recorded, which is what
 * decides the chapter the picture may appear at: a face found by a true name
 * stays hidden until the reader is given that name.
 */
async function fromWiki(
  entity: MatchInput,
  options: EnrichOptions,
): Promise<Match[]> {
  if (!wikiEnabled(options)) return []
  if (!FANDOM_NODE_TYPES.includes(entity.nodeType)) return []

  const lookup = options.lookup ?? lookupFandomImages

  for (const label of entity.labels.slice(0, WIKI_LABELS_PER_ENTITY)) {
    const candidates = await lookup(label.label)
    if (candidates.length === 0) continue
    return candidates.map((candidate) => ({
      candidate,
      // An article exists under exactly this name. That is a stronger signal
      // than anything the trigram matcher produces, and it is still a guess:
      // the caption names the page and links to it so a reader can tell.
      method: 'exact' as const,
      score: 1,
      matchedLabel: label.label,
      revealedInChapter: label.revealedInChapter,
    }))
  }

  return []
}

/** Labels tried per entity before giving up. Requests are somebody else's. */
const WIKI_LABELS_PER_ENTITY = 2

/**
 * The wiki asked to date a character the catalogues already identified.
 *
 * Asked with the *catalogue's* names rather than the entity's label, because
 * the catalogue holds the English name the wiki files its articles under and
 * the graph holds a French one. « Barbe Blanche » finds nothing on the English
 * wiki; the onepieceapi row it matched is called « Edward Newgate », which
 * finds everything.
 *
 * Only the dated pictures are kept, and the default lookup knows it: an undated
 * answer is no answer for a subject that already has a portrait, so it asks the
 * English wiki once and stops. The lead image would be a second undated
 * portrait bought at the price of a download, and no reader would ever be shown
 * it in preference to the catalogue's.
 *
 * The provenance is the catalogue match's, unchanged: the chain that reached
 * this picture is « this label matched that row, which is called that in
 * English », and it is no stronger than its first link. In particular
 * `revealedInChapter` stays the one the boundary needs — the chapter that
 * reveals the label — so a dated portrait is no more visible, and no earlier,
 * than the undated one it sits beside.
 */
async function datedPortraits(
  match: Match,
  entity: MatchInput,
  options: EnrichOptions,
): Promise<Match[]> {
  if (!wikiEnabled(options)) return []
  // Only a person changes across the ellipse. A Devil Fruit, a ship and an
  // island do not, and asking about them would spend a request per entity on a
  // question whose answer is known.
  if (entity.nodeType !== 'character') return []

  const lookup = options.lookup ?? lookupFandomPortraits

  for (const name of askableNames(match.candidate)) {
    const dated = (await lookup(name)).filter(
      (candidate) => candidate.era !== 'unknown',
    )
    if (dated.length === 0) continue
    return dated.map((candidate) => ({ ...match, candidate }))
  }

  return []
}

/**
 * The names of a catalogue row worth spelling into a wiki URL.
 *
 * Latin script only — the rows carry « モンキー・D・ルフィ » beside « Monkey D.
 * Luffy », and the English wiki has no article under the Japanese one. Two at
 * most, for the same reason the label loop above stops at two.
 */
function askableNames(candidate: ImageCandidate): string[] {
  const latin = candidate.names
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .filter((name) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(name))
  return [...new Set(latin)].slice(0, WIKI_LABELS_PER_ENTITY)
}

/**
 * `offline` means offline.
 *
 * It was written for the catalogue, whose network access was the only one there
 * was, and the wiki fallback would have quietly walked around it — a run asked
 * not to touch the network would have made one request per unmatched entity.
 * Honouring it here also keeps the whole test suite hermetic by default: every
 * existing enrichment test passes `offline: true`, and none of them had to
 * learn about a lookup that did not exist when they were written.
 */
function wikiEnabled(options: EnrichOptions): boolean {
  return options.fandom !== false && options.offline !== true
}

async function pending(userId: string, options: EnrichOptions): Promise<Row[]> {
  /*
   * Every type either catalogue path can illustrate.
   *
   * This used to be the four typed kinds alone, which meant a group, a species
   * or a concept was never even queued — the run reported them as nothing at
   * all rather than as unmatched, and « pourquoi le Partys Bar n'a pas d'image »
   * had no answer anywhere in the report.
   */
  const types = [
    ...new Set([
      ...Object.keys(KIND_FOR_NODE_TYPE),
      ...(wikiEnabled(options) ? FANDOM_NODE_TYPES : []),
    ]),
  ]
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
      /*
       * A name no chapter gives finds no picture.
       *
       * The revelation chapter of the matching label is what decides when a
       * portrait may be shown -- see drizzle/0012 -- and a name from a SBS
       * column or a databook has no such chapter. Matching on one would produce
       * a picture with nothing to date it: the wiki knows the mayor of Fuchsia
       * by a name the reader has not read, and the face would arrive under it
       * at chapter 1. So the join is on the names the chronology carries, and
       * an entity whose only name is one of the others counts as having none --
       * which, as far as the reader is concerned, it does.
       */
      LEFT JOIN entity_labels l
             ON l.entity_id = e.id
            AND l.revealed_in_chapter IS NOT NULL
      WHERE e.user_id = ${userId}
        AND e.review_status = 'accepted'
        AND e.node_type IN ${types}
        ${
          options.includeIllustrated
            ? sql``
            : sql`AND NOT EXISTS (
                SELECT 1 FROM entity_images i
                WHERE i.entity_id = e.id AND i.kind = 'portrait'
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
  era: Era
}

/**
 * The pictures visible at this boundary, for the given entities.
 *
 * Read through `withBoundary` like everything else the reader sees, so the
 * revelation rule is the database's and not this function's — a caller that
 * forgets to filter gets an empty list, never an early portrait.
 *
 * Two rules, and only one of them is here. *Whether* a picture may be seen is
 * the policy's: revealed late enough, and not a face from after the ellipse
 * shown to a reader who has not reached it. *Which* of the survivors to show is
 * this query's, and it is a preference rather than a rule — the reader's own
 * period first, then an undated picture, then the other period. The last of
 * those three is only reachable after chapter 598, where a portrait from before
 * the ellipse is merely out of date rather than a spoiler.
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
      era: Era
    }>(sql`
      SELECT DISTINCT ON (entity_id)
        entity_id, storage_key, thumb_key, attribution, source_url,
        matched_label, match_method, match_score, revealed_in_chapter, width, height,
        era
      FROM entity_images
      WHERE entity_id IN ${entityIds} AND kind = 'portrait'
      ORDER BY entity_id,
        CASE era WHEN ${eraAtChapter(boundaryChapter)} THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,
        is_primary DESC, match_score DESC, created_at
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
        era: row.era,
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
        SELECT 1 AS entity_id FROM entity_images
        WHERE entity_id = e.id AND kind = 'portrait' LIMIT 1
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
