import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { PageTitle } from '@/app/ui/page-title.tsx'
import { auditState, openFindings } from '@/domains/review/audit-run.ts'
import { AUDIT_KIND_LABELS, type AuditKind } from '@/domains/review/audit.ts'
import { FindingsBoard } from './findings-board.tsx'
import { Relecture } from './relecture.tsx'
import { Sweep } from './sweep.tsx'

export const metadata: Metadata = { title: 'Analyse de l’histoire' }
export const dynamic = 'force-dynamic'

/**
 * Ce que la relecture de toute l'histoire a trouvé.
 *
 * Une page plutôt qu'un rapport dans une console, parce qu'un constat sans le
 * geste qui le règle est une liste de reproches. Chaque ligne porte donc ce
 * qu'elle propose d'écrire, en toutes lettres, et deux boutons : corriger, ou
 * écarter pour de bon.
 *
 * Groupée par famille et non par chapitre. Les défauts arrivent par familles —
 * quarante scènes racontées deux fois, six noms affichés trop tôt — et une même
 * décision se prend quarante fois d'affilée : c'est le seul ordre où l'on peut
 * la prendre une fois. Le numéro de chapitre reste sur chaque ligne, qui est là
 * où on en a besoin.
 */
export default async function AnalysePage() {
  const session = await getReaderSession()

  const [state, findings] = await Promise.all([
    auditState(session.userId, session.workId),
    openFindings(session.userId, session.workId),
  ])

  const families = [...new Set(findings.map((finding) => finding.kind))].map((kind) => ({
    kind,
    label: AUDIT_KIND_LABELS[kind as AuditKind] ?? kind,
    findings: findings.filter((finding) => finding.kind === kind),
  }))

  return (
    <main id="contenu" className="mx-auto max-w-5xl px-5 py-8">
      <PageTitle
        title="Analyse de l’histoire"
        back={{ href: '/admin/chapitres', label: 'Chapitres' }}
        action={<Sweep />}
      />

      <p className="mt-4 max-w-2xl text-sm text-secondary">
        Les règles relisent toute la bibliothèque d’un coup et sans rien
        facturer&nbsp;: doublons, noms affichés avant le chapitre qui les écrit,
        révélations racontées à l’envers, entrées en scène trop tardives. Ce
        qu’elles ne peuvent pas voir — une phrase simplement fausse — demande de
        relire les chapitres, et c’est le second panneau.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['À trancher', state.open, state.open > 0 ? 'bg-accent' : ''],
          ['Corrigés', state.applied, ''],
          ['Écartés', state.ignored, ''],
          ['Chapitres relus', `${state.read}/${state.chapters}`, ''],
        ].map(([label, value, tint]) => (
          <div
            key={String(label)}
            className={`border-[3px] border-ink px-3 py-2 ${tint || 'bg-surface-raised'}`}
            style={{ boxShadow: 'var(--shadow-hard-sm)' }}
          >
            <p className="cartouche">{label}</p>
            <p className="chiffre chiffre-l mt-1">{value}</p>
          </div>
        ))}
      </div>

      <Relecture
        read={state.read}
        chapters={state.chapters}
        costCents={state.costCents}
      />

      {findings.length === 0 ? (
        <section className="panneau mt-8">
          <h2 className="panneau-titre panneau-titre-vedette">Rien à signaler</h2>
          <div className="panneau-corps">
            <p className="text-secondary">
              Aucune règle ne trouve à redire sur la bibliothèque telle qu’elle
              est. Ce n’est pas la même chose que «&nbsp;tout est juste&nbsp;»
              : une phrase fausse mais bien datée passe les règles sans les
              émouvoir, et seule la relecture la voit.
            </p>
            <p className="mt-3 text-sm text-muted">
              Relancez l’analyse après chaque import&nbsp;: les défauts qui
              n’existent qu’entre deux chapitres apparaissent quand le second
              arrive.
            </p>
          </div>
        </section>
      ) : (
        <div className="mt-8 space-y-8">
          {/* Une liste tronquée qui le dit vaut mieux qu'une liste complète que
              personne ne fait défiler — et surtout mieux qu'une troncature
              silencieuse, qui se lit comme « il n'y avait que ça ». */}
          {state.open > findings.length && (
            <p className="text-sm text-muted">
              {findings.length} constats affichés sur {state.open}. Corrigez ou
              écartez ceux-ci&nbsp;: les suivants apparaîtront.
            </p>
          )}
          {families.map((family) => (
            <FindingsBoard
              key={family.kind}
              title={family.label}
              findings={family.findings}
            />
          ))}
        </div>
      )}

      <p className="mt-10 text-sm text-muted">
        Rien n’est jamais supprimé ici. Un doublon corrigé passe en
        «&nbsp;rejeté&nbsp;» et sort du fil&nbsp;; la fiche reste, datée, avec sa
        provenance, et se rouvre en une requête. Les corrections qui demandent un
        jugement — fusionner deux fiches, réécrire un fait — se prennent sur la{' '}
        <Link href="/graph/table" className="text-primary hover:underline">
          fiche concernée
        </Link>
        , devant ce qu’elle porte.
      </p>
    </main>
  )
}
