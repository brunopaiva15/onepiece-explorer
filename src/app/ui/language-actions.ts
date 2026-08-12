'use server'

import { cookies } from 'next/headers'
import {
  DEFAULT_LOCALE,
  LANG_COOKIE,
  isLocale,
} from '@/lib/i18n/index.ts'

/**
 * Record the language choice, wherever it can be remembered.
 *
 * The cookie always: it is the only memory an anonymous visitor has, and for a
 * signed-in reader it keeps the pre-auth pages (sign-in, deployment status)
 * speaking the same language as the rest. The profile only when there is one —
 * that write is what makes the choice follow the reader to another browser.
 */
export async function setLanguageAction(value: string): Promise<void> {
  const locale = isLocale(value) ? value : DEFAULT_LOCALE

  const jar = await cookies()
  jar.set(LANG_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  try {
    const { getCurrentUser } = await import('@/domains/auth/server.ts')
    const user = await getCurrentUser()
    if (user) {
      const { persistLanguage } = await import('@/domains/auth/session.ts')
      await persistLanguage(user.id, locale)
    }
  } catch {
    // Unconfigured auth or unreachable database: the cookie already holds the
    // choice, which is everything this render needed.
  }
}
