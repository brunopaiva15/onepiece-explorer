import 'server-only'

/**
 * How long this invocation may keep starting chapters.
 *
 * A lot that publishes itself has an obvious way to continue: the run that just
 * opened a chapter starts the next one. It works, and it has one failure mode
 * that has to be bounded rather than hoped away — the pipeline executes inside
 * the invocation that started it, `after()` extends that invocation and does not
 * create a new one, and the route's `maxDuration` caps the whole thing. Chain
 * without a limit and the ceiling arrives in the middle of whichever chapter is
 * running, killing it before it can record a failure. That is the exact shape of
 * « plus rien ne bouge », and it is worse than stopping: a chapter stopped
 * between two runs needs nothing, a chapter killed mid-run needs a relaunch.
 *
 * So the invocation carries a window. It opens when a run is started from a
 * request — an import, a publication, a tick, a button — and every chapter
 * chained afterwards runs inside it. When it is spent, the chain stops cleanly
 * at a chapter boundary and whatever is still queued waits for the next tick.
 *
 * Module state is the right scope for exactly this and nothing else: a module
 * lives as long as the isolate, which is the thing whose clock we are trying to
 * respect. A stale window left behind by a previous invocation on a reused
 * isolate is *expired*, and an expired window is replaced by the next entry
 * point — the failure mode is self-healing in the safe direction.
 */

/**
 * Below the 800s the workshop routes declare, with room for the chapter that
 * happens to be running when the window closes and for the publication after it.
 *
 * Le même partage qu'avant — sept dixièmes pour ouvrir des chapitres, trois pour
 * finir celui qui court — appliqué au plafond d'un plan Pro. Ce qui compte dans
 * ce calcul n'est pas la fenêtre mais la marge, et elle passe de quatre-vingt-dix
 * secondes à deux cent quarante : c'est elle qui protège le chapitre commencé
 * juste avant la fermeture, et quatre-vingt-dix secondes pour une extraction plus
 * une publication était le pari le plus serré de ce fichier.
 */
const WINDOW_MS = 560_000

let closesAt: number | null = null

/**
 * Open a window, or keep the one already running.
 *
 * Called wherever a run is started. A fresh request finds no window, or finds
 * one that has expired, and opens its own; a chapter chained from inside a live
 * window joins it rather than extending it, which is the whole point — otherwise
 * every chapter would push the deadline forward and the budget would never end.
 */
export function openChainWindow(now: number = Date.now()): void {
  if (closesAt === null || now >= closesAt) closesAt = now + WINDOW_MS
}

/** Whether there is room to start one more chapter on this invocation. */
export function chainHasTime(now: number = Date.now()): boolean {
  return closesAt !== null && now < closesAt
}

/** Milliseconds left, for a step that says why it stopped. */
export function chainTimeLeftMs(now: number = Date.now()): number {
  return closesAt === null ? 0 : Math.max(0, closesAt - now)
}

/** Tests only: forget the window between scenarios. */
export function resetChainWindow(): void {
  closesAt = null
}
