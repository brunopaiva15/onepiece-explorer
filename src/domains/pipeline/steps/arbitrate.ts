import 'server-only'
import { arbitrateNote, arbitrateRun } from '@/domains/review/arbitrate.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * La seconde lecture, avant la vôtre.
 *
 * L'extraction propose, la passe automatique tranche ce dont aucun nom ne
 * dépend, et ce qui reste vous attendait. Cette étape est ce qui vient
 * s'intercaler : un autre modèle, la page du chapitre sur le Fandom en anglais
 * et en français, et un verdict par carte — accepter, rejeter, ou laisser au
 * lecteur. Ce qui remonte est ce qu'une page ne tranche pas, ce qui est
 * exactement la liste qu'on voulait garder.
 *
 * Avant `auto_publish` et non après, et l'ordre est ce qui fait tenir
 * l'ensemble : la publication automatique ouvre le chapitre quand il ne reste
 * rien à décider et enchaîne le suivant du lot. Placée après elle, cette passe
 * aurait tranché des cartes sur un chapitre déjà refermé, et le lot serait
 * resté arrêté sur des questions auxquelles il venait de répondre.
 *
 * Elle refuse de tourner sans un modèle qui lise vraiment, comme le balayage
 * des identités. Les modes synthétique et rejoué répondent en comparant des
 * mots : ils accepteraient des propositions avec l'aplomb d'une vraie lecture,
 * et — la raison qui décide — cette étape va chercher une page sur le réseau,
 * ce qu'une suite de tests hermétique ne fait pas. Ignorée dans ces modes, elle
 * ne change rien à ce que le reste du pipeline produit.
 */
export async function runArbitrate(context: StepContext): Promise<StepResult> {
  if (context.provider.name === 'synthetic' || context.provider.name === 'replay') {
    return {
      note:
        `Fournisseur « ${context.provider.name} » : il compare des mots, il ne lit ` +
        'pas la page du wiki. Les propositions restent en file.',
      status: 'skipped',
    }
  }

  const outcome = await arbitrateRun({
    userId: context.userId,
    runId: context.runId,
    chapterNumber: context.chapterNumber,
    provider: context.provider,
  })

  if (outcome.skipped !== null) {
    return { note: outcome.skipped, status: 'skipped' }
  }

  return {
    note: arbitrateNote(outcome),
    costCents: outcome.costCents,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    ...(outcome.modelId === null ? {} : { modelId: outcome.modelId }),
  }
}
