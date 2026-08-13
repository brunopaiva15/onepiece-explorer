/**
 * What a search returns.
 *
 * Every result carries the mode that found it. That is not diagnostics — it is
 * shown to the reader, because "matched your exact words" and "looks similar to
 * something you typed" deserve different amounts of trust, and a ranked list
 * that hides which is which asks the reader to take the ordering on faith.
 */

import { OCCURRENCE_TYPES } from '../knowledge/ontology.ts'

export type SearchMode = 'lexical' | 'fuzzy' | 'graph' | 'semantic'

export type ResultKind =
  | 'entity'
  | 'text_block'
  | 'event'
  | 'mystery'
  | 'panel'

const OCCURRENCE = new Set<string>(OCCURRENCE_TYPES)

/**
 * What sort of result a node is, read from its node type.
 *
 * An event is an entity with a side table, and its label *is* its summary — so
 * a scene found by name arrives from the same query as a character and was
 * announced under the same word. « Dix ans plus tard, Luffy quitte seul le
 * Village de Fuchsia pour prendre la mer, sous le regard de Makino, Hoop Slap
 * et des villageois. · ENTITÉ » is what that produced: a whole sentence
 * presented to the reader as somebody's name, which is a fair description of a
 * bug and no description at all of the graph.
 *
 * Battles and voyages answer « événement », not their own word. The three are
 * one family here — what the reader needs is « ceci est une scène, pas
 * quelqu'un » — and inventing two more badges for it would be a distinction the
 * other search modes cannot make anyway: the `events` table holds all three and
 * says nothing about which.
 *
 * An unknown or absent type is an entity, which is what everything was before
 * this function existed.
 */
export function resultKindFor(nodeType: string | null | undefined): ResultKind {
  if (typeof nodeType !== 'string') return 'entity'
  if (OCCURRENCE.has(nodeType)) return 'event'
  return nodeType === 'mystery' ? 'mystery' : 'entity'
}

export interface SearchHit {
  kind: ResultKind
  /** Entity id for an entity hit; the row's own id otherwise. */
  id: string
  /** The entity this hit belongs to, when it has one. Drives grouping. */
  entityId: string | null
  title: string
  /** The matching text, trimmed to something readable. */
  snippet: string
  /** The chapter the reader learned this in. Always within the boundary. */
  chapterNumber: number
  /** 0-1, comparable only within a mode. Fusion uses rank, not this. */
  score: number
  mode: SearchMode
  /** Why this result is here, in one phrase, for the reader. */
  reason: string
}

export interface SearchResult {
  query: string
  boundaryChapter: number
  hits: SearchHit[]
  /** Which modes actually ran. A mode that is unavailable says so. */
  modes: Array<{ mode: SearchMode; ran: boolean; note?: string }>
}
