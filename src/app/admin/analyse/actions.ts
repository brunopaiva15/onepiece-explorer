'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { consume } from '@/domains/observability/rate-limit.ts'
import {
  applyFinding,
  forgetPasses,
  ignoreFinding,
  knownAnalysis,
  sweepStory,
  type SweepReport,
} from '@/domains/review/audit-run.ts'
import { readWithModel, type AnalysisReport } from '@/domains/review/audit-passes.ts'

/**
 * Ce que la page d'analyse a le droit de demander au serveur.
 *
 * Chaque action revérifie qui appelle. Une action de serveur est une route POST
 * atteignable sans passer par le bouton qui l'a offerte, et l'identifiant d'un
 * constat qui arrive du navigateur ne prouve rien — c'est `applyFinding` qui
 * relit le constat en base, et `requireOwner` qui dit à qui il appartient.
 *
 * Le nom d'une analyse arrive lui aussi du navigateur, et subit le même
 * traitement : il est cherché dans la table des analyses connues, jamais
 * interpolé. Ce qui n'y est pas est refusé.
 */

export interface SweepActionResult {
  ok: boolean
  report?: SweepReport
  error?: string
}

/**
 * Passer toute la bibliothèque sous les règles.
 *
 * Sans limite de débit, à la différence des lectures : aucune ligne ne quitte
 * la machine, rien n'est facturé, et le seul coût est quelques requêtes sur la
 * base du lecteur. Un bouton qu'on peut cliquer deux fois de suite est ce qu'il
 * faut ici — on corrige, on relance, et la liste raccourcit.
 *
 * C'est aussi pourquoi « Analyser l'histoire » ne déclenche que celui-ci :
 * aucun crédit de modèle n'est dépensé au clic, jamais. Les lectures payantes
 * ont leurs propres boutons, qui disent ce qu'elles vont lire.
 */
export async function sweepStoryAction(): Promise<SweepActionResult> {
  try {
    const session = await requireOwner()
    const report = await sweepStory(session.userId, session.workId)

    revalidatePath('/admin/analyse')
    revalidatePath('/admin/chapitres')

    return { ok: true, report }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Analyse impossible.',
    }
  }
}

export interface FindingActionResult {
  ok: boolean
  message?: string
  error?: string
}

export async function applyFindingAction(findingId: string): Promise<FindingActionResult> {
  try {
    const session = await requireOwner()
    const result = await applyFinding(session.userId, findingId)

    if (result.ok) {
      // Une correction touche le fil, le graphe et les fiches : tout ce qui lit
      // la connaissance doit être refait, pas seulement cette page.
      revalidatePath('/admin/analyse')
      revalidatePath('/histoire')
      revalidatePath('/graph')
      revalidatePath('/chronologie')
      revalidatePath('/mysteres')
    }

    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.message }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Correction impossible.',
    }
  }
}

export async function ignoreFindingAction(findingId: string): Promise<FindingActionResult> {
  try {
    const session = await requireOwner()
    const done = await ignoreFinding(session.userId, findingId)
    if (done) revalidatePath('/admin/analyse')
    return done
      ? { ok: true, message: 'Écarté. Un prochain balayage ne le reproposera pas.' }
      : { ok: false, error: 'Constat introuvable ou déjà tranché.' }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Impossible d’écarter ce constat.',
    }
  }
}

export interface AnalyseActionResult {
  ok: boolean
  report?: AnalysisReport
  error?: string
}

/**
 * Combien de sujets une seule demande lit.
 *
 * Un appel par sujet, et une action de serveur a un plafond de durée : au-delà
 * d'une poignée, la réponse meurt en emportant les appels déjà payés. Le
 * navigateur redemande, ce qui est aussi ce qui rend la progression visible et
 * l'arrêt possible entre deux paquets.
 */
const MAX_BATCH = 8

/** Et combien de sujets ratés une passe peut mettre de côté avant de renoncer. */
const MAX_SKIPPED = 500

/**
 * Lire un paquet de sujets, pour une analyse.
 *
 * Limitée sous « ask » parce que c'est la même dépense : une question posée à
 * un modèle avec un contexte. Comptée par demande et non par sujet — un paquet
 * est un geste, et ce que la limite doit arrêter est une boucle, pas une
 * lecture qui avance.
 */
export async function analyserAction(
  analysis: string,
  batch = 4,
  /** Les sujets que cette passe a déjà ratés. Voir `readWithModel`. */
  skip: string[] = [],
): Promise<AnalyseActionResult> {
  try {
    const session = await requireOwner()

    const kind = knownAnalysis(analysis)
    if (kind === null || kind === 'regles') {
      return { ok: false, error: 'Analyse inconnue.' }
    }

    const allowance = await consume(session.userId, 'ask')
    if (!allowance.allowed) {
      return {
        ok: false,
        error:
          `Limite atteinte. Réessayez dans ${allowance.retryInMinutes} minute(s). ` +
          allowance.explain,
      }
    }

    const size = Number.isFinite(batch) ? Math.min(MAX_BATCH, Math.max(1, Math.floor(batch))) : 4

    /*
     * Les arguments viennent du navigateur, y compris celui-ci.
     *
     * Il ne sert qu'à *retirer* des sujets de la passe, donc le pire qu'une
     * valeur inventée puisse faire est d'en sauter — pas d'en lire un qui ne
     * serait pas à lire. Il est quand même filtré et borné : un tableau de
     * cinquante mille entrées traverserait le réseau et finirait dans un `IN`.
     */
    const setAside = (Array.isArray(skip) ? skip : [])
      .filter((subject) => typeof subject === 'string' && subject.length > 0 && subject.length <= 64)
      .slice(0, MAX_SKIPPED)

    const report = await readWithModel(session.userId, session.workId, kind, size, setAside)

    if (report.found > 0 || report.read > 0) revalidatePath('/admin/analyse')

    return report.error ? { ok: false, error: report.error } : { ok: true, report }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Lecture impossible.',
    }
  }
}

export interface ForgetActionResult {
  ok: boolean
  forgotten?: number
  error?: string
}

/**
 * Tout relire à nouveau — et donc tout repayer —, une analyse à la fois.
 *
 * Le seul geste qui efface ce qui a été lu. Borné à une analyse : vouloir
 * relire les questions n'est pas vouloir repayer cent cinquante chapitres.
 */
export async function forgetPassesAction(analysis: string): Promise<ForgetActionResult> {
  try {
    const session = await requireOwner()

    const kind = knownAnalysis(analysis)
    if (kind === null || kind === 'regles') return { ok: false, error: 'Analyse inconnue.' }

    const forgotten = await forgetPasses(session.userId, session.workId, kind)
    revalidatePath('/admin/analyse')
    return { ok: true, forgotten }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Remise à zéro impossible.',
    }
  }
}
