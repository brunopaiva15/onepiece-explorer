import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import {
  PROMPT_VERSIONS,
  needsPass,
  type AnalysisKind,
  type SubjectKind,
} from './analyses.ts'
import { inputFingerprint } from './analyses.ts'
import {
  parseRelecture,
  relectureFinding,
  type AuditFinding,
} from './audit.ts'
import { passesFor, recordPass, writeFindings } from './audit-run.ts'
import {
  gapInputs,
  gapQuestion,
  identityGapFinding,
  parseIdentityGaps,
  type GapCandidate,
  type GapPassage,
} from './identity-gaps.ts'
import {
  IDENTITY_WINDOW,
  identityInputs,
  identityQuestion,
  identityVerdictFinding,
  parseIdentityVerdicts,
  passagesAround,
  type IdentitySide,
  type IdentityUnderReview,
} from './identity-review.ts'
import {
  mysteryFindings,
  mysteryInputs,
  resolutionQuestion,
  type MysteryUnderReview,
} from './mystery-audit.ts'
import { scanForResolution, scenePasses, type Scene } from './mystery-sweep.ts'
import {
  parseProvenanceVerdicts,
  provenanceFinding,
  provenanceInputs,
  provenanceQuestion,
} from './provenance.ts'
import {
  parseTwinVerdicts,
  twinCandidates,
  twinFinding,
  twinInputs,
  twinQuestion,
  type TwinPair,
} from './scene-twins.ts'

/**
 * Les lectures payantes de la page d'analyse, et ce qui les rend reprenables.
 *
 * Une par sujet, et le sujet dépend de l'analyse : un chapitre pour la
 * relecture des scènes, les doublons et les identités manquantes ; une
 * assertion pour la validation des identités ; une question pour la datation
 * des réponses. Elles partagent une seule mécanique, écrite une fois ici :
 *
 *   **on demande la liste des sujets** — tous, dans l'ordre de l'histoire ;
 *
 *   **on charge la matière** de chacun et on en calcule l'empreinte ;
 *
 *   **on saute** ce que la passe précédente a lu avec la même matière et la
 *   même consigne. C'est ce qui fait qu'un second clic ne coûte rien ;
 *
 *   **on lit** le reste, par petits paquets — un appel de serveur a un plafond
 *   de durée, et cent cinquante appels de modèle ne tiennent pas dedans ;
 *
 *   **on écrit** les constats, bornés à l'analyse et au sujet, et on retient la
 *   passe.
 *
 * Un échec ne coûte que son sujet et se dit. Il est retenu comme échec, avec sa
 * raison — la page peut donc annoncer « quatre en échec, relancez » —, mais
 * sans empreinte : le sujet reste à lire.
 *
 * Aucune analyse n'est lancée par le bouton « Analyser l'histoire », qui reste
 * gratuit. Chaque panneau a le sien, dit ce qu'il va lire, et affiche le coût
 * pendant plutôt qu'à la fin — c'est la seule façon d'arrêter à temps quelque
 * chose qui se facture au sujet.
 */

/** Combien de passages un sujet offre à sa lecture, au-delà de quoi on coupe. */
const PASSAGES_PER_CHAPTER = 120

/** Et combien de scènes lui sont soumises. Au-delà, le fil n'est plus lisible. */
const SCENES_PER_CHAPTER = 40

/** Combien de fiches une recherche d'identités manquantes met en face du texte. */
const CANDIDATES_PER_CHAPTER = 60

export interface AnalysisFailure {
  subject: string
  label: string
  reason: string
}

export interface AnalysisReport {
  analysis: AnalysisKind
  /** Sujets réellement lus par cette passe. */
  read: number
  /** Sujets sautés parce que rien n'avait changé depuis la dernière lecture. */
  skipped: number
  found: number
  costCents: number
  /** Sujets qu'il reste à lire après cette passe. */
  remaining: number
  failures: AnalysisFailure[]
  /** Sujets dont la matière a été tronquée avant d'être lue. */
  truncated: string[]
  error?: string
}

/**
 * Ce qu'une analyse sait faire, sous une forme que le pilote peut exécuter.
 *
 * Séparé du pilote pour la raison qui sépare les règles de leur exécution :
 * ce qui décide — quels sujets, quelle matière, quel constat — est écrit une
 * fois par analyse, et ce qui compte les paquets, retient les passes et borne
 * le nettoyage est écrit une fois pour toutes.
 */
interface Analyzer<T> {
  analysis: AnalysisKind
  subjectKind: SubjectKind
  subjects(userId: string, workId: string): Promise<Array<{ id: string; label: string }>>
  material(userId: string, workId: string, subject: string): Promise<T | null>
  inputs(material: T): string[]
  truncated(material: T): boolean
  read(
    material: T,
  ): Promise<{ findings: AuditFinding[]; costCents: number; modelId: string | null } | { reason: string }>
}

/**
 * Un fournisseur qui ne lit pas ne juge rien.
 *
 * Le même refus que dans les balayages voisins, et pour la même raison : les
 * modes synthétique et rejeu répondent en comparant des mots, et leurs
 * citations ont la forme des vraies. Une identité retirée par eux serait pire
 * que pas d'analyse du tout.
 */
function providerThatReads():
  | { ok: true; provider: ReturnType<typeof modelProvider> }
  | { ok: false; error: string } {
  const provider = modelProvider()
  if (provider.name === 'replay' || provider.name === 'synthetic') {
    return {
      ok: false,
      error:
        `Fournisseur « ${provider.name} » : il ne lit pas, il compare des mots. ` +
        `Configurez CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ou un modèle local.`,
    }
  }
  return { ok: true, provider }
}

/**
 * L'appel, avec le droit d'échouer deux fois.
 *
 * « Claude Code process exited with code 1 » sur le chapitre 4, puis sur le 7,
 * pendant que le 1, le 2 et le 3 passaient : ce sont des accidents de
 * transport, pas des réponses. Trois tentatives espacées traversent une minute
 * chargée. L'exception est le refus d'identifiant — un jeton révoqué le sera
 * autant dans cinq secondes, et réessayer ne fait que retarder la seule phrase
 * utile.
 */
async function askWithRetry(
  request: Parameters<ReturnType<typeof modelProvider>['answer']>[0],
): Promise<
  { answer: Awaited<ReturnType<ReturnType<typeof modelProvider>['answer']>> } | { reason: string }
> {
  const provider = modelProvider()
  let last = 'appel impossible'

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { answer: await provider.answer(request) }
    } catch (error) {
      last = error instanceof Error ? error.message.split('\n')[0]! : String(error)
      const kind = (error as { kind?: string } | null)?.kind
      if (kind === 'auth') return { reason: last }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 4000))
    }
  }

  return { reason: last }
}

/**
 * Lancer une analyse sur quelques sujets, et dire où elle en est.
 *
 * Le point d'entrée unique des trois panneaux payants. Le nom de l'analyse
 * vient du navigateur et est vérifié ici : ce qui n'est pas dans la table est
 * refusé plutôt que deviné.
 */
export async function readWithModel(
  userId: string,
  workId: string,
  analysis: AnalysisKind,
  batch = 4,
  /**
   * Les sujets à laisser de côté pour cette passe.
   *
   * Un sujet en échec n'est pas marqué comme lu — c'est ce qui permet d'y
   * revenir — mais il reste alors le premier de la liste, donc le paquet
   * suivant le redemande, échoue pareil, et la passe tourne en rond sans
   * jamais atteindre le suivant. La liste vient de l'appelant parce que c'est
   * lui qui traverse la passe.
   */
  skip: readonly string[] = [],
): Promise<AnalysisReport> {
  const idle = {
    analysis,
    read: 0,
    skipped: 0,
    found: 0,
    costCents: 0,
    remaining: 0,
    failures: [],
    truncated: [],
  }

  /*
   * Les règles d'abord, et avant même de regarder le fournisseur : elles n'en
   * ont pas besoin, et leur répondre « configurez une clé » serait mentir sur
   * ce qui manque.
   */
  if (analysis === 'regles') {
    return {
      ...idle,
      error: 'Les règles ne se lisent pas : elles se relancent, et elles sont gratuites.',
    }
  }

  const gate = providerThatReads()
  if (!gate.ok) return { ...idle, error: gate.error }

  switch (analysis) {
    case 'scenes':
      return drive(userId, workId, sceneAnalyzer(userId, workId), batch, skip)
    case 'doublons':
      return drive(userId, workId, twinAnalyzer(userId, workId), batch, skip)
    case 'provenance':
      return drive(userId, workId, provenanceAnalyzer(userId, workId), batch, skip)
    case 'identites':
      return drive(userId, workId, identityAnalyzer(userId, workId), batch, skip)
    case 'identites_manquantes':
      return drive(userId, workId, gapAnalyzer(userId, workId), batch, skip)
    case 'mysteres':
      return drive(userId, workId, mysteryAnalyzer(userId, workId), batch, skip)
  }
}

/**
 * Le pilote : compter les paquets, retenir les passes, borner le nettoyage.
 *
 * L'ordre des trois écritures de fin n'est pas indifférent. Les constats sont
 * écrits **avant** que la passe ne soit retenue : une interruption entre les
 * deux laisse un sujet à relire, ce qui coûte un appel ; l'ordre inverse
 * laisserait un sujet marqué lu dont les constats n'ont jamais été écrits, ce
 * qui coûte un défaut qu'on ne verra plus.
 */
async function drive<T>(
  userId: string,
  workId: string,
  analyzer: Analyzer<T>,
  batch: number,
  skip: readonly string[],
): Promise<AnalysisReport> {
  const promptVersion = PROMPT_VERSIONS[analyzer.analysis]
  const previous = await passesFor(userId, workId, analyzer.analysis)
  const setAside = new Set(skip)

  const all = await analyzer.subjects(userId, workId)
  const pending = all.filter((subject) => !setAside.has(subject.id))

  const report: AnalysisReport = {
    analysis: analyzer.analysis,
    read: 0,
    skipped: 0,
    found: 0,
    costCents: 0,
    remaining: 0,
    failures: [],
    truncated: [],
  }

  const size = Math.max(1, batch)
  let cursor = 0

  for (const subject of pending) {
    /*
     * Le paquet est plein : on s'arrête ici sans charger la matière du reste.
     *
     * Charger la matière est ce qui permet de décider s'il faut relire, et ça
     * coûte plusieurs requêtes par sujet — les passages d'un chapitre, les
     * scènes postérieures à une question. Les charger pour cent quarante-six
     * sujets afin d'en lire quatre ferait de chaque paquet une lecture de toute
     * la bibliothèque, trente-huit fois de suite. Ce qu'il reste est donc
     * *estimé* plus bas, et la boucle du navigateur s'arrête sur « ce paquet
     * n'a rien lu » plutôt que sur ce compte.
     */
    if (report.read >= size) break
    cursor += 1

    const material = await analyzer.material(userId, workId, subject.id)

    /*
     * Un sujet dont la matière a disparu — un chapitre dépublié, une identité
     * retirée entre la liste et ici — n'est ni lu ni compté à lire. Le dire
     * plutôt que de le retenir évite d'écrire une passe sur quelque chose qui
     * n'existe plus.
     */
    if (material === null) continue

    const fingerprint = inputFingerprint(analyzer.inputs(material))
    if (!needsPass(previous.get(subject.id), { inputFingerprint: fingerprint, promptVersion })) {
      report.skipped += 1
      continue
    }

    if (analyzer.truncated(material)) report.truncated.push(subject.label)

    const outcome = await analyzer.read(material)

    if ('reason' in outcome) {
      report.failures.push({ subject: subject.id, label: subject.label, reason: outcome.reason })
      await recordPass(userId, workId, {
        analysis: analyzer.analysis,
        subjectKind: analyzer.subjectKind,
        subject: subject.id,
        inputFingerprint: fingerprint,
        promptVersion,
        modelId: null,
        costCents: 0,
        findings: 0,
        ok: false,
        failure: outcome.reason,
      })
      continue
    }

    const findings = outcome.findings.map((finding) => ({ ...finding, subject: subject.id }))

    await writeFindings(userId, workId, findings, analyzer.analysis, [subject.id])

    await recordPass(userId, workId, {
      analysis: analyzer.analysis,
      subjectKind: analyzer.subjectKind,
      subject: subject.id,
      inputFingerprint: fingerprint,
      promptVersion,
      modelId: outcome.modelId,
      costCents: outcome.costCents,
      findings: findings.length,
      ok: true,
    })

    report.read += 1
    report.found += findings.length
    report.costCents += outcome.costCents
  }

  /*
   * Ce qu'il reste, estimé sans rien charger.
   *
   * Un sujet que la passe n'a pas atteint est à lire s'il n'a jamais été lu,
   * ou s'il l'a été sous une autre consigne. Il peut aussi l'être parce que sa
   * matière a changé, ce que ce compte ne voit pas — c'est délibéré : le
   * découvrir demanderait de charger la matière de tout ce qui reste, et ce
   * nombre ne sert qu'à écrire « 42 à lire » à l'écran. La boucle qui décide
   * d'un nouveau paquet lit « ce paquet a-t-il lu quelque chose », jamais ce
   * compte.
   */
  report.remaining = pending.slice(cursor).filter((subject) => {
    const before = previous.get(subject.id)
    return before === undefined || before.promptVersion !== promptVersion
  }).length

  return report
}

/* ------------------------------------------------------------------------- */
/* Relire les scènes d'un chapitre contre son texte.                          */
/* ------------------------------------------------------------------------- */

interface ChapterMaterial {
  chapter: number
  scenes: Array<{ entityId: string; summary: string }>
  passages: string[]
  cut: boolean
}

function sceneAnalyzer(_userId: string, _workId: string): Analyzer<ChapterMaterial> {
  return {
    analysis: 'scenes',
    subjectKind: 'chapter',
    subjects: publishedChapters,
    material: chapterMaterial,
    inputs: (material) => [
      String(material.chapter),
      ...material.scenes.map((scene) => `${scene.entityId}:${normalizeText(scene.summary)}`),
      ...material.passages.map((passage) => normalizeText(passage)),
    ],
    truncated: (material) => material.cut,
    async read(material) {
      if (material.scenes.length === 0 || material.passages.length === 0) {
        return { findings: [], costCents: 0, modelId: null }
      }

      const attempt = await askWithRetry({
        question: relectureQuestion(material.chapter),
        context: [
          ...material.scenes.map((scene) => ({
            assertionId: scene.entityId,
            chapter: material.chapter,
            statement: `scène ${scene.entityId} : ${scene.summary}`,
            excerpt: null,
          })),
          ...material.passages.map((passage, index) => ({
            assertionId: `p${index + 1}`,
            chapter: material.chapter,
            statement: passage,
            excerpt: null,
          })),
        ],
        boundaryChapter: material.chapter,
      })

      if ('reason' in attempt) return attempt
      const answer = attempt.answer

      const read = answer.refusal ? null : answer.value
      const rows = read
        ? parseRelecture(
            read.answer,
            material.scenes.map((scene) => scene.entityId),
          )
        : []

      /*
       * La citation, quand la ligne n'en portait pas.
       *
       * Le format demande la phrase en quatrième champ, et un modèle la met
       * parfois là où l'appel a un endroit pour les citations. Les deux valent :
       * ce qui est refusé ensuite n'est pas l'endroit d'où vient la phrase,
       * c'est qu'elle ne soit pas dans le chapitre.
       */
      const citations = new Map(
        (read?.citations ?? []).map((citation) => [citation.assertion_id, citation.excerpt]),
      )

      const findings = rows
        .map((row) => {
          const scene = material.scenes.find((candidate) => candidate.entityId === row.entityId)
          if (!scene) return null
          return relectureFinding({
            chapter: material.chapter,
            entityId: row.entityId,
            summary: scene.summary,
            objection: row.objection,
            excerpt: row.excerpt.length > 0 ? row.excerpt : (citations.get(row.entityId) ?? ''),
            passages: material.passages,
            correction: row.correction,
          })
        })
        .filter((finding): finding is AuditFinding => finding !== null)

      return { findings, costCents: answer.usage.costCents, modelId: answer.usage.modelId }
    },
  }
}

/**
 * La consigne, écrite pour être refusable.
 *
 * Le défaut d'un modèle à qui l'on demande « qu'est-ce qui cloche » est de
 * trouver quelque chose : il reformulera une phrase juste pour avoir répondu.
 * La consigne dit donc, dans cet ordre, que ne rien trouver est la réponse
 * attendue, que le savoir extérieur ne compte pas, et que la seule preuve
 * admise est une phrase recopiée du chapitre.
 *
 * Et jamais un chapitre suivant. Le modèle connaît l'œuvre ; si on le laisse
 * corriger une scène du chapitre 41 avec ce qu'il sait du 100, il écrit dans le
 * fil un savoir que le lecteur n'a pas — c'est-à-dire exactement le défaut que
 * ce produit existe pour ne pas commettre.
 */
function relectureQuestion(chapter: number): string {
  return (
    `Voici les scènes que la bibliothèque raconte du chapitre ${chapter}, puis les ` +
    `passages de ce chapitre. Pour chaque scène, la question est : les passages ` +
    `disent-ils bien cela ?\n\n` +
    `Ne signalez qu'une scène que les passages **contredisent** ou qui affirme ce ` +
    `qu'aucun d'eux ne dit. Une scène juste mais moins détaillée que le chapitre ` +
    `n'est pas une erreur. Ne vous servez jamais de ce que vous savez de la suite : ` +
    `seuls ces passages comptent, et une correction tirée d'un chapitre ultérieur ` +
    `serait un spoiler écrit dans le fil.\n\n` +
    `Répondez une ligne par scène fautive, exactement dans cette forme :\n` +
    `identifiant de la scène | ce que les passages contredisent | la phrase corrigée | la phrase du chapitre qui le prouve\n\n` +
    `La phrase du chapitre doit être recopiée mot pour mot depuis un passage. ` +
    `Mettez « - » à la place de la phrase corrigée si vous n'en proposez pas. ` +
    `Si aucune scène n'est fautive, répondez « insufficient_data » et rien d'autre : ` +
    `c'est la réponse la plus fréquente et la plus utile.`
  )
}

/* ------------------------------------------------------------------------- */
/* Départager deux scènes trop proches pour la règle gratuite.                */
/* ------------------------------------------------------------------------- */

interface TwinMaterial {
  chapter: number
  pairs: TwinPair[]
  passages: string[]
  cut: boolean
}

function twinAnalyzer(_userId: string, _workId: string): Analyzer<TwinMaterial> {
  return {
    analysis: 'doublons',
    subjectKind: 'chapter',
    subjects: publishedChapters,
    async material(userId, workId, subject) {
      const chapter = Number(subject)
      const rows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT e.entity_id, e.summary,
                 extract(epoch FROM e.created_at) AS created
            FROM events e
            JOIN entities en ON en.id = e.entity_id
           WHERE e.user_id = ${userId} AND e.work_id = ${workId}
             AND en.review_status = 'accepted'
             AND e.summary IS NOT NULL
             AND COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}
        `),
      )) as unknown as Array<{ entity_id: string; summary: string; created: number }>

      const pairs = twinCandidates(
        rows.map((row) => ({
          entityId: row.entity_id,
          chapter,
          summary: row.summary,
          createdAt: Number(row.created),
        })),
      )

      const material = await chapterMaterial(userId, workId, subject)
      if (material === null) return null

      return { chapter, pairs, passages: material.passages, cut: material.cut }
    },
    inputs: (material) => twinInputs(material.pairs, material.passages),
    truncated: (material) => material.cut,
    async read(material) {
      if (material.pairs.length === 0 || material.passages.length === 0) {
        return { findings: [], costCents: 0, modelId: null }
      }

      const attempt = await askWithRetry({
        question: twinQuestion(material.chapter),
        context: [
          ...material.pairs.map((pair, index) => ({
            assertionId: `paire${index + 1}`,
            chapter: material.chapter,
            statement:
              `paire ${index + 1} — ${pair.left.entityId} : « ${pair.left.summary} » ` +
              `/ ${pair.right.entityId} : « ${pair.right.summary} »`,
            excerpt: null,
          })),
          ...material.passages.map((passage, index) => ({
            assertionId: `p${index + 1}`,
            chapter: material.chapter,
            statement: passage,
            excerpt: null,
          })),
        ],
        boundaryChapter: material.chapter,
      })

      if ('reason' in attempt) return attempt
      const answer = attempt.answer
      const read = answer.refusal ? null : answer.value

      const findings = (read ? parseTwinVerdicts(read.answer, material.pairs) : [])
        .map((row) => twinFinding({ row, pairs: material.pairs, passages: material.passages }))
        .filter((finding): finding is AuditFinding => finding !== null)

      return { findings, costCents: answer.usage.costCents, modelId: answer.usage.modelId }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Soupçonner une scène de venir d'une couverture.                            */
/* ------------------------------------------------------------------------- */

function provenanceAnalyzer(_userId: string, _workId: string): Analyzer<ChapterMaterial> {
  return {
    analysis: 'provenance',
    subjectKind: 'chapter',
    /*
     * Seulement les chapitres sans pages.
     *
     * Un chapitre avec des pages porte sa provenance dans le graphe, et la
     * règle gratuite la lit sans rien payer. Ne restent que ceux importés en
     * résumé, où il n'y a rien à lire d'autre que le texte.
     */
    async subjects(userId, workId) {
      const rows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT c.number
            FROM chapters c
           WHERE c.user_id = ${userId} AND c.work_id = ${workId}
             AND c.status = 'published'
             AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.chapter_id = c.id)
           ORDER BY c.number
        `),
      )) as unknown as Array<{ number: number }>

      return rows.map((row) => ({ id: String(row.number), label: `chapitre ${row.number}` }))
    },
    material: chapterMaterial,
    inputs: (material) => provenanceInputs(material.scenes, material.passages),
    truncated: (material) => material.cut,
    async read(material) {
      if (material.scenes.length === 0 || material.passages.length === 0) {
        return { findings: [], costCents: 0, modelId: null }
      }

      const attempt = await askWithRetry({
        question: provenanceQuestion(material.chapter),
        context: [
          ...material.scenes.map((scene) => ({
            assertionId: scene.entityId,
            chapter: material.chapter,
            statement: `scène ${scene.entityId} : ${scene.summary}`,
            excerpt: null,
          })),
          ...material.passages.map((passage, index) => ({
            assertionId: `p${index + 1}`,
            chapter: material.chapter,
            statement: passage,
            excerpt: null,
          })),
        ],
        boundaryChapter: material.chapter,
      })

      if ('reason' in attempt) return attempt
      const answer = attempt.answer
      const read = answer.refusal ? null : answer.value

      const findings = (
        read
          ? parseProvenanceVerdicts(
              read.answer,
              material.scenes.map((scene) => scene.entityId),
            )
          : []
      )
        .map((row) => {
          const scene = material.scenes.find((candidate) => candidate.entityId === row.entityId)
          if (!scene) return null
          return provenanceFinding({
            row,
            chapter: material.chapter,
            summary: scene.summary,
            passages: material.passages,
          })
        })
        .filter((finding): finding is AuditFinding => finding !== null)

      return { findings, costCents: answer.usage.costCents, modelId: answer.usage.modelId }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Juger une identité déjà acceptée.                                          */
/* ------------------------------------------------------------------------- */

interface IdentityMaterial {
  identity: IdentityUnderReview
  passages: Array<{ id: string; chapter: number; text: string }>
  cut: boolean
}

function identityAnalyzer(_userId: string, _workId: string): Analyzer<IdentityMaterial> {
  return {
    analysis: 'identites',
    subjectKind: 'identity',
    /*
     * Les identités que les règles gratuites n'ont pas déjà tranchées.
     *
     * Payer un appel pour faire confirmer qu'une question n'est pas une
     * personne serait payer deux fois la même réponse — et le constat existe
     * déjà, avec son correctif.
     */
    async subjects(userId, workId) {
      const rows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT a.id, a.knowledge_from_chapter AS chapter
            FROM assertions a
           WHERE a.user_id = ${userId} AND a.work_id = ${workId}
             AND a.predicate = 'same_as' AND a.review_status = 'accepted'
             AND a.object_entity_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM audit_findings f
                WHERE f.user_id = a.user_id AND f.work_id = a.work_id
                  AND f.analysis = 'regles' AND f.status = 'open'
                  AND f.fix->>'action' = 'retirer_identite'
                  AND f.fix->>'assertionId' = a.id::text)
           ORDER BY a.knowledge_from_chapter, a.id
        `),
      )) as unknown as Array<{ id: string; chapter: number }>

      return rows.map((row) => ({ id: row.id, label: `identité du chapitre ${row.chapter}` }))
    },
    async material(userId, workId, subject) {
      const identity = await identityUnderReview(userId, workId, subject)
      if (identity === null) return null

      /*
       * Seulement les chapitres autour de la date de l'identité.
       *
       * `passagesAround` dit la même chose et se teste sans base ; la borne est
       * répétée ici parce qu'elle ne coûte pas la même chose des deux côtés.
       * Lire toute la bibliothèque pour n'en garder que cinq chapitres est une
       * requête de plusieurs milliers de lignes par identité, et il y en a
       * autant que d'identités.
       */
      const rows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT c.number, t.text,
                 row_number() OVER (PARTITION BY c.id ORDER BY t.reading_order) AS position
            FROM text_blocks t
            JOIN chapters c ON c.id = t.chapter_id
           WHERE c.user_id = ${userId} AND c.work_id = ${workId}
             AND c.status = 'published'
             AND c.number >= ${identity.chapter - IDENTITY_WINDOW}
             AND c.number <= ${identity.chapter + IDENTITY_WINDOW}
           ORDER BY c.number, t.reading_order
           LIMIT ${PASSAGES_PER_CHAPTER + 1}
        `),
      )) as unknown as Array<{ number: number; text: string; position: number }>

      const near = passagesAround(
        rows.map((row) => ({
          id: `${row.number}:b${row.position}`,
          chapter: Number(row.number),
          text: row.text,
        })),
        identity.chapter,
      )

      return {
        identity,
        passages: near.slice(0, PASSAGES_PER_CHAPTER),
        cut: near.length > PASSAGES_PER_CHAPTER,
      }
    },
    inputs: (material) =>
      identityInputs(
        material.identity,
        material.passages.map((passage) => passage.text),
      ),
    truncated: (material) => material.cut,
    async read(material) {
      if (material.passages.length === 0) {
        return { findings: [], costCents: 0, modelId: null }
      }

      const attempt = await askWithRetry({
        question: identityQuestion(material.identity),
        context: [
          ...sideStatements(material.identity),
          ...material.passages.map((passage) => ({
            assertionId: passage.id,
            chapter: passage.chapter,
            statement: passage.text,
            excerpt: null,
          })),
        ],
        boundaryChapter: material.identity.chapter + 2,
      })

      if ('reason' in attempt) return attempt
      const answer = attempt.answer
      const read = answer.refusal ? null : answer.value

      const findings = (
        read ? parseIdentityVerdicts(read.answer, [material.identity.assertionId]) : []
      )
        .map((row) =>
          identityVerdictFinding({
            row,
            identity: material.identity,
            passages: material.passages.map((passage) => passage.text),
          }),
        )
        .filter((finding): finding is AuditFinding => finding !== null)

      return { findings, costCents: answer.usage.costCents, modelId: answer.usage.modelId }
    },
  }
}

/** Ce que le graphe dit des deux bouts, offert au modèle comme du contexte. */
function sideStatements(
  identity: IdentityUnderReview,
): Array<{ assertionId: string; chapter: number; statement: string; excerpt: string | null }> {
  const describe = (side: IdentitySide, which: string) => ({
    assertionId: side.entityId,
    chapter: side.firstSeenChapter,
    statement:
      `${which} : ${side.nodeType}, entré en scène au chapitre ${side.firstSeenChapter}, ` +
      `nommé ${side.names.map((name) => `« ${name.label} »`).join(', ')}` +
      (side.memberships.length > 0 ? ` ; ${side.memberships.join(' ; ')}` : ''),
    excerpt: null,
  })

  return [
    describe(identity.subject, 'premier nœud'),
    describe(identity.object, 'second nœud'),
  ]
}

/* ------------------------------------------------------------------------- */
/* Chercher les identités que le texte révèle et que le graphe ignore.        */
/* ------------------------------------------------------------------------- */

interface GapMaterial {
  chapter: number
  passages: GapPassage[]
  candidates: GapCandidate[]
  joined: Set<string>
  cut: boolean
}

function gapAnalyzer(_userId: string, _workId: string): Analyzer<GapMaterial> {
  return {
    analysis: 'identites_manquantes',
    subjectKind: 'chapter',
    subjects: publishedChapters,
    async material(userId, workId, subject) {
      const chapter = Number(subject)

      const passageRows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT t.text,
                 row_number() OVER (ORDER BY t.reading_order) AS position
            FROM text_blocks t
            JOIN chapters c ON c.id = t.chapter_id
           WHERE c.user_id = ${userId} AND c.work_id = ${workId}
             AND c.number = ${chapter} AND c.status = 'published'
           ORDER BY t.reading_order
           LIMIT ${PASSAGES_PER_CHAPTER + 1}
        `),
      )) as unknown as Array<{ text: string; position: number }>

      if (passageRows.length === 0) return null

      /*
       * Qui ce chapitre met en scène, et personne d'autre.
       *
       * Les occurrences sont ce que le pipeline a écrit de « qui apparaît ou
       * est mentionné ici » : c'est la bonne borne, et la seule qui tienne à
       * l'échelle. Sans elle, une bibliothèque de trois mille fiches en
       * enverrait trois mille à chaque chapitre, ce qui coûte davantage que ce
       * que la lecture rapporte et noie la question.
       */
      const candidateRows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT DISTINCT ON (en.id)
                 en.id, en.node_type, en.first_seen_chapter,
                 l.label, l.revealed_in_chapter
            FROM occurrences o
            JOIN entities en ON en.id = o.entity_id
            JOIN entity_labels l ON l.entity_id = en.id
           WHERE o.user_id = ${userId}
             AND o.chapter_number = ${chapter}
             AND en.work_id = ${workId}
             AND en.review_status = 'accepted'
             AND en.node_type IN ('character', 'group')
           ORDER BY en.id, l.precedence DESC, l.revealed_in_chapter DESC
           LIMIT ${CANDIDATES_PER_CHAPTER}
        `),
      )) as unknown as Array<{
        id: string
        node_type: string
        first_seen_chapter: number
        label: string
        revealed_in_chapter: number | null
      }>

      const joinedRows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT subject_entity_id, object_entity_id
            FROM assertions
           WHERE user_id = ${userId} AND work_id = ${workId}
             AND predicate = 'same_as' AND review_status = 'accepted'
             AND object_entity_id IS NOT NULL
        `),
      )) as unknown as Array<{ subject_entity_id: string; object_entity_id: string }>

      return {
        chapter,
        passages: passageRows.slice(0, PASSAGES_PER_CHAPTER).map((row) => ({
          id: `b${row.position}`,
          ref: `b${row.position}`,
          chapter,
          text: row.text,
        })),
        candidates: candidateRows.map((row) => ({
          entityId: row.id,
          label: row.label,
          nodeType: row.node_type,
          firstSeenChapter: Number(row.first_seen_chapter),
          revealedInChapter:
            row.revealed_in_chapter === null ? null : Number(row.revealed_in_chapter),
        })),
        joined: new Set(
          joinedRows.map((row) =>
            [row.subject_entity_id, row.object_entity_id].sort().join('|'),
          ),
        ),
        cut: passageRows.length > PASSAGES_PER_CHAPTER,
      }
    },
    inputs: (material) => gapInputs(material.passages, material.candidates),
    truncated: (material) => material.cut,
    async read(material) {
      if (material.candidates.length < 2) {
        return { findings: [], costCents: 0, modelId: null }
      }

      const attempt = await askWithRetry({
        question: gapQuestion(material.chapter),
        context: [
          ...material.candidates.map((candidate) => ({
            assertionId: candidate.entityId,
            chapter: candidate.firstSeenChapter,
            statement: `fiche : « ${candidate.label} » (${candidate.nodeType})`,
            excerpt: null,
          })),
          ...material.passages.map((passage) => ({
            assertionId: passage.id,
            chapter: passage.chapter,
            statement: passage.text,
            excerpt: null,
          })),
        ],
        boundaryChapter: material.chapter,
      })

      if ('reason' in attempt) return attempt
      const answer = attempt.answer
      const read = answer.refusal ? null : answer.value

      const findings = (
        read
          ? parseIdentityGaps(
              read.answer,
              material.candidates.map((candidate) => candidate.entityId),
              material.passages.map((passage) => passage.id),
            )
          : []
      )
        .map(
          (row) =>
            identityGapFinding({
              row,
              candidates: material.candidates,
              passages: material.passages,
              joined: material.joined,
            })?.finding ?? null,
        )
        .filter((finding): finding is AuditFinding => finding !== null)

      return { findings, costCents: answer.usage.costCents, modelId: answer.usage.modelId }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Dater la réponse d'une question, sur toute l'histoire.                     */
/* ------------------------------------------------------------------------- */

interface MysteryMaterial {
  mystery: MysteryUnderReview
  scenes: Scene[]
  boundary: number
  dropped: number
}

function mysteryAnalyzer(_userId: string, _workId: string): Analyzer<MysteryMaterial> {
  return {
    analysis: 'mysteres',
    subjectKind: 'mystery',
    /*
     * Toutes les questions, refermées comprises.
     *
     * `mystery-closing.ts` ne regarde que les ouvertes, et c'est juste pour
     * lui : son travail est de refermer. Le nôtre est de vérifier la date, et
     * une question refermée quatre-vingts chapitres trop tard est refermée.
     */
    async subjects(userId, workId) {
      const rows = (await withIngest(async (db) =>
        db.execute(sql`
          SELECT m.entity_id, m.question, m.opened_in_chapter
            FROM mysteries m
            JOIN entities en ON en.id = m.entity_id
           WHERE m.user_id = ${userId} AND m.work_id = ${workId}
             AND en.review_status = 'accepted'
           ORDER BY m.opened_in_chapter, m.entity_id
        `),
      )) as unknown as Array<{
        entity_id: string
        question: string
        opened_in_chapter: number
      }>

      return rows.map((row) => ({
        id: row.entity_id,
        label: `« ${row.question} » (chapitre ${row.opened_in_chapter})`,
      }))
    },
    async material(userId, workId, subject) {
      return withIngest(async (db) => {
        const [row] = (await db.execute(sql`
          SELECT m.entity_id, m.question, m.opened_in_chapter, m.state::text AS state,
                 m.resolved_in_chapter
            FROM mysteries m
           WHERE m.entity_id = ${subject} AND m.user_id = ${userId}
           LIMIT 1
        `)) as unknown as Array<{
          entity_id: string
          question: string
          opened_in_chapter: number
          state: string
          resolved_in_chapter: number | null
        }>

        if (!row) return null

        const [boundaryRow] = (await db.execute(sql`
          SELECT COALESCE(max(number), 0) AS boundary
            FROM chapters
           WHERE user_id = ${userId} AND work_id = ${workId} AND status = 'published'
        `)) as unknown as Array<{ boundary: number }>

        const boundary = Number(boundaryRow?.boundary ?? 0)
        const opened = Number(row.opened_in_chapter)

        const resolutionRows = (await db.execute(sql`
          SELECT a.id, a.subject_entity_id,
                 COALESCE(e.shown_in_chapter, e.told_in_chapter, a.knowledge_from_chapter) AS chapter
            FROM assertions a
            LEFT JOIN events e ON e.entity_id = a.subject_entity_id
           WHERE a.user_id = ${userId} AND a.predicate = 'resolves_mystery'
             AND a.object_entity_id = ${subject} AND a.review_status = 'accepted'
        `)) as unknown as Array<{ id: string; subject_entity_id: string; chapter: number }>

        const sceneRows = (await db.execute(sql`
          SELECT e.entity_id, e.summary,
                 COALESCE(e.shown_in_chapter, e.told_in_chapter) AS chapter
            FROM events e
            JOIN entities en ON en.id = e.entity_id
           WHERE e.user_id = ${userId} AND e.work_id = ${workId}
             AND en.review_status = 'accepted'
             AND e.summary IS NOT NULL
             AND COALESCE(e.shown_in_chapter, e.told_in_chapter) > ${opened}
             AND COALESCE(e.shown_in_chapter, e.told_in_chapter) <= ${boundary}
           ORDER BY chapter
        `)) as unknown as Array<{ entity_id: string; summary: string; chapter: number }>

        return {
          mystery: {
            entityId: row.entity_id,
            question: row.question,
            openedInChapter: opened,
            state: row.state,
            resolvedInChapter:
              row.resolved_in_chapter === null ? null : Number(row.resolved_in_chapter),
            resolutions: resolutionRows.map((resolution) => ({
              assertionId: resolution.id,
              sceneEntityId: resolution.subject_entity_id,
              chapter: Number(resolution.chapter),
            })),
          },
          scenes: sceneRows.map((scene) => ({
            entityId: scene.entity_id,
            chapter: Number(scene.chapter),
            summary: scene.summary,
          })),
          boundary,
          dropped: 0,
        }
      })
    },
    inputs: (material) => mysteryInputs(material.mystery, material.scenes),
    truncated: (material) => material.dropped > 0,
    async read(material) {
      const { passes, dropped } = scenePasses(material.scenes)
      material.dropped = dropped

      if (passes.length === 0) return { findings: [], costCents: 0, modelId: null }

      let modelId: string | null = null
      let failure: string | null = null

      const scan = await scanForResolution(
        passes,
        material.mystery.openedInChapter,
        async (window) => {
          const attempt = await askWithRetry({
            question: resolutionQuestion(
              material.mystery.question,
              material.mystery.openedInChapter,
            ),
            context: window.map((scene) => ({
              assertionId: scene.entityId,
              chapter: scene.chapter,
              statement: scene.summary,
              excerpt: null,
            })),
            boundaryChapter: material.boundary,
          })

          if ('reason' in attempt) {
            failure = attempt.reason
            return { refusal: true, answer: { insufficientData: true, citations: [] }, costCents: 0 }
          }

          const result = attempt.answer
          modelId = result.usage.modelId

          return {
            refusal: Boolean(result.refusal),
            answer: result.refusal
              ? { insufficientData: true, citations: [] }
              : {
                  insufficientData: result.value.insufficient_data,
                  citations: result.value.citations.map((citation) => ({
                    assertionId: citation.assertion_id,
                    chapter: citation.chapter,
                  })),
                },
            costCents: result.usage.costCents,
          }
        },
      )

      if (failure !== null && scan.resolution === null) return { reason: failure }

      return {
        findings: mysteryFindings({ mystery: material.mystery, answering: scan.scene }),
        costCents: scan.costCents,
        modelId,
      }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Ce que plusieurs analyses lisent de la même façon.                         */
/* ------------------------------------------------------------------------- */

async function publishedChapters(
  userId: string,
  workId: string,
): Promise<Array<{ id: string; label: string }>> {
  const rows = (await withIngest(async (db) =>
    db.execute(sql`
      SELECT c.number
        FROM chapters c
       WHERE c.user_id = ${userId} AND c.work_id = ${workId} AND c.status = 'published'
       ORDER BY c.number
    `),
  )) as unknown as Array<{ number: number }>

  return rows.map((row) => ({ id: String(row.number), label: `chapitre ${row.number}` }))
}

async function chapterMaterial(
  userId: string,
  workId: string,
  subject: string,
): Promise<ChapterMaterial | null> {
  const chapter = Number(subject)
  if (!Number.isFinite(chapter)) return null

  return withIngest(async (db) => {
    const sceneRows = (await db.execute(sql`
      SELECT e.entity_id, e.summary
        FROM events e
        JOIN entities en ON en.id = e.entity_id
       WHERE e.user_id = ${userId} AND e.work_id = ${workId}
         AND en.review_status = 'accepted'
         AND e.summary IS NOT NULL
         AND COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}
       ORDER BY e.created_at
       LIMIT ${SCENES_PER_CHAPTER}
    `)) as unknown as Array<{ entity_id: string; summary: string }>

    const passageRows = (await db.execute(sql`
      SELECT t.text
        FROM text_blocks t
        JOIN chapters c ON c.id = t.chapter_id
       WHERE c.user_id = ${userId} AND c.work_id = ${workId}
         AND c.number = ${chapter} AND c.status = 'published'
       ORDER BY t.reading_order
       LIMIT ${PASSAGES_PER_CHAPTER + 1}
    `)) as unknown as Array<{ text: string }>

    return {
      chapter,
      scenes: sceneRows.map((row) => ({ entityId: row.entity_id, summary: row.summary })),
      passages: passageRows.slice(0, PASSAGES_PER_CHAPTER).map((row) => row.text),
      cut: passageRows.length > PASSAGES_PER_CHAPTER,
    }
  })
}

/** Une identité acceptée, avec ses deux bouts et ce qui les entoure. */
async function identityUnderReview(
  userId: string,
  workId: string,
  assertionId: string,
): Promise<IdentityUnderReview | null> {
  return withIngest(async (db) => {
    const [row] = (await db.execute(sql`
      SELECT a.id, a.subject_entity_id, a.object_entity_id, a.knowledge_from_chapter,
             (SELECT ev.excerpt FROM evidence ev
               WHERE ev.assertion_id = a.id AND ev.excerpt IS NOT NULL
               ORDER BY length(ev.excerpt) DESC LIMIT 1) AS excerpt
        FROM assertions a
       WHERE a.id = ${assertionId} AND a.user_id = ${userId} AND a.work_id = ${workId}
         AND a.predicate = 'same_as' AND a.review_status = 'accepted'
         AND a.object_entity_id IS NOT NULL
       LIMIT 1
    `)) as unknown as Array<{
      id: string
      subject_entity_id: string
      object_entity_id: string
      knowledge_from_chapter: number
      excerpt: string | null
    }>

    if (!row) return null

    const sides = new Map<string, IdentitySide>()

    for (const entityId of [row.subject_entity_id, row.object_entity_id]) {
      const [entity] = (await db.execute(sql`
        SELECT en.id, en.node_type, en.first_seen_chapter
          FROM entities en
         WHERE en.id = ${entityId} AND en.user_id = ${userId}
         LIMIT 1
      `)) as unknown as Array<{ id: string; node_type: string; first_seen_chapter: number }>

      if (!entity) return null

      const labelRows = (await db.execute(sql`
        SELECT l.label, l.revealed_in_chapter
          FROM entity_labels l
         WHERE l.entity_id = ${entityId} AND l.user_id = ${userId}
         ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
      `)) as unknown as Array<{ label: string; revealed_in_chapter: number | null }>

      const membershipRows = (await db.execute(sql`
        SELECT a.predicate,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = a.object_entity_id
                 ORDER BY l.precedence DESC LIMIT 1) AS label
          FROM assertions a
         WHERE a.user_id = ${userId} AND a.subject_entity_id = ${entityId}
           AND a.review_status = 'accepted'
           AND a.object_entity_id IS NOT NULL
           AND a.predicate IN ('member_of', 'secretly_member_of', 'part_of',
                               'part_of_place', 'captain_of', 'leads')
      `)) as unknown as Array<{ predicate: string; label: string | null }>

      sides.set(entityId, {
        entityId,
        nodeType: entity.node_type,
        firstSeenChapter: Number(entity.first_seen_chapter),
        names: labelRows.map((label) => ({
          label: label.label,
          revealedInChapter:
            label.revealed_in_chapter === null ? null : Number(label.revealed_in_chapter),
        })),
        memberships: membershipRows
          .filter((membership) => membership.label !== null)
          .map((membership) => `${membership.predicate} « ${membership.label} »`),
      })
    }

    return {
      assertionId: row.id,
      chapter: Number(row.knowledge_from_chapter),
      subject: sides.get(row.subject_entity_id)!,
      object: sides.get(row.object_entity_id)!,
      excerpt: row.excerpt,
    }
  })
}
