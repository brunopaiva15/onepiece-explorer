import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  inputFingerprint,
  needsPass,
  PROMPT_VERSIONS,
  type PassRecord,
} from '@/domains/review/analyses.ts'
import {
  auditState,
  forgetPasses,
  knownAnalysis,
  openFindings,
  passesFor,
  recordPass,
  sweepStory,
  writeFindings,
} from '@/domains/review/audit-run.ts'
import type { AuditFinding } from '@/domains/review/audit.ts'
import { readWithModel } from '@/domains/review/audit-passes.ts'
import { anchoredIn, declines, quotedFrom, verdictLines } from '@/domains/review/verdicts.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce qui rend les lectures payantes reprenables, et ce qui les empêche de
 * s'effacer les unes les autres.
 *
 * Il y avait une seule lecture payante et une seule mémoire, dont la clé était
 * un numéro de chapitre. Il y en a maintenant plusieurs, sur trois sortes de
 * sujets, et deux propriétés doivent tenir sans quoi la page ment :
 *
 *   **une passe ne repaye pas ce qui n'a pas changé** — même matière, même
 *   consigne, on saute ;
 *
 *   **une passe n'efface que ses propres constats, sur ses propres sujets** —
 *   relire une question ne doit jamais emporter ce que cent cinquante
 *   chapitres ont coûté.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3])
})

afterAll(async () => {
  await closeDb()
})

function finding(input: Partial<AuditFinding> & { fingerprint: string }): AuditFinding {
  return {
    kind: 'relecture',
    chapter: 1,
    title: 'un constat',
    detail: null as unknown as string,
    subjectEntityId: null,
    objectEntityId: null,
    fix: null,
    ...input,
  }
}

describe('l’empreinte de ce qui a été donné à lire', () => {
  it('est stable pour une même matière', () => {
    expect(inputFingerprint(['une scène', 'un passage'])).toBe(
      inputFingerprint(['une scène', 'un passage']),
    )
  })

  it('change quand la matière change', () => {
    expect(inputFingerprint(['une scène', 'un passage'])).not.toBe(
      inputFingerprint(['une scène', 'deux passages']),
    )
  })

  it('distingue deux découpages du même texte', () => {
    // Sans séparateur, ['ab', 'c'] et ['a', 'bc'] auraient la même empreinte, et
    // deux jeux de passages différents se croiraient identiques.
    expect(inputFingerprint(['ab', 'c'])).not.toBe(inputFingerprint(['a', 'bc']))
  })

  it('distingue l’ordre, parce que l’ordre des passages est celui du chapitre', () => {
    expect(inputFingerprint(['a', 'b'])).not.toBe(inputFingerprint(['b', 'a']))
  })
})

describe('ce qui décide de repayer une lecture', () => {
  const previous: PassRecord = {
    analysis: 'scenes',
    subjectKind: 'chapter',
    subject: '12',
    inputFingerprint: 'abc',
    promptVersion: 's1',
  }

  it('ne repaye rien quand rien n’a bougé', () => {
    expect(needsPass(previous, { inputFingerprint: 'abc', promptVersion: 's1' })).toBe(false)
  })

  it('repaye quand le sujet a changé', () => {
    expect(needsPass(previous, { inputFingerprint: 'def', promptVersion: 's1' })).toBe(true)
  })

  it('repaye quand la consigne a changé', () => {
    expect(needsPass(previous, { inputFingerprint: 'abc', promptVersion: 's2' })).toBe(true)
  })

  it('repaye ce qui n’a jamais été lu', () => {
    expect(needsPass(undefined, { inputFingerprint: 'abc', promptVersion: 's1' })).toBe(true)
  })
})

describe('la mémoire d’une analyse', () => {
  it('retient un sujet lu et le rend à la passe suivante', async () => {
    await recordPass(world.userId, world.workId, {
      analysis: 'scenes',
      subjectKind: 'chapter',
      subject: '2',
      inputFingerprint: 'abc',
      promptVersion: PROMPT_VERSIONS.scenes,
      modelId: 'claude-sonnet-5',
      costCents: 1.5,
      findings: 2,
      ok: true,
    })

    const passes = await passesFor(world.userId, world.workId, 'scenes')
    expect(passes.get('2')).toMatchObject({
      subject: '2',
      inputFingerprint: 'abc',
      promptVersion: PROMPT_VERSIONS.scenes,
    })

    expect(
      needsPass(passes.get('2'), {
        inputFingerprint: 'abc',
        promptVersion: PROMPT_VERSIONS.scenes,
      }),
    ).toBe(false)
  })

  it('laisse un échec à relire, tout en le disant', async () => {
    await recordPass(world.userId, world.workId, {
      analysis: 'scenes',
      subjectKind: 'chapter',
      subject: '3',
      inputFingerprint: 'abc',
      promptVersion: PROMPT_VERSIONS.scenes,
      modelId: null,
      costCents: 0,
      findings: 0,
      ok: false,
      failure: 'Overloaded',
    })

    const passes = await passesFor(world.userId, world.workId, 'scenes')

    // La ligne existe — la page peut annoncer l'échec — mais son empreinte ne
    // correspond à rien, donc le sujet reste à lire.
    expect(
      needsPass(passes.get('3'), {
        inputFingerprint: 'abc',
        promptVersion: PROMPT_VERSIONS.scenes,
      }),
    ).toBe(true)

    const state = await auditState(world.userId, world.workId)
    expect(state.analyses.find((row) => row.analysis === 'scenes')).toMatchObject({
      read: 0,
      failed: 1,
    })
  })

  it('ne dédouble pas une ligne quand la même passe est rejouée', async () => {
    for (const cost of [1, 2]) {
      await recordPass(world.userId, world.workId, {
        analysis: 'mysteres',
        subjectKind: 'mystery',
        subject: 'm-1',
        inputFingerprint: `f${cost}`,
        promptVersion: PROMPT_VERSIONS.mysteres,
        modelId: 'claude-sonnet-5',
        costCents: cost,
        findings: 0,
        ok: true,
      })
    }

    const rows = (await raw`
      SELECT count(*)::int AS n, max(cost_cents) AS cost FROM audit_passes
       WHERE user_id = ${world.userId} AND analysis = 'mysteres'
    `) as unknown as Array<{ n: number; cost: string }>

    expect(rows[0]?.n).toBe(1)
    expect(Number(rows[0]?.cost)).toBe(2)
  })

  it('n’efface qu’une analyse à la fois', async () => {
    for (const analysis of ['scenes', 'mysteres'] as const) {
      await recordPass(world.userId, world.workId, {
        analysis,
        subjectKind: analysis === 'scenes' ? 'chapter' : 'mystery',
        subject: 'x',
        inputFingerprint: 'abc',
        promptVersion: PROMPT_VERSIONS[analysis],
        modelId: null,
        costCents: 0,
        findings: 0,
        ok: true,
      })
    }

    expect(await forgetPasses(world.userId, world.workId, 'scenes')).toBe(1)
    expect((await passesFor(world.userId, world.workId, 'scenes')).size).toBe(0)
    expect((await passesFor(world.userId, world.workId, 'mysteres')).size).toBe(1)
  })

  it('refuse un nom d’analyse inventé', () => {
    expect(knownAnalysis('mysteres')).toBe('mysteres')
    expect(knownAnalysis('tout-relire')).toBeNull()
  })
})

describe('le nettoyage d’une passe', () => {
  it('n’emporte pas les constats d’un autre sujet de la même analyse', async () => {
    await writeFindings(
      world.userId,
      world.workId,
      [
        finding({ fingerprint: 'f-1', subject: '1', chapter: 1 }),
        finding({ fingerprint: 'f-2', subject: '2', chapter: 2 }),
      ],
      'scenes',
      ['1', '2'],
    )

    // Le chapitre 1 est relu et ne trouve plus rien ; le 2 n'a pas été relu.
    const outcome = await writeFindings(world.userId, world.workId, [], 'scenes', ['1'])
    expect(outcome.resolved).toBe(1)

    const left = await openFindings(world.userId, world.workId)
    expect(left.map((row) => row.title)).toHaveLength(1)
  })

  it('n’emporte pas les constats d’une autre analyse', async () => {
    await writeFindings(
      world.userId,
      world.workId,
      [finding({ fingerprint: 'f-scene', subject: '1' })],
      'scenes',
      ['1'],
    )
    await writeFindings(
      world.userId,
      world.workId,
      [finding({ kind: 'mystere_resolu_trop_tard', fingerprint: 'f-mystere', subject: 'm-1' })],
      'mysteres',
      ['m-1'],
    )

    // Une passe sur une question qui ne trouve plus rien.
    await writeFindings(world.userId, world.workId, [], 'mysteres', ['m-1'])

    const left = await openFindings(world.userId, world.workId)
    expect(left.map((row) => row.kind)).toEqual(['relecture'])
  })

  it('n’emporte pas les constats des règles quand une lecture passe', async () => {
    const entityId = await createEntity(world, 'object', 1)
    await addLabel(
      world,
      entityId,
      'Escargophone utilisé par Crocodile pour contacter les Billions',
      'placeholder',
      1,
      10,
    )
    await sweepStory(world.userId, world.workId)

    const before = await openFindings(world.userId, world.workId)
    expect(before.some((row) => row.kind === 'libelle_verbeux')).toBe(true)

    await writeFindings(world.userId, world.workId, [], 'scenes', ['1'])

    const after = await openFindings(world.userId, world.workId)
    expect(after.some((row) => row.kind === 'libelle_verbeux')).toBe(true)
  })

  it('range chaque constat sous son analyse, pour que la page le dise', async () => {
    await writeFindings(
      world.userId,
      world.workId,
      [finding({ kind: 'identite_douteuse', fingerprint: 'f-id', subject: 'a-1' })],
      'identites',
      ['a-1'],
    )

    const [row] = await openFindings(world.userId, world.workId)
    expect(row?.analysis).toBe('identites')
    expect(row?.source).toBe('modele')
  })

  it('rafraîchit un constat encore ouvert sans rouvrir celui qu’on a écarté', async () => {
    await writeFindings(
      world.userId,
      world.workId,
      [finding({ fingerprint: 'f-1', subject: '1', title: 'première formulation' })],
      'scenes',
      ['1'],
    )

    await raw`
      UPDATE audit_findings SET status = 'ignored' WHERE fingerprint = 'f-1'
    `

    await writeFindings(
      world.userId,
      world.workId,
      [finding({ fingerprint: 'f-1', subject: '1', title: 'seconde formulation' })],
      'scenes',
      ['1'],
    )

    const rows = (await raw`
      SELECT status, title FROM audit_findings WHERE fingerprint = 'f-1'
    `) as unknown as Array<{ status: string; title: string }>

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ignored')
    expect(rows[0]?.title).toBe('première formulation')
  })
})

describe('la discipline commune aux lectures', () => {
  it('garde une citation qui contient une barre verticale', () => {
    const [row] = verdictLines('a | b | il crie : « en avant | toute »', 3)
    expect(row?.[2]).toBe('il crie : « en avant | toute »')
  })

  it('refuse une ligne à qui il manque un champ', () => {
    expect(verdictLines('a | b', 3)).toEqual([])
    expect(verdictLines('a |  | c', 3)).toEqual([])
  })

  it('retire la puce qu’un modèle met devant sa première colonne', () => {
    const [row] = verdictLines('- a | b | c', 3)
    expect(row?.[0]).toBe('a')
  })

  it('replie accents et apostrophes des deux côtés de l’ancrage', () => {
    expect(anchoredIn('execute neanmoins', ['Bell-mère paie mais il l’exécute néanmoins.'])).toBe(
      true,
    )
    expect(anchoredIn('il la relâche', ['Bell-mère paie mais il l’exécute néanmoins.'])).toBe(
      false,
    )
  })

  it('rend le passage qui porte vraiment la citation', () => {
    const passages = [{ id: 'b1', text: 'Alpha parle.' }, { id: 'b2', text: 'Beta répond.' }]
    expect(quotedFrom('Beta répond', passages)?.id).toBe('b2')
    expect(quotedFrom('Gamma se tait', passages)).toBeNull()
  })

  it('lit un refus et une retenue de la même façon', () => {
    expect(declines({ refusal: true, text: 'a | b | c', citations: [] })).toBe(true)
    expect(declines({ refusal: false, text: 'insufficient_data', citations: [] })).toBe(true)
    expect(declines({ refusal: false, text: '   ', citations: [] })).toBe(true)
    expect(declines({ refusal: false, text: 'a | b | c', citations: [] })).toBe(false)
  })
})

/**
 * Ce qu'aucun clic ne doit faire en silence.
 *
 * Les règles sont gratuites et le restent : `sweepStory` tourne sous le
 * fournisseur de rejeu, qui ne sait pas lire, et n'en a pas besoin. Les
 * lectures, elles, refusent de tourner sous ce fournisseur plutôt que de
 * produire des verdicts fondés sur des mots communs — un constat écrit ainsi
 * aurait la forme d'une vraie lecture et retirerait de vraies relations.
 */
describe('ce que le bouton gratuit ne dépense pas', () => {
  it('balaye toute la bibliothèque sans fournisseur qui lise', async () => {
    const entityId = await createEntity(world, 'object', 1)
    await addLabel(world, entityId, 'Escargophone utilisé par Crocodile', 'placeholder', 1, 10)

    const report = await sweepStory(world.userId, world.workId)
    expect(report.found).toBeGreaterThan(0)
  })

  it('refuse une lecture payante sous un fournisseur qui ne lit pas', async () => {
    for (const analysis of ['scenes', 'identites', 'mysteres'] as const) {
      const report = await readWithModel(world.userId, world.workId, analysis)
      expect(report.error).toContain('il ne lit pas')
      expect(report.read).toBe(0)
      expect(report.costCents).toBe(0)
    }

    const passes = await passesFor(world.userId, world.workId, 'scenes')
    expect(passes.size).toBe(0)
  })

  it('refuse de « lire » les règles, qui se relancent', async () => {
    const report = await readWithModel(world.userId, world.workId, 'regles')
    expect(report.error).toContain('gratuites')
  })
})

/**
 * La frontière anti-spoiler, appliquée à l'outil du bibliothécaire.
 *
 * Un constat *contient* la révélation qu'il signale, sous la forme la plus
 * concentrée possible : « ce nom apparaît au chapitre 110 » est le spoiler avec
 * sa note de bas de page. Les tables de l'analyse sont donc refusées au rôle du
 * lecteur plutôt que filtrées pour lui — c'est la décision de la 0029, et la
 * table des passes la suit, parce qu'un sujet lu est le numéro d'un chapitre ou
 * l'identifiant d'une révélation.
 */
describe('ce que le rôle du lecteur ne peut pas atteindre', () => {
  it('refuse les trois tables de l’analyse', async () => {
    for (const table of ['audit_findings', 'audit_passes']) {
      await expect(
        raw.begin(async (tx) => {
          await tx`SELECT set_config('role', 'authenticated', true)`
          await tx.unsafe(`SELECT count(*) FROM ${table}`)
        }),
      ).rejects.toThrow(/permission denied|autorisation/i)
    }
  })
})
