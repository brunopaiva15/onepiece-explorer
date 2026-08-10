/**
 * What a search returns.
 *
 * Every result carries the mode that found it. That is not diagnostics — it is
 * shown to the reader, because "matched your exact words" and "looks similar to
 * something you typed" deserve different amounts of trust, and a ranked list
 * that hides which is which asks the reader to take the ordering on faith.
 */

export type SearchMode = 'lexical' | 'fuzzy' | 'graph' | 'semantic'

export type ResultKind =
  | 'entity'
  | 'text_block'
  | 'event'
  | 'mystery'
  | 'panel'

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
