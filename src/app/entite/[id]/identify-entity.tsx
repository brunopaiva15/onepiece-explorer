'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { EntityCandidate } from '@/domains/knowledge/candidates.ts'
import type { IdentifyProposal } from '@/domains/knowledge/identify.ts'
import { nodeTypeLabel } from '@/domains/knowledge/predicate-label.ts'
import {
  factTargetsAction,
  identifyEntitiesAction,
  identityProposalAction,
} from './actions.ts'

/**
 * « C'est la même personne », dit depuis la fiche qui ne le sait pas encore.
 *
 * Le dernier recours, et il manquait. Le chapitre qui révèle propose lui-même
 * la relation et un humain la tranche au centre de revue : c'est le chemin
 * normal. Mais une révélation portée par une image, une phrase que l'extraction
 * a lue autrement, ou un chapitre publié avant que le prompt ne sache la
 * demander, laissait deux nœuds face à un lecteur qui savait, sans aucun geste
 * à lui offrir — « Silhouette au sommet » et Tony Tony Chopper, pour le reste
 * de l'œuvre.
 *
 * Trois choses que cette forme fait et qu'un select sur un fait ne ferait pas,
 * ce qui est la raison pour laquelle `correct-fact` refuse `same_as` et a
 * raison de le refuser :
 *
 *   Elle demande la date, qui est tout le contenu de l'opération. Fusionner
 *   sans date, ce serait renommer le personnage sur toute l'histoire ; datée,
 *   la fusion ne vaut qu'à partir du chapitre qui l'apprend.
 *
 *   Elle propose cette date sans la deviner. Le serveur cherche le premier
 *   chapitre dont une source écrit le nom — la question que `naming.ts` pose
 *   pour refuser un nom, posée ici pour en dater un. Quand aucune source ne
 *   l'écrit, le champ reste vide et le dit, plutôt que d'avancer un nombre
 *   qu'il n'a pas.
 *
 *   Elle dit ce que la fiche affichera de part et d'autre avant d'écrire quoi
 *   que ce soit. « À partir du 139 il s'appellera Tony Tony Chopper ; avant, il
 *   reste Silhouette au sommet » n'est pas quelque chose qu'on découvre après
 *   avoir cliqué.
 *
 * Rien n'est supprimé et les deux nœuds restent : la désignation provisoire est
 * ce que le lecteur savait, et la retirer effacerait l'état que la frontière
 * existe pour garder. La relation apparaît sur les deux fiches, et « ce fait
 * est faux » la défait.
 */

export function IdentifyEntity({
  entityId,
  displayLabel,
  nodeType,
  boundary,
}: {
  entityId: string
  displayLabel: string
  nodeType: string
  /** Ce que le lecteur a lu : on ne rapproche pas de ce qu'il ne connaît pas. */
  boundary: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /*
   * La liste et sa question, gardées ensemble.
   *
   * Une liste qui survivrait à la question qui l'a produite ferait cliquer sur
   * un résultat d'il y a deux frappes — c'est la précaution que `correct-fact`
   * prend déjà, pour la même raison.
   */
  const [results, setResults] = useState<{ query: string; items: EntityCandidate[] } | null>(
    null,
  )
  const [target, setTarget] = useState<EntityCandidate | null>(null)
  const [proposal, setProposal] = useState<IdentifyProposal | null>(null)
  const [chapter, setChapter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [searching, startSearch] = useTransition()
  const [asking, startAsking] = useTransition()
  const [writing, startWriting] = useTransition()

  const asked = query.trim()
  const candidates = results !== null && results.query === asked ? results.items : null

  useEffect(() => {
    if (!open || target !== null || asked.length < 2) return undefined

    const timer = setTimeout(() => {
      startSearch(async () => {
        const response = await factTargetsAction({
          query: asked,
          boundary,
          // Une identité relie deux choses du même genre. Le graphe l'accepte
          // entre types différents ; l'offrir ici inviterait à ranger un lieu
          // dans un personnage d'un seul clic.
          accepts: [nodeType],
          exclude: [entityId],
        })
        setResults({ query: asked, items: response.ok ? (response.candidates ?? []) : [] })
        if (!response.ok) setError(response.error ?? 'Recherche impossible.')
      })
    }, 300)

    return () => clearTimeout(timer)
  }, [asked, open, target, boundary, nodeType, entityId])

  function choose(candidate: EntityCandidate): void {
    setTarget(candidate)
    setError(null)
    setProposal(null)
    startAsking(async () => {
      const response = await identityProposalAction({
        entityId,
        otherId: candidate.entityId,
      })
      if (!response.ok || !response.proposal) {
        setError(response.error ?? 'Rapprochement impossible.')
        return
      }
      setProposal(response.proposal)
      setChapter(
        response.proposal.suggestedChapter === null
          ? ''
          : String(response.proposal.suggestedChapter),
      )
    })
  }

  function reset(): void {
    setQuery('')
    setResults(null)
    setTarget(null)
    setProposal(null)
    setChapter('')
    setError(null)
  }

  function submit(): void {
    if (!target) return
    const number = Number(chapter)
    if (!Number.isInteger(number) || number < 1) {
      setError('Indiquez le chapitre qui apprend cette identité.')
      return
    }
    setError(null)
    startWriting(async () => {
      const response = await identifyEntitiesAction({
        entityId,
        otherId: target.entityId,
        chapter: number,
      })
      if (!response.ok || !response.result) {
        setError(response.error ?? 'Rapprochement impossible.')
        return
      }
      setDone(
        `Rapprochés à partir du chapitre ${response.result.chapter}. ` +
          `Avant, les deux fiches restent distinctes.`,
      )
      reset()
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            setDone(null)
          }}
          className="bouton !py-1.5 !text-sm"
        >
          C&apos;est la même personne que…
        </button>
        {done && <p className="mt-2 text-sm text-[var(--epi-validated)]">{done}</p>}
      </div>
    )
  }

  /*
   * Qui l'emporte à l'affichage, dit avant l'écriture.
   *
   * La règle est celle de tout le reste — le nom le mieux classé de la
   * composante, à égalité le plus récemment révélé — mais elle est invisible
   * depuis cette page, et la phrase la rend lisible sans demander de la
   * connaître.
   */
  const after =
    proposal === null
      ? null
      : proposal.object.firstSeenChapter >= proposal.subject.firstSeenChapter
        ? proposal.object.label
        : proposal.subject.label

  return (
    <div className="w-full rounded-sm border border-line-strong bg-surface-raised p-4">
      <p className="font-medium text-primary">
        « {displayLabel} » est la même personne qu&apos;une autre fiche
      </p>
      <p className="mt-1 text-sm text-secondary">
        À utiliser quand un chapitre l&apos;apprend et que le graphe l&apos;a
        manqué. Les deux fiches restent&nbsp;: la fusion ne vaut qu&apos;à partir
        du chapitre que vous indiquez, et le curseur la défait en reculant.
      </p>

      {target === null ? (
        <div className="mt-3">
          <label className="block text-sm">
            <span className="font-medium text-primary">L&apos;autre fiche</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Chercher par son nom…"
              autoFocus
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-primary"
            />
          </label>
          <p className="mt-1 text-xs text-muted">
            Cherché parmi les {nodeTypeLabel(nodeType).toLowerCase()}s que vous avez
            lus jusqu&apos;au chapitre {boundary}.
          </p>

          {searching && <p className="mt-2 text-sm text-muted">Recherche…</p>}

          {!searching && candidates !== null && candidates.length === 0 && (
            <p className="mt-2 text-sm text-secondary">
              Aucune fiche de ce nom à ce chapitre.
            </p>
          )}

          {!searching && candidates !== null && candidates.length > 0 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {candidates.map((candidate) => (
                <li key={candidate.entityId}>
                  <button
                    type="button"
                    onClick={() => choose(candidate)}
                    className="w-full rounded-sm border border-line px-2 py-1 text-left text-sm text-primary hover:border-accent"
                  >
                    {candidate.label}
                    <span className="ml-2 font-mono text-xs text-muted">
                      {nodeTypeLabel(candidate.nodeType)}
                      {candidate.revealedInChapter !== null &&
                        ` · ch. ${candidate.revealedInChapter}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-primary">
            L&apos;autre fiche&nbsp;: <span className="font-medium">{target.label}</span>{' '}
            <button
              type="button"
              onClick={reset}
              className="underline decoration-dotted text-secondary"
            >
              en choisir une autre
            </button>
          </p>

          {asking && <p className="mt-2 text-sm text-muted">Lecture des sources…</p>}

          {proposal?.alreadyJoined != null && (
            <p className="mt-2 text-sm text-[var(--epi-hypothetical)]">
              Ces deux fiches sont déjà rejointes, au chapitre{' '}
              {proposal.alreadyJoined}.
            </p>
          )}

          {proposal && proposal.alreadyJoined === null && (
            <>
              <label className="mt-3 block text-sm">
                <span className="font-medium text-primary">
                  Le chapitre qui l&apos;apprend au lecteur
                </span>
                <input
                  type="number"
                  min={proposal.earliest}
                  value={chapter}
                  onChange={(event) => setChapter(event.target.value)}
                  className="mt-1.5 w-28 rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-primary"
                />
              </label>

              {/*
                D'où vient le nombre proposé, ou pourquoi il n'y en a pas. Une
                date avancée sans sa raison est une date qu'on accepte sans la
                lire, et c'est la seule valeur de ce formulaire qui puisse
                fabriquer un spoiler.
              */}
              <p className="mt-1 text-xs text-muted">
                {proposal.suggestedChapter !== null ? (
                  <>
                    Proposé&nbsp;: le premier chapitre dont une source écrit «&nbsp;
                    {proposal.suggestedFrom}&nbsp;». Corrigez-le si le lecteur
                    l&apos;apprend ailleurs.
                  </>
                ) : (
                  <>
                    Aucune source ne porte ce nom&nbsp;: la date est entièrement
                    la vôtre. Au plus tôt le chapitre {proposal.earliest}, où la
                    seconde fiche entre en scène.
                  </>
                )}
              </p>

              {chapter !== '' && after !== null && (
                <p className="mt-3 border-[3px] border-ink bg-[var(--epi-validated)] px-3 py-2 text-sm text-ink">
                  À partir du chapitre {chapter}, les deux fiches n&apos;en font
                  qu&apos;une, appelée «&nbsp;{after}&nbsp;». Avant, elles restent
                  deux, sous les noms qu&apos;elles portent aujourd&apos;hui.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={writing || asking || proposal === null || proposal.alreadyJoined !== null}
          className="bouton bouton-primaire !py-1.5 !text-sm disabled:opacity-50"
        >
          {writing ? 'Écriture…' : 'Rapprocher'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          className="bouton !py-1.5 !text-sm"
        >
          Annuler
        </button>
      </div>
    </div>
  )
}
