import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { PageTitle } from '@/app/ui/page-title.tsx'
import { auditState, openFindings, type AuditState } from '@/domains/review/audit-run.ts'
import { AUDIT_KIND_LABELS, type AuditKind } from '@/domains/review/audit.ts'
import { ANALYSIS_LABELS, type AnalysisKind } from '@/domains/review/analyses.ts'
import { FindingsBoard } from './findings-board.tsx'
import { Lecture, type LectureStep } from './lecture.tsx'
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
 * Quatre panneaux, et la séparation est celle de la dépense :
 *
 *   **Règles gratuites** — tout ce qui se déduit de la bibliothèque elle-même.
 *   Un clic, aucun appel, relançable autant qu'on veut.
 *
 *   **Vérifier les scènes**, **les identités**, **les mystères** — trois
 *   lectures payées au sujet. Chacune dit ce qu'il lui reste à lire et ce
 *   qu'elle a déjà coûté, et aucune ne part du bouton « Analyser l'histoire ».
 *
 * Les constats sont groupés par famille et non par chapitre. Les défauts
 * arrivent par familles — quarante scènes racontées deux fois, six noms
 * affichés trop tôt — et une même décision se prend quarante fois d'affilée :
 * c'est le seul ordre où l'on peut la prendre une fois. Le numéro de chapitre
 * reste sur chaque ligne, qui est là où on en a besoin.
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
    analysis: findings.find((finding) => finding.kind === kind)?.analysis ?? 'regles',
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
        révélations racontées à l’envers, identités qu’aucune œuvre ne peut
        produire, questions dont la date ne suit pas leurs relations. Ce
        qu’elles ne peuvent pas voir — une phrase simplement fausse, une
        identité qui n’en est pas une, une réponse publiée depuis longtemps —
        demande de lire, et c’est ce que font les trois panneaux suivants, un
        appel à la fois.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['À trancher', state.open, state.open > 0 ? 'bg-accent' : ''],
          ['Corrigés', state.applied, ''],
          ['Écartés', state.ignored, ''],
          ['Dépensé', `${(state.costCents / 100).toFixed(2)} $`, ''],
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

      <Lecture
        title="Vérifier les scènes"
        explain="Chapitre par chapitre, le modèle compare ce que la bibliothèque raconte au texte du chapitre, et ne signale que ce que ce texte contredit — en recopiant la phrase qui le prouve. Il départage ensuite les scènes que la règle gratuite trouve proches sans oser les replier, et signale celles qu’un chapitre importé en résumé présente comme se passant en couverture. Il ne lui est jamais demandé ce qu’il sait de la suite : une correction tirée d’un chapitre ultérieur serait un spoiler écrit dans le fil."
        steps={[
          step(state, 'scenes', state.chapters),
          step(state, 'doublons', state.chapters),
          step(state, 'provenance', state.chapters),
        ]}
      />

      <Lecture
        title="Vérifier les identités"
        explain="Chaque identité déjà acceptée est relue contre les passages de son chapitre, et le modèle doit dire ce qu’elle est vraiment : la même chose sous deux noms, un groupe et l’un de ses membres, une fusion, un déguisement, un leurre, ou une question et sa réponse. Il cherche ensuite l’inverse — les révélations que le texte fait et que le graphe n’a jamais écrites. Aucune identité n’est publiée d’ici : ce qui est trouvé devient une carte du centre de revue, que vous acceptez ou non."
        steps={[
          step(state, 'identites', state.identities),
          step(state, 'identites_manquantes', state.chapters),
        ]}
      />

      <Lecture
        title="Vérifier les mystères"
        explain="Pour chaque question, le modèle lit les scènes publiées qui la suivent et désigne celle qui y répond vraiment — il cite une scène, jamais un numéro de chapitre, que le code relit dans le graphe. Ce qui est comparé est la date : une question laissée ouverte alors que la réponse est publiée, une réponse datée trop tard, une réponse rattachée à une scène qui la redit plutôt qu’à celle qui la donne."
        steps={[step(state, 'mysteres', state.mysteries)]}
      />

      {findings.length === 0 ? (
        <section className="panneau mt-8">
          <h2 className="panneau-titre panneau-titre-vedette">Rien à signaler</h2>
          <div className="panneau-corps">
            <p className="text-secondary">
              Aucune règle ne trouve à redire sur la bibliothèque telle qu’elle
              est. Ce n’est pas la même chose que «&nbsp;tout est juste&nbsp;»
              : une phrase fausse mais bien datée passe les règles sans les
              émouvoir, et seules les lectures ci-dessus la voient.
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
              origin={
                ANALYSIS_LABELS[family.analysis as AnalysisKind] ?? family.analysis
              }
              findings={family.findings}
            />
          ))}
        </div>
      )}

      <p className="mt-10 text-sm text-muted">
        Rien n’est jamais supprimé ici. Un doublon corrigé passe en
        «&nbsp;rejeté&nbsp;» et sort du fil&nbsp;; la fiche reste, datée, avec sa
        provenance, et se rouvre en une requête. Une identité fausse passe à
        «&nbsp;rejetée&nbsp;», jamais effacée, et l’état d’une question est
        toujours recalculé depuis ses relations acceptées plutôt que posé à la
        main. Les corrections qui demandent un jugement — fusionner deux fiches,
        réécrire un fait — se prennent sur la{' '}
        <Link href="/graph/table" className="text-primary hover:underline">
          fiche concernée
        </Link>
        , devant ce qu’elle porte.
      </p>
    </main>
  )
}

/** Ce qu'une analyse a déjà fait, tel que son panneau l'affiche. */
function step(state: AuditState, analysis: AnalysisKind, total: number): LectureStep {
  const done = state.analyses.find((row) => row.analysis === analysis)

  return {
    analysis,
    label: ANALYSIS_LABELS[analysis],
    total,
    read: done?.read ?? 0,
    failed: done?.failed ?? 0,
    costCents: done?.costCents ?? 0,
  }
}
