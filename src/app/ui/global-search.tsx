'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

/**
 * Search, in the frame rather than on a page.
 *
 * The content of this application is a knowledge graph, which makes search the
 * primary way through it — not a destination you first have to navigate to.
 * `/` focuses it from anywhere, the way it works in every tool whose users
 * spend all day inside it.
 */
export function GlobalSearch({ locale }: { locale: Locale }) {
  const t = getDictFor(locale).shell
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true

      if (event.key === '/' && !typing) {
        event.preventDefault()
        input.current?.focus()
      }
      if (event.key === 'Escape') input.current?.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <form
      role="search"
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const value = input.current?.value.trim()
        if (value) router.push(`/recherche?q=${encodeURIComponent(value)}`)
      }}
    >
      <label htmlFor="recherche-globale" className="sr-only">
        {t.searchLabel}
      </label>
      <input
        id="recherche-globale"
        ref={input}
        type="search"
        placeholder={t.searchPlaceholder}
        className="w-full max-w-2xl !border-[3px] !py-1.5 text-sm"
      />
      <button type="submit" className="bouton !py-1 !text-sm">
        {t.searchSubmit}
      </button>
    </form>
  )
}
