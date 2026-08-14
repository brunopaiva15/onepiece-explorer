/**
 * The arcs of the work, as chapter numbers.
 *
 * Not knowledge, and deliberately not in the graph. Everything else on a page
 * of this site is something the reader was *told* by a chapter they have read,
 * held behind the boundary and read at it. An arc is not that: it is the table
 * of contents of a work that has been published for thirty years, the same for
 * everyone, and known before the first chapter is opened. Putting it through
 * the extraction would be inventing an uncertainty that does not exist.
 *
 * It follows that it spoils nothing, and the reason is worth writing down
 * because it is the question this file has to answer: naming the arc of a
 * chapter tells the reader the name of a place they are already reading about.
 * A label never appears beside a chapter the reader has not reached — it is
 * derived from a number that is already on their screen — and it never names
 * what comes next.
 *
 * Openings rather than ranges: an arc runs until the next one begins. Stated as
 * pairs of bounds, the table would have holes and overlaps to get wrong, and a
 * chapter falling in a hole would be a chapter belonging to no arc — here that
 * is unrepresentable. The last arc has no end, being the one still coming out.
 *
 * The names are the French ones where French readers use one — « Pays des Wa »,
 * « Rêverie », « Après-guerre » — and the original otherwise, which is what the
 * same readers say about Water Seven and Punk Hazard.
 */

/** An arc, with the stretch of chapters it covers. */
export interface Arc {
  name: string
  /** Its first chapter, inclusive. */
  from: number
  /** Its last chapter, inclusive. Null while the arc is still being told. */
  to: number | null
}

/**
 * Each arc's first chapter, ascending. The list this file is built from.
 */
const OPENINGS: ReadonlyArray<readonly [chapter: number, name: string]> = [
  [1, 'Romance Dawn'],
  [8, 'Orange Town'],
  [22, 'Syrup Village'],
  [42, 'Baratie'],
  [69, 'Arlong Park'],
  [96, 'Loguetown'],
  [101, 'Reverse Mountain'],
  [106, 'Whisky Peak'],
  [115, 'Little Garden'],
  [130, 'Drum Island'],
  [155, 'Alabasta'],
  [218, 'Jaya'],
  [237, 'Skypiea'],
  [303, 'Long Ring Long Land'],
  [322, 'Water Seven'],
  [375, 'Enies Lobby'],
  [431, 'Post-Enies Lobby'],
  [442, 'Thriller Bark'],
  [490, 'Archipel Sabaody'],
  [514, 'Amazon Lily'],
  [525, 'Impel Down'],
  [550, 'Marineford'],
  [581, 'Après-guerre'],
  [598, 'Retour à Sabaody'],
  [603, 'Île des Hommes-Poissons'],
  [654, 'Punk Hazard'],
  [700, 'Dressrosa'],
  [802, 'Zou'],
  [825, 'Whole Cake Island'],
  [903, 'Rêverie'],
  [909, 'Pays des Wa'],
  [1058, 'Egghead'],
  [1126, 'Elbaf'],
]

/** The same list, with each arc's end filled in from the next one's start. */
export const ARCS: readonly Arc[] = OPENINGS.map(([from, name], index) => ({
  name,
  from,
  to: OPENINGS[index + 1] ? OPENINGS[index + 1]![0] - 1 : null,
}))

/**
 * The arc a chapter belongs to, or null when no arc claims it.
 *
 * Null is a real answer rather than a defensive one: a library holding a
 * chapter 0, or a work that is not this one, has no arc to name and saying so
 * is the honest reply. Every caller renders nothing in that case, which is why
 * this returns null instead of guessing at the nearest arc.
 */
export function arcOf(chapter: number): Arc | null {
  if (!Number.isFinite(chapter)) return null
  const number = Math.floor(chapter)

  // Backwards: the arc in force is the last one to have opened at or before
  // this chapter, and the newest chapters are the ones asked about most.
  for (let index = ARCS.length - 1; index >= 0; index -= 1) {
    const arc = ARCS[index]!
    if (number >= arc.from) return arc
  }
  return null
}
