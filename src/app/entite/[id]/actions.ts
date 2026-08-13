'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import type { LabelKind } from '@/domains/knowledge/label-kind.ts'
import { renameEntityLabel, type RenameResult } from '@/domains/knowledge/rename.ts'
import { retypeEntity, type RetypeResult } from '@/domains/knowledge/retype.ts'

export interface RenameActionResult {
  ok: boolean
  result?: RenameResult
  error?: string
}

export interface RetypeActionResult {
  ok: boolean
  result?: RetypeResult
  error?: string
}

/**
 * Correct a name from the fiche that shows it.
 *
 * `requireOwner()`, and the read-only session helper is not named anywhere in
 * this file — a structural test forbids it in a write surface, because the two
 * are equally plausible at a call site like this one and only one of them
 * requires a signed-in user. The fiche is readable by a visitor when the library
 * is public, and an action is a POST endpoint anyone can reach whether or not
 * the button was ever rendered for them. The label id is the only thing taken
 * from the browser; the domain function re-reads the row by owner before
 * touching it.
 *
 * `revalidatePath` on the fiche is what makes the corrected name appear in the
 * same roundtrip: the action's response then carries the re-rendered route
 * beside its return value, so the reader sees « Hermep » without a second
 * request. The other three pages hold the same name — the graph draws it, the
 * search indexes it, the timeline prints it — and they are force-dynamic, so
 * naming them here costs nothing and keeps the list honest about what a rename
 * touches.
 */
export async function renameEntityAction(input: {
  labelId: string
  label: string
  kind?: LabelKind
  keepPrevious?: boolean
}): Promise<RenameActionResult> {
  try {
    const session = await requireOwner()
    const result = await renameEntityLabel(session.userId, input)

    revalidatePath(`/entite/${result.entityId}`)
    revalidatePath('/graph')
    revalidatePath('/recherche')
    revalidatePath('/chronologie')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Renommage impossible.',
    }
  }
}

/**
 * Say what an entity is, from the fiche that got it wrong.
 *
 * `requireOwner()` for the same reason the rename does it: an action is a POST
 * endpoint anyone can reach, and the id in the body is the only thing taken
 * from the browser — the domain function re-reads the row by owner before
 * touching it, and refuses a type the ontology does not have.
 *
 * The first call is a question, not a write. When facts stand in the way it
 * returns them with `applied: false` and nothing changed, so the revalidation
 * below would be pointless — the pages are named only once something actually
 * moved. The graph draws the type as a colour, the table prints it and the
 * timeline reads it, so all three follow the fiche.
 */
export async function retypeEntityAction(input: {
  entityId: string
  nodeType: string
  confirm?: boolean
}): Promise<RetypeActionResult> {
  try {
    const session = await requireOwner()
    const result = await retypeEntity(session.userId, input)

    if (result.applied) {
      revalidatePath(`/entite/${result.entityId}`)
      revalidatePath('/graph')
      revalidatePath('/graph/table')
      revalidatePath('/recherche')
      revalidatePath('/chronologie')
    }

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'Changement de type impossible.',
    }
  }
}
