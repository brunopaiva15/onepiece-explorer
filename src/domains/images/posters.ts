import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { storage } from '../storage/index.ts'
import { downloadAndStore } from './store.ts'
import {
  BOUNTY_HISTORY,
  bountyAtChapter,
  bountyCharacter,
  formatBerries,
  type Bounty,
  type BountyHistory,
} from './bounties.ts'
import {
  ATTRIBUTION,
  fetchGallery,
  findPoster,
  resolveFiles,
  type GalleryEntry,
} from './sources/bounty-posters.ts'
import type { ImageCandidate } from './types.ts'

/**
 * Les avis de recherche, apportés et datés.
 *
 * Two halves that must not be confused, and the file is arranged around the
 * distinction:
 *
 *   **Bringing them in** is a job the owner runs. It reads the wiki gallery,
 *   pairs each printing in the manifest with a file, downloads the bytes, and
 *   writes one row per printing with the chapter that shows it.
 *
 *   **Reading them** is what a page does, through the boundary, and it is one
 *   query: the most recent poster of this entity that the reader has reached.
 *   Everything printed later is filtered by the same row-level policy that
 *   filters every other picture, which is why this file adds no rule of its own
 *   for the reader's position. There is exactly one place where a chapter
 *   number is decided — the manifest — and it is not here.
 */

export interface PosterView {
  entityId: string
  /** Signed and short-lived, like every other stored picture. */
  url: string
  thumbUrl: string
  /** The figure printed on it. From the manifest, not from the picture. */
  amount: number
  /** « 300 000 000 ฿ », ready to set. */
  berries: string
  /** The chapter that shows this printing. */
  chapter: number
  attribution: string
  sourceUrl: string
}

interface PosterRow extends Record<string, unknown> {
  entity_id: string
  storage_key: string
  thumb_key: string | null
  attribution: string
  source_url: string
  revealed_in_chapter: number
  matched_label: string
}

/**
 * The poster each of these entities is wanted on, at this chapter.
 *
 * `DISTINCT ON … ORDER BY revealed_in_chapter DESC` is the whole of the
 * spoiler-safety at read time, and it is safe because the rows the query can
 * see have already been cut at the reader's position by the policy: the most
 * recent visible printing is, by construction, the last one they have read.
 *
 * The amount is not read from the database. It is looked up in the manifest
 * from the same chapter, so the number under the picture and the picture itself
 * cannot drift apart — there is one source for both, and it is a file somebody
 * maintains rather than a column somebody backfilled.
 */
export async function postersFor(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
  labels: Map<string, string>,
): Promise<Map<string, PosterView>> {
  const out = new Map<string, PosterView>()
  if (entityIds.length === 0) return out

  const rows = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<PosterRow>(sql`
      SELECT DISTINCT ON (entity_id)
        entity_id, storage_key, thumb_key, attribution, source_url,
        revealed_in_chapter, matched_label
      FROM entity_images
      WHERE entity_id IN ${entityIds} AND kind = 'poster'
      ORDER BY entity_id, revealed_in_chapter DESC, created_at DESC
    `),
  )

  if (rows.length === 0) return out

  /*
   * One round trip for the whole wall, not one per poster.
   *
   * `signedUrls` arrived with the portraits and applies here for the same
   * reason: six posters and their thumbnails is twelve signatures, and twelve
   * sequential round trips to the storage provider is most of the time the home
   * page spends. A key that will not sign is simply absent from the map, and
   * its poster falls back to a portrait.
   */
  let signed: Map<string, string>
  try {
    signed = await storage().signedUrls(
      rows.flatMap((row) => (row.thumb_key ? [row.storage_key, row.thumb_key] : [row.storage_key])),
    )
  } catch {
    return out
  }

  for (const row of rows) {
    /*
     * The figure printed on *this* picture, not the one the reader's chapter
     * would give.
     *
     * The difference is the whole of it, and getting it wrong put « 1 000 ฿ »
     * under a poster that says fifty. The wiki's gallery holds a picture of a
     * fraction of the printings the manifest knows, so the most recent poster a
     * reader can see is often older than their most recent bounty: Chopper at
     * chapter 1100 is wanted for a thousand berries and the newest picture of
     * him anybody has is the hundred. Reading the row's own chapter shows the
     * number that is on the paper. Stale, and true.
     */
    const character =
      bountyCharacter(labels.get(row.entity_id) ?? '') ?? bountyCharacter(row.matched_label)
    const bounty = character
      ? (character.rows.find((entry) => entry.chapter === row.revealed_in_chapter) ??
        bountyAtChapter(character, row.revealed_in_chapter))
      : null
    if (!bounty) continue

    const url = signed.get(row.storage_key)
    if (!url) continue

    out.set(row.entity_id, {
      entityId: row.entity_id,
      url,
      /* A thumbnail that did not sign falls back to the full poster, which the
         wall shows whole anyway. */
      thumbUrl: (row.thumb_key ? signed.get(row.thumb_key) : null) ?? url,
      amount: bounty.amount,
      berries: formatBerries(bounty.amount),
      chapter: row.revealed_in_chapter,
      attribution: row.attribution,
      sourceUrl: row.source_url,
    })
  }

  return out
}

/**
 * Cap on the wanted list. Generous: the manifest knows nineteen characters, and
 * a library that has merged nothing may hold several entities per name.
 */
const WANTED = 60

/**
 * Everyone the reader has seen a wanted poster of.
 *
 * The home page used to build its wall out of the sixty most connected
 * characters and then ask which of them had a poster, which is backwards, and
 * the bug it produced is worth keeping written down: Higuma is a mountain
 * bandit who appears in chapter 1, holds three relations, and carries the
 * earliest bounty in the story. He never entered a pool ranked by degree, so
 * the wall of a reader at chapter 100 showed Buggy, Krieg and Arlong and swore
 * that was all there was.
 *
 * Asking the pictures first inverts it. What comes back is small by nature —
 * posters exist for a handful of people and the boundary cuts even those — so
 * there is no ranking here and none is wanted: every row is somebody the reader
 * has genuinely seen a poster of, and choosing between them is the page's job.
 */
export async function wantedEntityIds(
  userId: string,
  boundaryChapter: number,
  limit = WANTED,
): Promise<string[]> {
  const rows = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<{ entity_id: string }>(sql`
      SELECT DISTINCT entity_id
      FROM entity_images
      WHERE kind = 'poster'
      ORDER BY entity_id
      LIMIT ${limit}
    `),
  )
  return rows.map((row) => row.entity_id)
}

export interface PosterReport {
  /**
   * Characters of the manifest found in the library.
   *
   * People, not rows. A library that has not merged « Sanji » and « Vinsmoke
   * Sanji » holds several entities for one cook, and counting those said
   * « seize personnages » about eleven. The entity count is what the download
   * loop runs over and it is not what this panel is reporting.
   */
  considered: number
  /** Printings the gallery could be pinned to a file for. */
  resolved: number
  stored: number
  /** Printings no file could be found for, named so the manifest can grow. */
  unresolved: string[]
  failures: Array<{ what: string; reason: string }>
}

export interface PosterOptions {
  /** Swapped in tests, so nothing downloads a megabyte from Fandom. */
  gallery?: GalleryEntry[]
  download?: typeof downloadAndStore
  resolve?: typeof resolveFiles
  onProgress?: (done: number, total: number) => void
}

interface Target {
  entityId: string
  label: string
  character: BountyHistory
}

/**
 * Find every character in the library the manifest knows, and give them their
 * posters.
 *
 * Runs over the whole library at once and stores every printing, rather than
 * the one visible now: enrichment has no reader and no position, and choosing
 * a printing here would be choosing for somebody whose chapter this code does
 * not know. The reader's own position is applied at read time, per request, by
 * the boundary.
 */
export async function enrichBountyPosters(
  userId: string,
  options: PosterOptions = {},
): Promise<PosterReport> {
  const report: PosterReport = {
    considered: 0,
    resolved: 0,
    stored: 0,
    unresolved: [],
    failures: [],
  }

  let gallery: GalleryEntry[]
  try {
    gallery = options.gallery ?? (await fetchGallery())
  } catch (error) {
    report.failures.push({
      what: 'galerie',
      reason: error instanceof Error ? error.message : String(error),
    })
    return report
  }

  const targets = await findTargets(userId)
  report.considered = new Set(targets.map((target) => target.character.canonical)).size
  if (targets.length === 0) return report

  /*
   * One pass to decide what is wanted, one request to resolve the files, then
   * the downloads. Resolving in a batch rather than per poster is the
   * difference between fourteen requests to the wiki and two.
   *
   * Counted per printing, run per entity, and the two are not the same number.
   * Whether the gallery has a picture of Sanji's first poster is a fact about
   * the gallery: it is one line in the report however many entities in this
   * library happen to be called Sanji. The loop still visits all of them,
   * because each one needs its own row to have a poster on its own page — but
   * the report is about the manifest, and a list that named the same missing
   * printing six times was unreadable for it.
   */
  const wanted: Array<{ target: Target; bounty: Bounty; title: string; pageUrl: string }> = []
  const judged = new Set<string>()
  const missing: string[] = []
  for (const target of targets) {
    for (const bounty of target.character.rows) {
      const printing = `${target.character.canonical} · ${formatBerries(bounty.amount)} (ch. ${bounty.chapter})`
      const first = !judged.has(printing)
      judged.add(printing)

      const match = findPoster(gallery, target.character, bounty)
      if (!match) {
        if (first) missing.push(printing)
        continue
      }
      if (first) report.resolved += 1
      wanted.push({
        target,
        bounty,
        title: match.entry.title,
        pageUrl: `https://onepiece.fandom.com/wiki/${encodeURIComponent(match.entry.title)}`,
      })
    }
  }
  report.unresolved = missing

  if (wanted.length === 0) return report

  let files: Awaited<ReturnType<typeof resolveFiles>>
  try {
    const resolve = options.resolve ?? resolveFiles
    files = await resolve(wanted.map((item) => item.title))
  } catch (error) {
    report.failures.push({
      what: 'résolution des fichiers',
      reason: error instanceof Error ? error.message : String(error),
    })
    return report
  }

  let done = 0
  for (const item of wanted) {
    done += 1
    options.onProgress?.(done, wanted.length)

    const file = files.get(item.title)
    if (!file) {
      report.failures.push({ what: item.title, reason: 'fichier introuvable sur le wiki' })
      continue
    }

    /*
     * A poster wears the ImageCandidate shape so it goes through the same
     * download, the same re-encoding and the same private bucket as every other
     * picture. Nothing is hotlinked from a fan wiki, here as anywhere else.
     */
    const candidate: ImageCandidate = {
      source: 'fandom',
      era: 'unknown',
      sourceRef: `bounty:${item.title}`,
      kind: 'character',
      names: [item.target.character.canonical],
      imageUrl: file.imageUrl,
      pageUrl: item.pageUrl,
      attribution: ATTRIBUTION,
      firstAppearanceChapter: null,
    }

    try {
      const fetchAndStore = options.download ?? downloadAndStore
      const stored = await fetchAndStore(userId, item.target.entityId, candidate)

      await withIngest(async (db) => {
        await db.execute(sql`
          INSERT INTO entity_images (
            user_id, entity_id, source, source_ref, source_url, attribution,
            storage_key, thumb_key, width, height, mime, bytes,
            matched_label, match_method, match_score, revealed_in_chapter, era,
            kind, is_primary
          )
          VALUES (
            ${userId}, ${item.target.entityId}, ${candidate.source},
            ${candidate.sourceRef}, ${candidate.pageUrl}, ${candidate.attribution},
            ${stored.storageKey}, ${stored.thumbKey}, ${stored.width}, ${stored.height},
            ${stored.mime}, ${stored.bytes},
            ${item.target.character.canonical}, 'bounty-manifest', 1,
            ${item.bounty.chapter}, 'unknown', 'poster', false
          )
          ON CONFLICT (entity_id, source, source_ref) DO NOTHING
        `)
      })

      report.stored += 1
    } catch (error) {
      report.failures.push({
        what: `${item.target.character.canonical} · ${item.title}`,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return report
}

/**
 * The entities the manifest has a bounty for.
 *
 * Read outside the boundary on purpose, and it is worth being explicit about
 * why that is not a leak: this runs for the owner, over their own library, to
 * decide which files to fetch. Nothing it learns reaches a page. What a reader
 * sees is decided later, by `postersFor`, at their position.
 *
 * Every label of an entity is considered, not just the best one, because the
 * name the manifest knows may be one the reader has not reached: « Luffy » is
 * the label from chapter 1, and a library that has since learned « Monkey D.
 * Luffy » holds both.
 */
async function findTargets(userId: string): Promise<Target[]> {
  const rows = await withIngest(async (db) =>
    db.execute<{ entity_id: string; label: string }>(sql`
      SELECT DISTINCT l.entity_id, l.label
      FROM entity_labels l
      JOIN entities e ON e.id = l.entity_id
      WHERE l.user_id = ${userId}
        AND e.node_type = 'character'
        AND e.review_status = 'accepted'
    `),
  )

  const byEntity = new Map<string, Target>()
  for (const row of rows) {
    const character = bountyCharacter(row.label)
    if (!character) continue
    const seen = byEntity.get(row.entity_id)
    /*
     * One target per entity, and the longest match wins for the same reason it
     * does in `bountyCharacter`: an entity labelled both « Sanji » and
     * « Vinsmoke Sanji » is one person, and the fuller name is the one that
     * settles which manifest entry it is.
     */
    if (!seen || row.label.length > seen.label.length) {
      byEntity.set(row.entity_id, { entityId: row.entity_id, label: row.label, character })
    }
  }

  return [...byEntity.values()]
}

/** Characters the manifest covers, for a page that wants to say so. */
export function bountyCharacterCount(): number {
  return BOUNTY_HISTORY.length
}
