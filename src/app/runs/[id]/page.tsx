import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { getRun } from '@/domains/pipeline/runs.ts'
import { hasModelCredentials } from '@/lib/env.ts'
import { RunProgress } from './run-progress.tsx'

export const metadata: Metadata = { title: 'Progression du traitement' }
export const dynamic = 'force-dynamic'

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getReaderSession()

  const view = await getRun(session.userId, id)
  if (!view) notFound()

  const synthetic = view.run.provider === 'synthetic'

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-12">
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal
        </Link>
        <span className="text-muted">/</span>
        <Link href="/chapitres" className="text-muted hover:text-primary">
          Chapitres
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">
        Chapitre {view.run.chapterNumber}
      </h1>
      <p className="mt-3 text-secondary">
        Chaque étape est enregistrée avec sa durée, son coût réel et ses
        éventuelles tentatives. Rien n&apos;est publié automatiquement : un
        traitement réussi produit des propositions, jamais du canon.
      </p>

      {synthetic && !hasModelCredentials() && (
        <p
          role="note"
          className="mt-6 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-4 text-sm text-primary"
        >
          <strong className="font-medium">Aucune clé Anthropic configurée.</strong>{' '}
          Les étapes qui appellent un modèle sont désactivées. Le découpage en
          cases et le rattachement du texte, eux, sont déterministes et
          fonctionnent : ils ne dépendent d&apos;aucun modèle.
        </p>
      )}

      <RunProgress initial={serialisable(view)} />
    </main>
  )
}

/**
 * Dates cross to the client as strings anyway, and the SSE stream sends JSON.
 * Passing the same shape both ways means the client component never has to
 * handle two representations of the same field.
 */
function serialisable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
