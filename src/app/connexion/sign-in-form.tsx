'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { supabaseBrowser } from '@/domains/auth/client.ts'

type Mode = 'signin' | 'signup'

/**
 * Sign-in and sign-up.
 *
 * Errors are translated rather than passed through: Supabase returns English
 * strings whose wording changes between releases, and "Invalid login
 * credentials" is not a useful thing to show a French-speaking user.
 */
function translateError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) {
    return 'Adresse e-mail ou mot de passe incorrect.'
  }
  if (m.includes('email not confirmed')) {
    return 'Adresse e-mail non confirmée. Vérifiez votre boîte de réception.'
  }
  if (m.includes('user already registered')) {
    return 'Un compte existe déjà avec cette adresse. Connectez-vous.'
  }
  if (m.includes('password should be at least')) {
    return 'Le mot de passe doit contenir au moins 6 caractères.'
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Trop de tentatives. Patientez une minute avant de réessayer.'
  }
  if (m.includes('fetch') || m.includes('network')) {
    return 'Connexion à Supabase impossible. Vérifiez NEXT_PUBLIC_SUPABASE_URL.'
  }
  /*
   * "Invalid API key" is about the installation, not about the person typing.
   * It reaches the one screen where a visitor can do nothing with it, and reads
   * like a rejected password — so it deserves the three things it can actually
   * be, in place of a message that sends someone to reset a password that was
   * never wrong.
   */
  if (m.includes('invalid api key') || m.includes('no api key')) {
    return (
      "La clé NEXT_PUBLIC_SUPABASE_ANON_KEY n'est pas acceptée par ce projet. " +
      "Trois causes : elle vient d'un autre projet que NEXT_PUBLIC_SUPABASE_URL, " +
      'elle a été tronquée au collage (une clé JWT fait plus de 200 caractères, ' +
      'sur une seule ligne), ou les clés héritées sont désactivées dans Supabase ' +
      '— auquel cas prenez la clé « publishable ». Rien à voir avec votre mot de passe.'
    )
  }
  return message
}

export function SignInForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function submit(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setError(null)
    setNotice(null)

    const supabase = supabaseBrowser()
    const result =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    if (result.error) {
      setError(translateError(result.error.message))
      return
    }

    if (mode === 'signup' && !result.data.session) {
      setNotice(
        'Compte créé. Confirmez votre adresse e-mail, puis revenez vous connecter.',
      )
      setMode('signin')
      return
    }

    startTransition(() => {
      // Only ever a same-origin path: an attacker-supplied absolute URL in
      // ?suite= would otherwise turn the sign-in page into an open redirect.
      const safe = redirectTo.startsWith('/') && !redirectTo.startsWith('//')
        ? redirectTo
        : '/'
      router.replace(safe)
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-primary">
          Adresse e-mail
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full px-3 py-2 text-primary"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-primary"
        >
          Mot de passe
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full px-3 py-2 text-primary"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-epi-contradicted">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-epi-explicit">
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="bouton bouton-primaire w-full justify-center transition-colors hover:bg-accent-strong disabled:opacity-60"
      >
        {mode === 'signin' ? 'Se connecter' : 'Créer le compte'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin')
          setError(null)
          setNotice(null)
        }}
        className="w-full text-sm text-secondary underline underline-offset-4 hover:text-primary"
      >
        {mode === 'signin'
          ? 'Pas encore de compte ? En créer un'
          : 'Déjà un compte ? Se connecter'}
      </button>
    </form>
  )
}
