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
    <main
      id="contenu"
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16"
    >
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
        Journal d&apos;exploration
      </p>
      <h1 className="mt-3 text-4xl font-semibold text-primary">
        One Piece Explorer
      </h1>
      <p className="mt-4 text-secondary">
        Votre biblioth&egrave;que est priv&eacute;e. Connectez-vous pour y
        acc&eacute;der.
      </p>

      {configured ? (
        <SignInForm redirectTo={suite ?? '/'} />
      ) : (
        <div className="mt-8 rounded-sm border border-line-strong bg-surface-raised p-5 text-sm">
          <p className="font-medium text-primary">Supabase n&apos;est pas configur&eacute;</p>
          <p className="mt-2 text-secondary">
            Copiez <code className="font-mono text-xs">.env.example</code> vers{' '}
            <code className="font-mono text-xs">.env.local</code> et renseignez{' '}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> et{' '}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
            puis appliquez le sch&eacute;ma avec{' '}
            <code className="font-mono text-xs">pnpm db:push</code>.
          </p>
        </div>
      )}
    </main>
  )
}
