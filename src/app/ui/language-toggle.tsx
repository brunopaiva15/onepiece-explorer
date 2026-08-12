'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { LOCALES, type Locale } from '@/lib/i18n/index.ts'
import { setLanguageAction } from './language-actions.ts'

/**
 * FR / EN, in the rail, for everyone — a visitor has no settings page, and a
 * bilingual site that hides its language switch behind sign-in is bilingual
 * for one person.
 *
 * The labels are deliberately not translated: « FR » names French in both
 * languages, and the control must be findable precisely when the current
 * language is the one you do not read.
 */
export function LanguageToggle({
  locale,
  label,
}: {
  locale: Locale
  label: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function choose(next: Locale) {
    if (next === locale || pending) return
    startTransition(async () => {
      await setLanguageAction(next)
      router.refresh()
    })
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-1 px-2"
    >
      {LOCALES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => choose(candidate)}
          aria-pressed={candidate === locale}
          disabled={pending}
          className={
            'rounded px-1.5 py-0.5 font-display text-[0.7rem] uppercase tracking-[0.12em] ' +
            (candidate === locale
              ? 'bg-[var(--accent)] text-[var(--ink)]'
              : 'text-white/70 hover:text-white')
          }
        >
          {candidate}
        </button>
      ))}
    </div>
  )
}
