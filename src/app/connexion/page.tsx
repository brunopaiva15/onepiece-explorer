import type { Metadata } from 'next'
import { SignInForm } from './sign-in-form.tsx'

export const metadata: Metadata = { title: 'Connexion' }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ suite?: string }>
}) {
  const { suite } = await searchParams
  const configured =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  return (
    <main id="contenu" className="mx-auto max-w-md px-5 py-14">
      {/* Framed rather than floating. The form used to sit alone in the middle
          of an empty page, which is what a sign-in screen looks like when
          nobody decided anything about it. */}
      <section className="panneau">
        <h1 className="panneau-titre !text-lg">Entrer dans le journal</h1>
        <div className="panneau-corps">
          <p className="text-secondary">
            Cette bibliothèque est privée. Connectez-vous pour y accéder.
          </p>

          {configured ? (
            <SignInForm redirectTo={suite ?? '/'} />
          ) : (
            <div className="mt-5 border border-line-strong bg-surface-sunken p-4 text-sm">
              <p className="font-medium text-primary">Supabase n&apos;est pas configuré</p>
              <p className="mt-2 text-secondary">
                Copiez <code className="font-mono text-xs">.env.example</code> vers{' '}
                <code className="font-mono text-xs">.env.local</code> et renseignez{' '}
                <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> et{' '}
                <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
                puis appliquez le schéma avec{' '}
                <code className="font-mono text-xs">pnpm db:push</code>.
              </p>
            </div>
          )}
        </div>
      </section>

      <p className="mt-5 text-center text-xs text-muted">
        Aucun chapitre n&apos;est téléchargé ni récupéré en ligne : vous importez
        des fichiers que vous possédez déjà.
      </p>
    </main>
  )
}
