import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyFinding, openFindings, writeFindings } from '@/domains/review/audit-run.ts'
import type { AuditFinding, AuditFix } from '@/domains/review/audit.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce que les boutons de la page d'analyse écrivent, et ce qu'ils n'écrivent
 * jamais.
 *
 * Les règles et les lectures se testent sans base : ce qui se teste ici est la
 * moitié qui écrit, et cinq promesses tiennent ou ne tiennent pas :
 *
 *   rien n'est supprimé — une identité fausse passe à « rejetée » ;
 *   aucune identité n'est publiée — le geste dépose une carte de revue ;
 *   l'état d'une question est recalculé, jamais posé à la main ;
 *   une nouvelle relation sensible est verrouillée et donnée pour la parole du
 *   lecteur ;
 *   chaque correction est idempotente, et journalisée.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([100, 113, 197])
})

afterAll(async () => {
  await closeDb()
})

function finding(fix: AuditFix, input?: Partial<AuditFinding>): AuditFinding {
  return {
    kind: 'mystere_resolu_trop_tard',
    chapter: 113,
    title: 'un constat',
    detail: 'ce qui cloche',
    subjectEntityId: null,
    objectEntityId: null,
    fingerprint: `f-${fix.action}`,
    subject: 'sujet',
    fix,
    ...input,
  }
}

async function queue(fix: AuditFix, input?: Partial<AuditFinding>): Promise<string> {
  await writeFindings(world.userId, world.workId, [finding(fix, input)], 'mysteres', ['sujet'])
  const rows = await openFindings(world.userId, world.workId)
  const row = rows.find((candidate) => candidate.fix?.action === fix.action)
  if (!row) throw new Error(`constat introuvable pour ${fix.action}`)
  return row.id
}

/** Une question et deux scènes qui pourraient y répondre. */
async function aQuestionAndItsScenes(): Promise<{
  mystery: string
  early: string
  late: string
}> {
  const mystery = await createEntity(world, 'mystery', 100)
  await addLabel(world, mystery, 'Qui est réellement Mr 0 ?', 'alias', 100, 50)
  await addMystery(world, mystery, { question: 'Qui est réellement Mr 0 ?', openedIn: 100 })

  const early = await createEntity(world, 'event', 113)
  await addEvent(world, early, { summary: 'Igaram révèle le nom de Mr 0.', shownIn: 113 })

  const late = await createEntity(world, 'event', 197)
  await addEvent(world, late, { summary: 'Crocodile se montre enfin.', shownIn: 197 })

  return { mystery, early, late }
}

async function mysteryRow(entityId: string) {
  const rows = (await raw`
    SELECT state::text AS state, resolved_in_chapter FROM mysteries
     WHERE entity_id = ${entityId}
  `) as unknown as Array<{ state: string; resolved_in_chapter: number | null }>
  return rows[0]!
}

describe('écrire la réponse d’une question', () => {
  it('l’écrit verrouillée, puis recalcule l’état depuis les relations acceptées', async () => {
    const { mystery, late } = await aQuestionAndItsScenes()

    const id = await queue({
      action: 'publier_resolution',
      mysteryEntityId: mystery,
      sceneEntityId: late,
      chapter: 197,
    })

    const applied = await applyFinding(world.userId, id)
    expect(applied.ok).toBe(true)
    expect(applied.message).toContain('197')

    const written = (await raw`
      SELECT epistemic_status::text AS epistemic, locked, proposed_by::text AS by,
             knowledge_from_chapter, review_status::text AS status
        FROM assertions
       WHERE predicate = 'resolves_mystery' AND object_entity_id = ${mystery}
    `) as unknown as Array<{
      epistemic: string
      locked: boolean
      by: string
      knowledge_from_chapter: number
      status: string
    }>

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      epistemic: 'user_validated',
      locked: true,
      by: 'user',
      status: 'accepted',
    })

    expect(await mysteryRow(mystery)).toEqual({ state: 'resolved', resolved_in_chapter: 197 })
  })

  it('ramène la date à la plus ancienne réponse, sans retirer la plus tardive', async () => {
    const { mystery, early, late } = await aQuestionAndItsScenes()

    await addAssertion(world, {
      subject: late,
      predicate: 'resolves_mystery',
      object: mystery,
      knowledgeFrom: 197,
    })
    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 197
       WHERE entity_id = ${mystery}
    `

    const id = await queue({
      action: 'publier_resolution',
      mysteryEntityId: mystery,
      sceneEntityId: early,
      chapter: 113,
    })

    expect((await applyFinding(world.userId, id)).ok).toBe(true)
    expect(await mysteryRow(mystery)).toEqual({ state: 'resolved', resolved_in_chapter: 113 })

    const kept = (await raw`
      SELECT count(*)::int AS n FROM assertions
       WHERE predicate = 'resolves_mystery' AND object_entity_id = ${mystery}
         AND review_status = 'accepted'
    `) as unknown as Array<{ n: number }>

    expect(kept[0]?.n).toBe(2)
  })

  it('n’écrit pas deux fois la même relation', async () => {
    const { mystery, late } = await aQuestionAndItsScenes()

    const first = await queue({
      action: 'publier_resolution',
      mysteryEntityId: mystery,
      sceneEntityId: late,
      chapter: 197,
    })
    expect((await applyFinding(world.userId, first)).ok).toBe(true)

    const second = await queue(
      { action: 'publier_resolution', mysteryEntityId: mystery, sceneEntityId: late, chapter: 197 },
      { fingerprint: 'f-encore' },
    )
    expect((await applyFinding(world.userId, second)).ok).toBe(true)

    const rows = (await raw`
      SELECT count(*)::int AS n FROM assertions
       WHERE predicate = 'resolves_mystery' AND object_entity_id = ${mystery}
    `) as unknown as Array<{ n: number }>

    expect(rows[0]?.n).toBe(1)
  })

  it('refuse un constat déjà tranché', async () => {
    const { mystery, late } = await aQuestionAndItsScenes()
    const id = await queue({
      action: 'publier_resolution',
      mysteryEntityId: mystery,
      sceneEntityId: late,
      chapter: 197,
    })

    expect((await applyFinding(world.userId, id)).ok).toBe(true)
    const again = await applyFinding(world.userId, id)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('déjà tranché')
  })
})

describe('retirer une réponse qui n’en est pas une', () => {
  it('la passe à « rejetée » sans la supprimer, et rouvre la question', async () => {
    const { mystery, late } = await aQuestionAndItsScenes()

    const assertionId = await addAssertion(world, {
      subject: late,
      predicate: 'resolves_mystery',
      object: mystery,
      knowledgeFrom: 197,
    })
    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 197
       WHERE entity_id = ${mystery}
    `

    const id = await queue({
      action: 'retirer_resolution',
      assertionId,
      mysteryEntityId: mystery,
    })

    expect((await applyFinding(world.userId, id)).ok).toBe(true)

    const rows = (await raw`
      SELECT review_status::text AS status FROM assertions WHERE id = ${assertionId}
    `) as unknown as Array<{ status: string }>

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('rejected')
    expect(await mysteryRow(mystery)).toEqual({ state: 'open', resolved_in_chapter: null })
  })
})

describe('recalculer l’état d’une question', () => {
  it('le refait depuis les relations acceptées, sans en écrire ni en retirer', async () => {
    const { mystery, early } = await aQuestionAndItsScenes()

    await addAssertion(world, {
      subject: early,
      predicate: 'resolves_mystery',
      object: mystery,
      knowledgeFrom: 113,
    })
    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 197
       WHERE entity_id = ${mystery}
    `

    const id = await queue({ action: 'recalculer_mystere', mysteryEntityId: mystery })
    const applied = await applyFinding(world.userId, id)

    expect(applied.ok).toBe(true)
    expect(await mysteryRow(mystery)).toEqual({ state: 'resolved', resolved_in_chapter: 113 })

    const rows = (await raw`
      SELECT count(*)::int AS n FROM assertions WHERE object_entity_id = ${mystery}
    `) as unknown as Array<{ n: number }>
    expect(rows[0]?.n).toBe(1)
  })

  it('rend une question à « sans réponse » quand plus rien ne la referme', async () => {
    const { mystery } = await aQuestionAndItsScenes()
    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 197
       WHERE entity_id = ${mystery}
    `

    const id = await queue({ action: 'recalculer_mystere', mysteryEntityId: mystery })
    const applied = await applyFinding(world.userId, id)

    expect(applied.message).toContain('sans réponse')
    expect(await mysteryRow(mystery)).toEqual({ state: 'open', resolved_in_chapter: null })
  })

  it('écarte une réponse datée du chapitre qui a posé la question', async () => {
    const { mystery } = await aQuestionAndItsScenes()

    /*
     * Une question est ouverte par un chapitre qui la laisse en suspens : une
     * réponse au même chapitre est le plus souvent la scène qui l'a *posée*.
     * Le recalcul doit l'ignorer, sans quoi il refermerait la question sur son
     * propre chapitre d'ouverture. (Une relation d'un nœud vers lui-même, elle,
     * est déjà refusée par la base — voir la migration 0028.)
     */
    const meme = await createEntity(world, 'event', 100)
    await addEvent(world, meme, { summary: 'Vivi entend une voix.', shownIn: 100 })
    await addAssertion(world, {
      subject: meme,
      predicate: 'resolves_mystery',
      object: mystery,
      knowledgeFrom: 100,
    })
    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 100
       WHERE entity_id = ${mystery}
    `

    const id = await queue({ action: 'recalculer_mystere', mysteryEntityId: mystery })
    await applyFinding(world.userId, id)

    expect(await mysteryRow(mystery)).toEqual({ state: 'open', resolved_in_chapter: null })
  })
})

describe('une identité que le texte révèle', () => {
  it('devient une carte de revue, jamais un fait', async () => {
    const silhouette = await createEntity(world, 'character', 113)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 113, 10)
    const nomme = await createEntity(world, 'character', 113)
    await addLabel(world, nomme, 'Tony Tony Chopper', 'true_name', 113, 100)

    const id = await queue({
      action: 'proposer_identite',
      subjectEntityId: silhouette,
      objectEntityId: nomme,
      chapter: 113,
      ref: 'b1',
      excerpt: 'son véritable nom est Tony Tony Chopper',
      note: 'Le chapitre 113 les donne pour la même chose.',
    })

    const applied = await applyFinding(world.userId, id)
    expect(applied.ok).toBe(true)
    expect(applied.message).toContain('centre de revue')

    const cards = (await raw`
      SELECT payload, requires_explicit_review, status::text AS status
        FROM review_items WHERE user_id = ${world.userId}
    `) as unknown as Array<{
      payload: { subject: string; object: string; predicate: string }
      requires_explicit_review: boolean
      status: string
    }>

    expect(cards).toHaveLength(1)
    expect(cards[0]?.payload).toMatchObject({
      subject: silhouette,
      object: nomme,
      predicate: 'same_as',
    })
    expect(cards[0]?.requires_explicit_review).toBe(true)
    expect(cards[0]?.status).toBe('proposed')

    // Rien dans le graphe : une fusion fausse détruit la chronologie des
    // révélations, et aucun modèle ne la publie.
    const written = (await raw`
      SELECT count(*)::int AS n FROM assertions WHERE predicate = 'same_as'
    `) as unknown as Array<{ n: number }>
    expect(written[0]?.n).toBe(0)
  })

  it('ne dépose pas deux fois la même carte', async () => {
    const silhouette = await createEntity(world, 'character', 113)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 113, 10)
    const nomme = await createEntity(world, 'character', 113)
    await addLabel(world, nomme, 'Tony Tony Chopper', 'true_name', 113, 100)

    const fix: AuditFix = {
      action: 'proposer_identite',
      subjectEntityId: silhouette,
      objectEntityId: nomme,
      chapter: 113,
      ref: 'b1',
      excerpt: 'son véritable nom est Tony Tony Chopper',
      note: 'Le chapitre 113 les donne pour la même chose.',
    }

    expect((await applyFinding(world.userId, await queue(fix))).ok).toBe(true)

    const again = await applyFinding(
      world.userId,
      await queue(fix, { fingerprint: 'f-encore' }),
    )
    expect(again.message).toContain('attend déjà')

    const cards = (await raw`
      SELECT count(*)::int AS n FROM review_items WHERE user_id = ${world.userId}
    `) as unknown as Array<{ n: number }>
    expect(cards[0]?.n).toBe(1)
  })
})

describe('retirer une identité', () => {
  it('la passe à « rejetée » sans jamais la supprimer', async () => {
    const left = await createEntity(world, 'character', 100)
    await addLabel(world, left, 'Alpha', 'true_name', 100, 100)
    const right = await createEntity(world, 'group', 100)
    await addLabel(world, right, 'Beta', 'true_name', 100, 100)

    const assertionId = await addAssertion(world, {
      subject: left,
      predicate: 'same_as',
      object: right,
      knowledgeFrom: 100,
    })

    const id = await queue({ action: 'retirer_identite', assertionId })
    expect((await applyFinding(world.userId, id)).ok).toBe(true)

    const rows = (await raw`
      SELECT review_status::text AS status FROM assertions WHERE id = ${assertionId}
    `) as unknown as Array<{ status: string }>

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('rejected')
  })

  it('journalise chaque correction', async () => {
    const { mystery, late } = await aQuestionAndItsScenes()
    const id = await queue({
      action: 'publier_resolution',
      mysteryEntityId: mystery,
      sceneEntityId: late,
      chapter: 197,
    })
    await applyFinding(world.userId, id)

    const log = (await raw`
      SELECT action FROM audit_log WHERE user_id = ${world.userId}
    `) as unknown as Array<{ action: string }>

    expect(log.map((row) => row.action)).toContain('audit_mystery_resolved')
  })
})
