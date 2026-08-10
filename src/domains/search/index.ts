import 'server-only'
import { modelProvider } from '../ai/index.ts'
import { fuzzySearch } from './fuzzy.ts'
import { expandNeighbours } from './graph.ts'
import { lexicalSearch } from './lexical.ts'
import type { SearchHit, SearchMode, SearchResult } from './types.ts'
import { vectorStore } from './vector-store.ts'

export * from './types.ts'
export { neighbourhood, shortestPath, type PathStep } from './graph.ts'
export {
  vectorStore,
  resetVectorStore,
  hasEmbeddingProvider,
  type EmbeddingRow,
  type VectorStore,
} from './vector-store.ts'

/**
 * Hybrid search.
 *
 * Four modes, fused by reciprocal rank rather than by score. Scores from
 * different modes are not comparable — `ts_rank_cd` and trigram `similarity`
 * are different quantities on different scales — and normalising them into one
 * number would produce an ordering that looks principled and is arbitrary.
 * Reciprocal rank fusion only uses each mode's *ordering*, which is the part
 * each mode is actually good at, and rewards a result several modes agree on.
 *
 * Every mode reports whether it ran. A mode that could not run is shown as
 * unavailable rather than silently contributing nothing — the difference
 * between "your library has no answer" and "one way of looking never happened"
 * is the whole difference between a trustworthy empty result and a misleading
 * one.
 */

/**
 * The k of reciprocal rank fusion. 60 is the value from the original paper and
 * the reason it works here: it flattens the difference between ranks 1 and 2
 * enough that a result two modes both place near the top beats one mode's
 * confident first place.
 */
const RRF_K = 60

export interface SearchOptions {
  limit?: number
  /** Skip the graph expansion when only direct matches are wanted. */
  expand?: boolean
}

export async function search(
  userId: string,
  boundaryChapter: number,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = options.limit ?? 25
  const trimmed = query.trim()

  const modes: SearchResult['modes'] = []

  if (trimmed.length === 0) {
    return { query: trimmed, boundaryChapter, hits: [], modes }
  }

  const [lexical, fuzzy] = await Promise.all([
    lexicalSearch(userId, boundaryChapter, trimmed, limit * 2),
    fuzzySearch(userId, boundaryChapter, trimmed, limit),
  ])

  modes.push({ mode: 'lexical', ran: true })
  modes.push({
    mode: 'fuzzy',
    ran: true,
    ...(trimmed.length < 3
      ? { note: 'Requête trop courte pour une comparaison approchante.' }
      : {}),
  })

  const semantic = await semanticSearch(userId, boundaryChapter, trimmed, limit)
  modes.push(semantic.status)

  /*
   * Graph expansion runs on the entities the other modes found, so it needs
   * them first — hence the sequential step rather than a fourth parallel call.
   * Expanding from nothing would return nothing.
   */
  let graph: SearchHit[] = []
  const seeds = [...lexical, ...fuzzy, ...semantic.hits]
    .filter((hit) => hit.entityId !== null)
    .slice(0, 5)
    .map((hit) => hit.entityId!)

  if (options.expand !== false && seeds.length > 0) {
    graph = await expandNeighbours(userId, boundaryChapter, seeds, limit)
    modes.push({ mode: 'graph', ran: true })
  } else {
    modes.push({
      mode: 'graph',
      ran: false,
      note: 'Aucune entité trouvée par les autres modes : rien à étendre.',
    })
  }

  return {
    query: trimmed,
    boundaryChapter,
    hits: fuse([lexical, fuzzy, semantic.hits, graph], limit),
    modes,
  }
}

/**
 * Reciprocal rank fusion.
 *
 * A result appearing in several lists accumulates score, so agreement between
 * independent modes wins over one mode's certainty. Deduplication is by
 * `kind:id` and keeps the highest-scoring variant's own reason text, so the
 * reader is told the strongest reason the result is present rather than
 * whichever mode happened to be processed last.
 */
function fuse(lists: SearchHit[][], limit: number): SearchHit[] {
  const scored = new Map<string, { hit: SearchHit; score: number; modes: Set<SearchMode> }>()

  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = `${hit.kind}:${hit.id}`
      const contribution = 1 / (RRF_K + index + 1)
      const existing = scored.get(key)

      if (existing) {
        existing.score += contribution
        existing.modes.add(hit.mode)
        // Keep the reason from the mode that ranked it highest.
        if (contribution > 1 / (RRF_K + 1) / 2 && hit.score > existing.hit.score) {
          existing.hit = hit
        }
        return
      }

      scored.set(key, {
        hit: { ...hit },
        score: contribution,
        modes: new Set([hit.mode]),
      })
    })
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.hit,
      score: entry.score,
      reason:
        entry.modes.size > 1
          ? `${entry.hit.reason} (trouvé aussi par ${entry.modes.size - 1} autre${entry.modes.size > 2 ? 's' : ''} méthode${entry.modes.size > 2 ? 's' : ''})`
          : entry.hit.reason,
    }))
}

/**
 * Semantic search, when there is anything to search with.
 *
 * Embedding the *query* is the step that needs a provider, and it is the one
 * that fails silently if unchecked: with no provider the vector is meaningless
 * and every result is noise ranked with confidence.
 */
async function semanticSearch(
  userId: string,
  boundaryChapter: number,
  query: string,
  limit: number,
): Promise<{ hits: SearchHit[]; status: SearchResult['modes'][number] }> {
  const store = await vectorStore()

  if (store.unavailableReason !== null) {
    return {
      hits: [],
      status: { mode: 'semantic', ran: false, note: store.unavailableReason },
    }
  }

  try {
    const embedded = await modelProvider().embed({ texts: [query] })
    const vector = embedded.value[0]
    if (!vector || vector.length === 0) {
      return {
        hits: [],
        status: {
          mode: 'semantic',
          ran: false,
          note: "Le fournisseur n'a pas produit de vecteur pour cette requête.",
        },
      }
    }

    const found = await store.search(userId, boundaryChapter, vector, limit)

    return {
      hits: found.map((hit) => ({
        kind: hit.subjectKind === 'assertion' ? ('event' as const) : ('entity' as const),
        id: hit.subjectId,
        entityId: hit.subjectKind === 'entity' ? hit.subjectId : null,
        title: hit.content.slice(0, 80),
        snippet: hit.content,
        chapterNumber: hit.chapterNumber,
        score: hit.similarity,
        mode: 'semantic' as const,
        reason: 'Sens proche de votre question.',
      })),
      status: { mode: 'semantic', ran: true },
    }
  } catch (error) {
    // A provider that throws must not take the whole search down: the other
    // three modes are independent and still have something to say.
    return {
      hits: [],
      status: {
        mode: 'semantic',
        ran: false,
        note: `Recherche sémantique indisponible : ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    }
  }
}
