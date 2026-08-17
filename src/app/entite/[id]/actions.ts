'use server'

import { revalidatePath } from 'next/cache'
import { resolveBoundary } from '@/db/boundary.ts'
import { requireOwner } from '@/domains/auth/session.ts'
import {
  entityCandidates,
  type EntityCandidate,
} from '@/domains/knowledge/candidates.ts'
import {
  identifyEntities,
  proposeIdentity,
  type IdentifyProposal,
  type IdentifyResult,
} from '@/domains/knowledge/identify.ts'
import type { LabelKind } from '@/domains/knowledge/label-kind.ts'
import { renameEntityLabel, type RenameResult } from '@/domains/knowledge/rename.ts'
import { retypeEntity, type RetypeResult } from '@/domains/knowledge/retype.ts'
import {
  retractAssertion,
  reviseAssertion,
  type RetractResult,
  type ReviseResult,
} from '@/domains/knowledge/revise.ts'

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

export interface IdentifyProposalResult {
  ok: boolean
  proposal?: IdentifyProposal
  error?: string
}

export interface IdentifyActionResult {
  ok: boolean
  result?: IdentifyResult
  error?: string
}

export interface ReviseActionResult {
  ok: boolean
  result?: ReviseResult
  error?: string
}

export interface RetractActionResult {
  ok: boolean
  result?: RetractResult
  error?: string
}

export interface CandidatesActionResult {
  ok: boolean
  candidates?: EntityCandidate[]
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

/**
 * What identifying these two would do, before it is done.
 *
 * A question, never a write — the same split as `retypeEntityAction`'s first
 * call, and for a stronger reason: a merge changes what the fiche is *called*
 * from a chapter onwards, and the date it is written at is the whole content of
 * the operation. So the panel asks first, gets back the two labels, the chapter
 * the sources support and the earliest one that would make sense, and only then
 * offers a button that says what it will do.
 */
export async function identityProposalAction(input: {
  entityId: string
  otherId: string
}): Promise<IdentifyProposalResult> {
  try {
    const session = await requireOwner()
    const proposal = await proposeIdentity(session.userId, input)
    return { ok: true, proposal }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Rapprochement impossible.',
    }
  }
}

/**
 * Write the identity, at the chapter you confirmed.
 *
 * Both fiches move, and so does everything that reads the graph as components:
 * the two pages become one reading, the graph draws one node from that chapter
 * on, the search finds him under either name, the story thread names him under
 * the better of the two. Revalidated together rather than one at a time, since
 * a merge that shows on one page and not the other is a graph disagreeing with
 * itself.
 *
 * `requireOwner()` again — an action is a POST endpoint whether or not a button
 * was rendered, and the two ids are the only things taken from the browser. The
 * domain re-reads both rows by owner before writing anything.
 */
export async function identifyEntitiesAction(input: {
  entityId: string
  otherId: string
  chapter: number
}): Promise<IdentifyActionResult> {
  try {
    const session = await requireOwner()
    const result = await identifyEntities(session.userId, input)

    revalidatePath(`/entite/${result.subjectId}`)
    revalidatePath(`/entite/${result.objectId}`)
    revalidatePath('/graph')
    revalidatePath('/graph/table')
    revalidatePath('/recherche')
    revalidatePath('/histoire')
    revalidatePath('/chronologie')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Rapprochement impossible.',
    }
  }
}

/**
 * Correct a fact, from the fiche that states it.
 *
 * `requireOwner()` for the third time in this file and for the same reason: an
 * action is a POST endpoint anyone can reach whether or not a button was
 * rendered for them, and the ids in the body are the only things taken from the
 * browser — the domain function re-reads both rows by owner before writing.
 *
 * Two fiches move, not one. « Baggy appartient à l'Équipage du Roux » is on
 * Baggy's page and on the crew's, so a correction that leaves the second one
 * standing has fixed half the defect; the corrected target gains the fact and is
 * named here too. The graph draws the edge, the table lists it, the search
 * indexes it and the timeline reads it, so all four follow.
 */
export async function reviseFactAction(input: {
  assertionId: string
  predicate?: string
  objectEntityId?: string
  objectValue?: string
  comment?: string
}): Promise<ReviseActionResult> {
  try {
    const session = await requireOwner()
    const result = await reviseAssertion(session.userId, input)

    revalidatePath(`/entite/${result.subjectEntityId}`)
    if (result.fromEntityId) revalidatePath(`/entite/${result.fromEntityId}`)
    if (result.toEntityId) revalidatePath(`/entite/${result.toEntityId}`)
    revalidatePath('/graph')
    revalidatePath('/graph/table')
    revalidatePath('/recherche')
    revalidatePath('/chronologie')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Correction impossible.',
    }
  }
}

/** Take a fact back. Same guard, same pages: it disappears from all of them. */
export async function retractFactAction(input: {
  assertionId: string
  comment?: string
}): Promise<RetractActionResult> {
  try {
    const session = await requireOwner()
    const result = await retractAssertion(session.userId, input)

    revalidatePath(`/entite/${result.subjectEntityId}`)
    if (result.objectEntityId) revalidatePath(`/entite/${result.objectEntityId}`)
    revalidatePath('/graph')
    revalidatePath('/graph/table')
    revalidatePath('/recherche')
    revalidatePath('/chronologie')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Retrait impossible.',
    }
  }
}

/**
 * Which entity did you mean — searched at the chapter you are reading at.
 *
 * A read, in a file of writes, and it stays here because it is one half of a
 * correction: the form cannot offer a target it has not looked up. `requireOwner()`
 * all the same — the structural test in tests/antispoiler forbids the read-only
 * session helper anywhere in an action file, and it is right to: this returns
 * names from a private library.
 *
 * The boundary comes from the page the form is on, clamped to the library's own
 * ceiling. The fiche can be read at a rewound slider, and a correction made
 * there must not be the one place that hands back a crew from four hundred
 * chapters ahead.
 */
export async function factTargetsAction(input: {
  query: string
  boundary: number
  accepts?: string[]
  exclude?: string[]
}): Promise<CandidatesActionResult> {
  try {
    const session = await requireOwner()
    const candidates = await entityCandidates(
      session.userId,
      resolveBoundary(input.boundary, session.maxChapter),
      {
        query: input.query,
        accepts: input.accepts,
        exclude: input.exclude,
      },
    )

    return { ok: true, candidates }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Recherche impossible.',
    }
  }
}
