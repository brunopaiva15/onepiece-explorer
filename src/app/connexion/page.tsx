import type { Metadata } from 'next'
import { getDict, getLocale } from '@/lib/i18n/server.ts'
import { SignInForm } from './sign-in-form.tsx'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.signin.metadataTitle }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ suite?: string }>
}) {
  const { suite } = await searchParams
  const locale = await getLocale()
  const t = (await getDict()).signin
  const configured =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  return (
    <main id="contenu" className="mx-auto max-w-md px-5 py-14">
      {/* Framed rather than floating. The form used to sit alone in the middle
          of an empty page, which is what a sign-in screen looks like when
          nobody decided anything about it. */}
      <section className="panneau">
        <h1 className="panneau-titre !text-lg">{t.heading}</h1>
        <div className="panneau-corps">
          <p className="text-secondary">{t.intro}</p>

          {configured ? (
            <SignInForm redirectTo={suite ?? '/'} locale={locale} />
          ) : (
            <div className="mt-5 border border-line-strong bg-surface-sunken p-4 text-sm">
              <p className="font-medium text-primary">{t.notConfiguredTitle}</p>
              <p className="mt-2 text-secondary">
                {t.setupCopy} <code className="font-mono text-xs">.env.example</code>{' '}
                {t.setupTo} <code className="font-mono text-xs">.env.local</code>{' '}
                {t.setupFill}{' '}
                <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code>{' '}
                {t.setupAnd}{' '}
                <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
                {t.setupThen}{' '}
                <code className="font-mono text-xs">pnpm db:push</code>.
              </p>
            </div>
          )}
        </div>
      </section>

      <p className="mt-5 text-center text-xs text-muted">{t.footerNote}</p>
    </main>
  )
}
